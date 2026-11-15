// 阿里云百炼 Qwen-Image 生图适配器（Node 版，移植自上游 aliyunQwenImageApi.ts）
import { fetchImageUrlAsDataUrl, isHttpUrl, isDataUrl, MIME_MAP } from './shared.js'

export const DEFAULT_ALIYUN_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
export const DEFAULT_ALIYUN_QWEN_MODEL = 'qwen-image-3.0-pro'

const NATIVE_GENERATION_PATH = '/services/aigc/multimodal-generation/generation'
const MAX_INPUT_IMAGES = 3
const MAX_OUTPUT_IMAGES = 6
const MIN_PIXELS = 512 * 512
const MAX_PIXELS = 2048 * 2048
const MAX_EDGE = 2048
const SIZE_MULTIPLE = 16

export function getAliyunQwenImageModel(model) {
  const trimmed = String(model ?? '').trim()
  return /^qwen-image(?:-|$)/i.test(trimmed) ? trimmed : DEFAULT_ALIYUN_QWEN_MODEL
}

export function isAliyunApiBaseUrl(value) {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return false
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const hostname = new URL(input).hostname.toLowerCase()
    return hostname === 'dashscope.aliyuncs.com' ||
      hostname === 'dashscope-intl.aliyuncs.com' ||
      hostname === 'dashscope.aliyun.com' ||
      hostname === 'dashscope-intl.aliyun.com' ||
      hostname.endsWith('.maas.aliyuncs.com') ||
      hostname.endsWith('.maas.aliyun.com')
  } catch {
    return false
  }
}

/** 常见 DashScope/MaaS URL → 原生多模态生图端点。 */
export function createAliyunQwenImageEndpoint(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim()
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed
  try { parsed = new URL(input) } catch { return `${trimmed.replace(/\/+$/, '')}/api/v1${NATIVE_GENERATION_PATH}` }

  const pathname = parsed.pathname.replace(/\/+$/, '')
  const lowerPath = pathname.toLowerCase()
  const nativePathIndex = lowerPath.indexOf(NATIVE_GENERATION_PATH)
  if (nativePathIndex >= 0) {
    return `${parsed.origin}${pathname.slice(0, nativePathIndex + NATIVE_GENERATION_PATH.length)}`
  }
  if (/\/compatible-mode\/v1$/i.test(pathname)) return `${parsed.origin}/api/v1${NATIVE_GENERATION_PATH}`
  if (/\/api\/v1$/i.test(pathname)) return `${parsed.origin}${pathname}${NATIVE_GENERATION_PATH}`
  if (/\/v1$/i.test(pathname)) return `${parsed.origin}${pathname.replace(/\/v1$/i, '/api/v1')}${NATIVE_GENERATION_PATH}`

  const prefix = pathname && pathname !== '/' ? pathname : ''
  return `${parsed.origin}${prefix}/api/v1${NATIVE_GENERATION_PATH}`
}

function roundToMultiple(value, mode = 'floor') {
  const rounded = mode === 'ceil'
    ? Math.ceil(value / SIZE_MULTIPLE) * SIZE_MULTIPLE
    : Math.floor(value / SIZE_MULTIPLE) * SIZE_MULTIPLE
  return Math.max(SIZE_MULTIPLE, rounded)
}

/** Qwen-Image 接受 512²–2048² 像素，width*height 语法。 */
export function normalizeAliyunQwenImageSize(size) {
  const trimmed = size.trim()
  if (!trimmed || trimmed === 'auto') return 'auto'

  const match = trimmed.match(/^(\d+)\s*[xX×*]\s*(\d+)$/)
  if (!match) return trimmed

  let width = Number(match[1])
  let height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'auto'

  const scaleDown = (scale) => {
    width = roundToMultiple(width * scale, 'floor')
    height = roundToMultiple(height * scale, 'floor')
  }
  const scaleUp = (scale) => {
    width = roundToMultiple(width * scale, 'ceil')
    height = roundToMultiple(height * scale, 'ceil')
  }

  for (let i = 0; i < 4; i++) {
    const maxEdge = Math.max(width, height)
    if (maxEdge > MAX_EDGE) scaleDown(MAX_EDGE / maxEdge)

    const pixels = width * height
    if (pixels > MAX_PIXELS) scaleDown(Math.sqrt(MAX_PIXELS / pixels))
    else if (pixels < MIN_PIXELS) scaleUp(Math.sqrt(MIN_PIXELS / pixels))
  }

  width = Math.min(MAX_EDGE, roundToMultiple(width))
  height = Math.min(MAX_EDGE, roundToMultiple(height))
  if (width * height > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (width * height))
    width = Math.min(MAX_EDGE, roundToMultiple(width * scale))
    height = Math.min(MAX_EDGE, roundToMultiple(height * scale))
  }

  return `${width}*${height}`
}

