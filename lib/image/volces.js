// 火山方舟 Seedream 生图适配器（Node 版，移植自上游 volcengineImageApi.ts）
import { buildApiUrl, fetchImageUrlAsDataUrl, isHttpUrl, isDataUrl, normalizeBase64Image, MIME_MAP } from './shared.js'

export const DEFAULT_VOLCENGINE_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
export const DEFAULT_VOLCENGINE_MODEL = 'doubao-seedream-5-0-pro-260628'

export function isVolcengineSeedreamProModel(model) {
  return /seedream-5-0-pro/i.test(model)
}

function getVolcengineOutputFormat(format) {
  return format === 'png' ? 'png' : 'jpeg'
}

function supportsSequentialImageGeneration(profile) {
  return !isVolcengineSeedreamProModel(profile.model)
}

function getVolcengineSize(size, profile) {
  const normalizedSize = size === 'auto' ? '2048x2048' : size
  if (!isVolcengineSeedreamProModel(profile.model)) return normalizedSize

  const match = normalizedSize.match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return normalizedSize === '4K' ? '4K' : '2K'
  const maxEdge = Math.max(Number(match[1]), Number(match[2]))
  return maxEdge > 2048 ? '4K' : '2K'
}

function createRequestBody(opts, profile) {
  const n = Math.max(1, opts.params.n || 1)
  const outputFormat = getVolcengineOutputFormat(opts.params.output_format)
  const isSeedreamPro = isVolcengineSeedreamProModel(profile.model)
  const body = {
    model: profile.model,
    prompt: opts.prompt,
    size: getVolcengineSize(opts.params.size, profile),
    watermark: false,
    response_format: isSeedreamPro ? 'url' : profile.responseFormatB64Json ? 'b64_json' : 'url',
  }

  if (!isSeedreamPro) {
    body.output_format = outputFormat
  } else {
    body.stream = false
  }

  if (opts.inputImageDataUrls.length) {
    if (isSeedreamPro) {
      body.image = opts.inputImageDataUrls.length === 1 ? opts.inputImageDataUrls[0] : opts.inputImageDataUrls
    } else {
      body.image_urls = opts.inputImageDataUrls
    }
  }

  if (n > 1) {
    if (!supportsSequentialImageGeneration(profile)) {
      throw new Error('当前火山 Seedream Pro 模型不支持组图生成，请将数量设为 1 后重试。')
    }
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: n }
  }

  return body
}

async function parseImagesApiResponse(payload, requestedParams, fallbackMime) {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`火山方舟 Seedream 没有返回图片数据：${JSON.stringify(payload).slice(0, 400)}`)
  }

  const images = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts = []
  for (const item of data) {
    const b64 = item.b64_json
    if (b64) {
      images.push(normalizeBase64Image(b64, fallbackMime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      continue
    }
    if (isHttpUrl(item.url) || isDataUrl(item.url)) {
      images.push(await fetchImageUrlAsDataUrl(item.url, fallbackMime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    }
  }

  if (!images.length) throw new Error('火山方舟 Seedream 没有返回可识别的图片数据')

  return {
    images,
    actualParams: {
      size: requestedParams.size,
      output_format: getVolcengineOutputFormat(requestedParams.output_format),
      n: images.length,
    },
    revisedPrompts,
    rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined,
  }
}

export async function callVolcengineImageApi(opts, profile) {
  if (opts.maskDataUrl) throw new Error('当前火山 Seedream 接入暂不支持遮罩编辑。请移除遮罩后重试。')

  const outputFormat = getVolcengineOutputFormat(opts.params.output_format)
  const mime = MIME_MAP[outputFormat] || 'image/jpeg'
  const response = await fetch(buildApiUrl(profile.baseUrl, 'images/generations', { prefixV1: false }), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createRequestBody(opts, profile)),
    signal: AbortSignal.timeout(profile.timeoutMs ?? 600_000),
  })

  if (!response.ok) throw new Error(await opts.getApiErrorMessage(response))
  return parseImagesApiResponse(await response.json(), opts.params, mime)
}
