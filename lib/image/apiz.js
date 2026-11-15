// apiz 异步生图适配器（GPT Image 2.5 Flare）：POST /api/v3/tasks/create → 轮询 /api/v3/tasks/query → 下载结果。
//
// 与 volces / openai / aliyun 三个同步适配器的差别：
//   1. 异步任务制：create 立刻返回 task_id（已预扣积分），结果要轮询 query 取；
//      轮询超时**不能重新提交**——那样会重复计费，只能拿 task_id 去 apiz tasks get 取。
//   2. 尺寸是「10 种比例 × 1K/2K/4K」或「离散枚举的 width/height」，不是任意像素；
//      所以插件算出来的 3184x1312 这种目标尺寸要就近吸附到枚举值（见 resolveApizSize）。
//   3. 参考图只收公网 HTTP(S) URL（4 个上游参数名里它只认 reference_image_urls）；
//      插件内部是 data URL，所以要先传到 apiz CDN 换公网 URL（见 apizUpload.js）。
import { assertImageInputPayloadSize, fetchImageUrlAsDataUrl, getDataUrlEncodedByteSize, isDataUrl, isHttpUrl, MIME_MAP } from './shared.js'
import { uploadDataUrlToApiz } from './apizUpload.js'

export const DEFAULT_APIZ_BASE_URL = 'https://api.apiz.ai'
export const DEFAULT_APIZ_MODEL = 'apiz/gpt-image-2.5-flare'
export const DEFAULT_APIZ_QUALITY = 'low'

/** 质量档位（大小写不敏感；档位越高越贵，与分辨率无关）。 */
export const APIZ_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max']
/** 比例白名单（apiz 的 10 种固定比例，另有 auto 交给上游推断）。 */
export const APIZ_ASPECT_RATIOS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16']
/** 自定义 width 的完整枚举（33 个）。 */
export const APIZ_WIDTHS = [
  768, 832, 848, 864, 896, 928, 1024, 1088, 1136, 1152, 1184, 1200, 1248, 1264, 1344,
  1376, 1536, 1584, 1648, 1696, 1792, 1856, 2016, 2048, 2336, 2448, 2560, 2880, 3200, 3264,
  3504, 3584, 3808,
]
/** 自定义 height 的完整枚举（37 个）。 */
export const APIZ_HEIGHTS = [
  640, 672, 768, 832, 848, 864, 896, 928, 1024, 1136, 1152, 1184, 1200, 1248, 1264, 1280, 1344,
  1376, 1536, 1584, 1632, 1648, 1696, 1792, 1824, 1856, 1920, 2016, 2048, 2336, 2448, 2560, 2880,
  3200, 3264, 3504, 3584,
]
export const APIZ_MAX_REFERENCE_IMAGES = 16
export const APIZ_MAX_PROMPT_CHARS = 7000
export const APIZ_SIZE_TIERS = ['1K', '2K', '4K']

// 官方约束（超出时 apiz 会自行就近转换；我们本地先算好，好在日志/历史里写真实尺寸）
const MAX_EDGE = 3840
const MAX_ASPECT_RATIO = 3
const MIN_PIXELS = 655_360
const MAX_PIXELS = 8_294_400

const TERMINAL_OK = new Set(['completed', 'complete', 'success', 'succeeded', 'done'])
const TERMINAL_FAIL = new Set(['failed', 'fail', 'error', 'cancelled', 'canceled', 'timeout', 'expired'])

