// OpenAI 兼容生图适配器（Node 精简版，移植自上游 openaiCompatibleImageApi.ts）
// 覆盖：/images/generations（JSON）、/images/edits（multipart 参考图）、OpenRouter chat 生图路径。
// 上游的自定义 HTTP 服务商模板、Responses image_generation 工具、SSE 流式、遮罩编辑不移植。
import { buildApiUrl, dataUrlToBlob, fetchImageUrlAsDataUrl, isDataUrl, isHttpUrl, MIME_MAP, normalizeBase64Image } from './shared.js'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'

const OPENROUTER_STANDARD_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const OPENROUTER_1K_PIXEL_BUDGET = 1_572_864
const OPENROUTER_2K_PIXEL_BUDGET = 4_194_304

export function isOpenRouterBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return false
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  try {
    const hostname = new URL(input).hostname.toLowerCase()
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')
  } catch {
    return /(^|\.)openrouter\.ai(?:[/:]|$)/i.test(raw)
  }
}

function parseImageSize(size) {
  const match = String(size ?? '').trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width, height }
}

function getOpenRouterImageConfig(size, model) {
  const dimensions = parseImageSize(size)
  if (!dimensions) return undefined

  const targetRatio = dimensions.width / dimensions.height
  const aspectRatio = OPENROUTER_STANDARD_ASPECT_RATIOS
    .map((value) => {
      const [w, h] = value.split(':').map(Number)
      return { value, distance: Math.abs(Math.log(targetRatio / (w / h))) }
    })
    .sort((a, b) => a.distance - b.distance)[0]?.value
  const pixels = dimensions.width * dimensions.height
  const imageSize = pixels <= OPENROUTER_1K_PIXEL_BUDGET ? '1K' : pixels <= OPENROUTER_2K_PIXEL_BUDGET ? '2K' : '4K'

  return { aspect_ratio: aspectRatio, image_size: imageSize }
}

function createOpenRouterChatBody(opts, profile) {
  const content = opts.inputImageDataUrls.length
    ? [
      { type: 'text', text: opts.prompt },
      ...opts.inputImageDataUrls.map((dataUrl) => ({ type: 'image_url', image_url: { url: dataUrl } })),
    ]
    : opts.prompt
  const body = {
    model: profile.model,
    messages: [{ role: 'user', content }],
    modalities: ['image', 'text'],
    stream: false,
  }
  const imageConfig = getOpenRouterImageConfig(opts.params.size, profile.model)
  if (imageConfig) body.image_config = imageConfig
  return body
}

async function parseOpenRouterChatImageResponse(payload, mime) {
  const imageUrls = (payload.choices ?? [])
    .flatMap((choice) => choice.message?.images ?? [])
    .map((image) => image?.image_url?.url ?? image?.imageUrl?.url)
    .filter((value) => isHttpUrl(value) || isDataUrl(value))

  if (!imageUrls.length) {
    throw new Error('OpenRouter 没有返回图片数据。请确认模型支持图片输出（modalities 含 image）。')
  }

  const images = await Promise.all(imageUrls.map((url) => fetchImageUrlAsDataUrl(url, mime)))
  return { images }
}

function createGenerationsBody(opts, profile) {
  const body = {
    model: profile.model,
    prompt: opts.prompt,
    size: opts.params.size,
    n: Math.max(1, opts.params.n || 1),
  }
  if (opts.params.quality && opts.params.quality !== 'auto') body.quality = opts.params.quality
  if (opts.params.output_format && opts.params.output_format !== 'png') body.output_format = opts.params.output_format
  if (opts.responseFormatB64Json) body.response_format = 'b64_json'
  return body
}

async function parseImagesApiResponse(payload, fallbackMime) {
  const data = payload?.data
  if (!Array.isArray(data) || !data.length) {
    throw new Error(`接口没有返回图片数据：${JSON.stringify(payload).slice(0, 400)}`)
  }

  const images = []
  const rawImageUrls = []
  for (const item of data) {
    if (item?.b64_json) {
      images.push(normalizeBase64Image(item.b64_json, fallbackMime))
    } else if (isHttpUrl(item?.url) || isDataUrl(item?.url)) {
      rawImageUrls.push(item.url)
      images.push(await fetchImageUrlAsDataUrl(item.url, fallbackMime))
    }
  }
  if (!images.length) throw new Error('接口没有返回可识别的图片数据')
  return { images, rawImageUrls: rawImageUrls.length ? rawImageUrls : undefined }
}

/** /images/edits：参考图走 multipart 文件（gpt-image 系列的图生图路径）。 */
async function callImagesEdits(opts, profile, responseFormat) {
  const outputFormat = opts.params.output_format === 'png' ? 'png' : 'jpeg'
  const form = new FormData()
  form.append('model', profile.model)
  form.append('prompt', opts.prompt)
  if (opts.params.size && opts.params.size !== 'auto') form.append('size', opts.params.size)
  if (opts.params.quality && opts.params.quality !== 'auto') form.append('quality', opts.params.quality)
  if (outputFormat !== 'png') form.append('output_format', outputFormat)
  if (responseFormat) form.append('response_format', 'b64_json')
  if (opts.params.n > 1) form.append('n', String(Math.trunc(opts.params.n)))

  opts.inputImageDataUrls.forEach((dataUrl, index) => {
    const blob = dataUrlToBlob(dataUrl)
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg'
    form.append('image[]', blob, `reference-${index + 1}.${ext}`)
  })

  const response = await fetch(buildApiUrl(profile.baseUrl, 'images/edits'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${profile.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(profile.timeoutMs ?? 600_000),
  })
  if (!response.ok) throw new Error(await opts.getApiErrorMessage(response))
  return parseImagesApiResponse(await response.json(), MIME_MAP[outputFormat])
}

export async function callOpenAICompatibleImageApi(opts, profile) {
  if (isOpenRouterBaseUrl(profile.baseUrl)) {
    const response = await fetch(buildApiUrl('https://openrouter.ai/api/v1', 'chat/completions', { prefixV1: false }), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${profile.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createOpenRouterChatBody(opts, profile)),
      signal: AbortSignal.timeout(profile.timeoutMs ?? 600_000),
    })
    if (!response.ok) throw new Error(await opts.getApiErrorMessage(response))
    return parseOpenRouterChatImageResponse(await response.json(), MIME_MAP[opts.params.output_format] ?? 'image/png')
  }

  // 有参考图 → 走 edits（multipart）；纯文生图 → generations（JSON）
  if (opts.inputImageDataUrls.length) {
    return callImagesEdits(opts, profile, Boolean(opts.responseFormatB64Json))
  }

  const outputFormat = opts.params.output_format === 'png' ? 'png' : 'jpeg'
  const response = await fetch(buildApiUrl(profile.baseUrl, 'images/generations'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(createGenerationsBody(opts, profile)),
    signal: AbortSignal.timeout(profile.timeoutMs ?? 600_000),
  })
  if (!response.ok) throw new Error(await opts.getApiErrorMessage(response))
  return parseImagesApiResponse(await response.json(), MIME_MAP[outputFormat])
}