function createAliyunQwenImageRequestBody(opts, profile) {
  const n = Math.min(MAX_OUTPUT_IMAGES, Math.max(1, Math.trunc(opts.params.n || 1)))
  const content = [
    ...opts.inputImageDataUrls.map((image) => ({ image })),
    { text: opts.prompt },
  ]
  const parameters = { prompt_extend: true, n, watermark: false }
  const size = normalizeAliyunQwenImageSize(opts.params.size)
  if (size !== 'auto') parameters.size = size

  return {
    model: getAliyunQwenImageModel(profile.model),
    input: { messages: [{ role: 'user', content }] },
    parameters,
  }
}

function getResultImageUrls(payload) {
  const choices = payload?.output?.choices
  if (!Array.isArray(choices)) return []
  return choices.flatMap((choice) => {
    const content = choice?.message?.content
    if (!Array.isArray(content)) return []
    return content
      .map((item) => item?.image)
      .filter((value) => typeof value === 'string' && (isHttpUrl(value) || isDataUrl(value)))
  })
}

function getActualOutputSize(payload, requestedSize) {
  const width = Number(payload?.usage?.output_width)
  const height = Number(payload?.usage?.output_height)
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return `${Math.round(width)}x${Math.round(height)}`
  }
  return requestedSize && requestedSize !== 'auto' ? requestedSize : undefined
}

export async function parseAliyunQwenImageResponse(payload, requestedParams) {
  const imageUrls = getResultImageUrls(payload)
  const rawImageUrls = imageUrls.filter(isHttpUrl)
  if (!imageUrls.length) {
    throw new Error(`阿里云 Qwen-Image 没有返回可识别的图片数据：${JSON.stringify(payload).slice(0, 400)}`)
  }

  const images = []
  for (const imageUrl of imageUrls) {
    images.push(await fetchImageUrlAsDataUrl(imageUrl, MIME_MAP.png))
  }

  return {
    images,
    actualParams: {
      size: getActualOutputSize(payload, requestedParams.size),
      output_format: 'png',
      n: images.length,
    },
    rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined,
  }
}

export async function callAliyunQwenImageApi(opts, profile) {
  if (opts.maskDataUrl) throw new Error('阿里云 Qwen-Image 原生接口暂不支持遮罩编辑，请移除遮罩后使用参考图编辑。')
  if (opts.inputImageDataUrls.length > MAX_INPUT_IMAGES) {
    throw new Error(`阿里云 Qwen-Image 最多支持 ${MAX_INPUT_IMAGES} 张参考图，请删除多余图片后重试。`)
  }
  const requestedN = Math.max(1, Math.trunc(opts.params.n || 1))
  if (requestedN > MAX_OUTPUT_IMAGES) {
    throw new Error(`阿里云 Qwen-Image 最多支持 ${MAX_OUTPUT_IMAGES} 张输出图片，请减少数量后重试。`)
  }

  const response = await fetch(createAliyunQwenImageEndpoint(profile.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createAliyunQwenImageRequestBody(opts, profile)),
    signal: AbortSignal.timeout(profile.timeoutMs ?? 600_000),
  })

  if (!response.ok) throw new Error(await opts.getApiErrorMessage(response))
  return parseAliyunQwenImageResponse(await response.json(), opts.params)
}