function parseSize(value) {
  const match = String(value ?? '').trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

/** 就近吸附到离散枚举（等距取小值，避免多算像素）。 */
export function snapToEnum(list, value) {
  let best = list[0]
  let bestDistance = Infinity
  for (const candidate of list) {
    const distance = Math.abs(candidate - value)
    if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** 比例落点：按对数距离取最接近的固定比例。 */
export function nearestAspectRatio(width, height) {
  const target = Math.log(width / height)
  let best = '1:1'
  let bestDistance = Infinity
  for (const value of APIZ_ASPECT_RATIOS) {
    const [w, h] = value.split(':').map(Number)
    const distance = Math.abs(Math.log(w / h) - target)
    if (distance < bestDistance) {
      best = value
      bestDistance = distance
    }
  }
  return best
}

/** 像素数 → 1K/2K/4K 档位（与插件 planner/size.js 的档位预算一致）。 */
export function tierFromPixels(pixels) {
  if (pixels <= 1_572_864) return '1K'
  if (pixels <= 4_194_304) return '2K'
  return '4K'
}

function clampPosition(list, value) {
  return Math.min(list.length - 1, Math.max(0, list.indexOf(value)))
}

/**
 * 在 apiz 的 width/height 枚举里挑一对：比例最接近目标，其次像素数最接近目标。
 * 两遍筛选：先圈出比例误差 ≤2% 的候选（没有就取误差最小的那档），
 * 再挑像素数最接近目标的那对——避免为了比例把 1.4M 的目标撑到 8M（那是白花钱）。
 * 返回 null 表示目标比例太极端（例如 6:1），调用方应退回「比例 + 档位」。
 */
export function bestApizSizePair(targetWidth, targetHeight) {
  const targetRatio = targetWidth / targetHeight
  const targetPixels = targetWidth * targetHeight
  const candidates = []
  for (const width of APIZ_WIDTHS) {
    for (const height of APIZ_HEIGHTS) {
      const pixels = width * height
      if (pixels < MIN_PIXELS || pixels > MAX_PIXELS) continue
      if (Math.max(width, height) > MAX_EDGE) continue
      const ratio = width / height
      if (ratio > MAX_ASPECT_RATIO || ratio < 1 / MAX_ASPECT_RATIO) continue
      candidates.push({ width, height, pixels, ratioError: Math.abs(Math.log(ratio / targetRatio)) })
    }
  }
  if (!candidates.length) return null

  const minError = Math.min(...candidates.map((item) => item.ratioError))
  if (minError > Math.log(1.05)) return null
  const window = candidates.filter((item) => item.ratioError <= Math.max(Math.log(1.02), minError))
  let best = window[0]
  let bestPixelError = Math.abs(Math.log(best.pixels / targetPixels))
  for (const item of window.slice(1)) {
    const pixelError = Math.abs(Math.log(item.pixels / targetPixels))
    if (pixelError < bestPixelError) {
      best = item
      bestPixelError = pixelError
    }
  }
  return { width: best.width, height: best.height }
}

/**
 * 目标像素尺寸 → apiz 的尺寸参数。
 * 优先用 width/height（保住插件按槽位比例算出来的尺寸，文字更清晰）；
 * 目标比例超出 apiz 的 3:1 约束时，退回 aspect_ratio + size 档位。
 * 返回 { width, height } | { aspect_ratio, size }。
 */
export function resolveApizSize(size) {
  const parsed = parseSize(size)
  if (!parsed) {
    const tier = String(size ?? '').trim().toUpperCase()
    return { aspect_ratio: '1:1', size: APIZ_SIZE_TIERS.includes(tier) ? tier : '2K' }
  }

  let { width, height } = parsed
  const targetPixels = width * height
  // 目标本身先夹进官方约束，再找最近的枚举对
  if (Math.max(width, height) > MAX_EDGE) {
    const scale = MAX_EDGE / Math.max(width, height)
    width *= scale
    height *= scale
  }
  const pair = bestApizSizePair(width, height)
  if (pair) return pair
  return { aspect_ratio: nearestAspectRatio(parsed.width, parsed.height), size: tierFromPixels(targetPixels) }
}

/** 质量归一化：兼容 OpenAI 的 standard/hd 写法，未知值回落默认档。 */
export function normalizeApizQuality(value, fallback = DEFAULT_APIZ_QUALITY) {
  const text = String(value ?? '').trim().toLowerCase()
  if (APIZ_QUALITIES.includes(text)) return text
  if (text === 'standard' || text === 'sd') return 'medium'
  if (text === 'hd') return 'high'
  if (text === 'ultra' || text === 'best') return 'max'
  return APIZ_QUALITIES.includes(fallback) ? fallback : DEFAULT_APIZ_QUALITY
}

/** 提示词裁剪：超长直接截断（7000 字符硬上限），并回一条警告。 */
export function clampApizPrompt(prompt) {
  const text = String(prompt ?? '').trim()
  if (!text) throw new Error('apiz 生图需要非空 prompt')
  if (text.length <= APIZ_MAX_PROMPT_CHARS) return { prompt: text, warnings: [] }
  return {
    prompt: text.slice(0, APIZ_MAX_PROMPT_CHARS),
    warnings: [`Prompt ${text.length} 字符超过 apiz 上限 ${APIZ_MAX_PROMPT_CHARS}，已截断（末尾的风格/分辨率守卫可能被切掉，建议精简 prompt）`],
  }
}

export function buildApizCreateBody(opts, profile, referenceUrls = []) {
  const { prompt, warnings } = clampApizPrompt(opts.prompt)
  const params = { prompt, quality: normalizeApizQuality(opts.params?.quality, profile.quality) }
  const sizeSpec = resolveApizSize(opts.params?.size)
  if (sizeSpec.width) {
    params.width = sizeSpec.width
    params.height = sizeSpec.height
  } else {
    params.aspect_ratio = sizeSpec.aspect_ratio
    params.size = sizeSpec.size
  }
  if (profile.transparency === true) params.transparency = true
  if (referenceUrls.length) params.reference_image_urls = referenceUrls.slice(0, APIZ_MAX_REFERENCE_IMAGES)
  return { body: { model: String(profile.model ?? '').trim() || DEFAULT_APIZ_MODEL, params }, warnings }
}

function apizUrl(baseUrl, path) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_APIZ_BASE_URL
  return `${base}${path}`
}

async function postJson(url, apiKey, body, timeoutMs, getApiErrorMessage) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  return response.json()
}

function taskData(payload) {
  const data = payload?.data ?? payload
  if (!data || typeof data !== 'object') throw new Error(`apiz 返回了无法识别的任务体：${JSON.stringify(payload).slice(0, 400)}`)
  return data
}

function collectImageUrls(data) {
  const buckets = [data?.result?.images, data?.output?.images, data?.images, data?.result?.output?.images]
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) continue
    const urls = bucket
      .map((item) => (typeof item === 'string' ? item : item?.url ?? item?.image_url))
      .filter((url) => isHttpUrl(url) || isDataUrl(url))
    if (urls.length) return urls
  }
  return []
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询任务直到终态。**超时不重投**（重投会重复扣费）。 */
export async function waitForApizTask(taskId, profile, getApiErrorMessage) {
  const queryUrl = apizUrl(profile.baseUrl, '/api/v3/tasks/query')
  const timeoutMs = profile.timeoutMs ?? 600_000
  const deadline = Date.now() + timeoutMs
  let interval = Math.max(500, profile.pollIntervalMs ?? 2000)
  let last = null
  while (Date.now() < deadline) {
    const payload = await postJson(queryUrl, profile.apiKey, { task_id: taskId }, Math.max(30_000, Math.min(120_000, timeoutMs)), getApiErrorMessage)
    const data = taskData(payload)
    const status = String(data.status ?? '').toLowerCase()
    last = data
    if (TERMINAL_OK.has(status)) return data
    if (TERMINAL_FAIL.has(status)) {
      const detail = data.error ?? data.detail ?? data.message ?? JSON.stringify(data).slice(0, 400)
      throw new Error(`apiz 任务失败（status=${status}）：${typeof detail === 'string' ? detail : JSON.stringify(detail)}（task_id=${taskId}，失败任务整笔退还）`)
    }
    await sleep(interval)
    interval = Math.min(Math.round(interval * 1.25), 5000)
  }
  throw new Error(
    `apiz 任务轮询超时（${Math.round(timeoutMs / 1000)} 秒，task_id=${taskId}）。` +
    `任务可能仍在进行且已预扣积分：**不要重新提交**，稍后用 \`apiz tasks get ${taskId}\` 取结果，或调大插件设置里的 timeoutSeconds。` +
    (last ? `最后状态：${String(last.status ?? 'unknown')}` : ''),
  )
}

