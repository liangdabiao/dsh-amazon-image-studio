// 生图适配器共享工具（Node 版）
export const MIME_MAP = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

export const MAX_IMAGE_INPUT_BYTES = 512 * 1024 * 1024

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value) {
  return typeof value === 'string' && /^data:image\//i.test(value)
}

/** data URL 的 base64 部分字节数。 */
export function getDataUrlEncodedByteSize(dataUrl) {
  if (typeof dataUrl !== 'string') return 0
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return 0
  const base64 = dataUrl.slice(commaIndex + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding)
}

export function normalizeBase64Image(b64, fallbackMime = 'image/png') {
  const value = String(b64 ?? '').trim()
  if (!value) throw new Error('接口返回了空的图片数据')
  if (isDataUrl(value)) return value
  return `data:${fallbackMime};base64,${value.replace(/^base64,/, '')}`
}

export function assertImageInputPayloadSize(totalBytes) {
  if (totalBytes > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`参考图总负载 ${(totalBytes / 1024 / 1024).toFixed(1)} MB 超过上限，请减少或压缩参考图`)
  }
}

export async function fetchImageUrlAsDataUrl(url, fallbackMime = 'image/png') {
  if (isDataUrl(url)) return url
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const mime = contentType.startsWith('image/') ? contentType.split(';')[0] : fallbackMime
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/** 拼接 API URL：baseUrl 去尾斜杠；path 除非 pathPrefix=false，否则在缺 /v1 时补 /v1。 */
export function buildApiUrl(baseUrl, path, { prefixV1 = true } = {}) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!prefixV1 || /\/v\d+$/.test(base)) return `${base}/${path}`
  return `${base}/v1/${path}`
}

export function dataUrlToBuffer(dataUrl) {
  const commaIndex = dataUrl.indexOf(',')
  return Buffer.from(dataUrl.slice(commaIndex + 1), 'base64')
}

export function dataUrlToBlob(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?,/)
  return new Blob([dataUrlToBuffer(dataUrl)], { type: match?.[1] ?? 'application/octet-stream' })
}