/** 参考图：http(s) 直接透传；data URL 传到 apiz CDN 换公网 URL。**顺序必须原样保留**——
 *  Prompt 里的风格守卫写的是「最后一张输入图是隐藏风格板」，重排会让风格板跑到前面去。 */
export async function resolveApizReferenceUrls(inputImageDataUrls, options = {}) {
  const list = Array.isArray(inputImageDataUrls) ? inputImageDataUrls.filter(Boolean) : []
  if (!list.length) return []
  assertImageInputPayloadSize(list.reduce((sum, item) => sum + getDataUrlEncodedByteSize(item), 0))

  const urls = []
  for (const item of list) {
    if (urls.length >= APIZ_MAX_REFERENCE_IMAGES) break
    if (isHttpUrl(item)) urls.push(String(item))
    else if (isDataUrl(item)) urls.push(await uploadDataUrlToApiz(item, options))
    else throw new Error('参考图只接受 http(s) URL 或 data URL')
  }
  // 同一张图重复出现只留最后一次：风格板撞上产品图时不会重复计费，
  // 也不会把"风格板固定最后一张"的顺序打乱。
  const lastAt = new Map()
  urls.forEach((url, index) => lastAt.set(url, index))
  return urls.filter((url, index) => lastAt.get(url) === index)
}

export async function callApizImageApi(opts, profile) {
  const apiKey = String(profile.apiKey ?? '').trim()
  if (!apiKey) {
    throw new Error('apiz 生图需要 API Key：插件设置填 imageApiKey，或设置环境变量 APIZ_API_KEY，或先跑 `apiz auth login`（本机已登录时插件会复用登录态）')
  }
  if ((opts.params?.n ?? 1) > 1) {
    throw new Error('apiz 一次只出一张图（没有 n 参数）：请把数量设为 1，多次调用取代组图')
  }
  if (opts.maskDataUrl) throw new Error('apiz 接入暂不支持遮罩编辑')

  const referenceUrls = await resolveApizReferenceUrls(opts.inputImageDataUrls ?? [], profile.uploadOptions)
  const { body, warnings } = buildApizCreateBody(opts, profile, referenceUrls)
  if (profile.transparency === true && /white background|纯白背景|on a white background/i.test(body.params.prompt)) {
    warnings.push('开了透明背景但 prompt 里还写着白色背景：apiz 建议透明图不要描述背景，否则边缘会带白边')
  }

  const created = await postJson(
    apizUrl(profile.baseUrl, '/api/v3/tasks/create'),
    apiKey,
    body,
    Math.max(30_000, Math.min(120_000, profile.timeoutMs ?? 600_000)),
    opts.getApiErrorMessage,
  )
  const task = taskData(created)
  const taskId = String(task.task_id ?? task.id ?? '')
  if (!taskId) throw new Error(`apiz 没有返回 task_id：${JSON.stringify(created).slice(0, 400)}`)

  const finished = await waitForApizTask(taskId, profile, opts.getApiErrorMessage)
  const urls = collectImageUrls(finished)
  if (!urls.length) {
    throw new Error(`apiz 任务完成但没有图片 URL（task_id=${taskId}）：${JSON.stringify(finished.result ?? finished.output ?? finished).slice(0, 400)}`)
  }

  const mime = profile.transparency === true ? 'image/png' : (MIME_MAP[opts.params?.output_format] ?? 'image/png')
  const images = []
  for (const url of urls) images.push(await fetchImageUrlAsDataUrl(url, mime))
  if (!images.length) throw new Error('apiz 结果下载失败')

  const sizeSpec = resolveApizSize(opts.params?.size)
  return {
    images,
    actualParams: {
      size: sizeSpec.width ? `${sizeSpec.width}x${sizeSpec.height}` : `${sizeSpec.aspect_ratio}@${sizeSpec.size}`,
      quality: body.params.quality,
      transparency: body.params.transparency === true,
      n: images.length,
    },
    rawImageUrls: urls,
    providerTaskId: taskId,
    price: typeof task.price === 'number' ? task.price : null,
    warnings,
  }
}
