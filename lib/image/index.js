// 生图适配器分发 + 统一错误信息读取
import { DEFAULT_APIZ_BASE_URL, DEFAULT_APIZ_MODEL, callApizImageApi } from './apiz.js'
import { callAliyunQwenImageApi, isAliyunApiBaseUrl } from './aliyun.js'
import { callOpenAICompatibleImageApi, isOpenRouterBaseUrl } from './openai.js'
import { assertImageInputPayloadSize, getDataUrlEncodedByteSize } from './shared.js'
import { callVolcengineImageApi, DEFAULT_VOLCENGINE_BASE_URL, DEFAULT_VOLCENGINE_MODEL } from './volces.js'

export { DEFAULT_VOLCENGINE_BASE_URL, DEFAULT_VOLCENGINE_MODEL, DEFAULT_APIZ_BASE_URL, DEFAULT_APIZ_MODEL }

export const IMAGE_PROVIDERS = ['apiz', 'volces', 'openai', 'aliyun']

export function normalizeImageProvider(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (IMAGE_PROVIDERS.includes(text)) return text
  if (text === 'apiz.ai' || text === 'gpt-image') return 'apiz'
  if (text === 'ark' || text === 'volcengine' || text === 'doubao' || text === 'seedream') return 'volces'
  if (text === 'dashscope' || text === 'qwen') return 'aliyun'
  return 'apiz'
}

export async function getApiErrorMessage(response) {
  try {
    const raw = await response.text()
    if (!raw.trim()) return `HTTP ${response.status}`
    try {
      const payload = JSON.parse(raw)
      // apiz 的报错是 { detail: "…" }，其余服务商是 error.message / message / msg
      const message = payload?.detail ?? payload?.error?.message ?? payload?.error?.code ?? payload?.message ?? payload?.msg
      if (typeof message === 'string' && message.trim()) return message.trim()
      if (Array.isArray(message) && message.length) {
        const joined = message.map((item) => (typeof item === 'string' ? item : item?.msg ?? JSON.stringify(item))).join('；')
        if (joined.trim()) return joined.trim()
      }
      if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim()
    } catch { /* 非 JSON 错误体 */ }
    return raw.trim().slice(0, 1200)
  } catch {
    return `HTTP ${response.status}`
  }
}

/**
 * 统一生图入口。
 * config: {
 *   provider: 'apiz'|'volces'|'openai'|'aliyun', apiBaseUrl, apiKey, model,
 *   quality, transparency, timeoutMs, pollIntervalMs, responseFormatB64Json, apizBin,
 * }
 * opts: { prompt, size, outputFormat, n, inputImageDataUrls, quality, getApiErrorMessage }
 * 返回 { images, actualParams, revisedPrompts?, rawImageUrls?, providerTaskId?, price?, warnings? }
 */
export async function generateImage(opts, config) {
  const provider = normalizeImageProvider(config.provider)
  const defaults = provider === 'apiz'
    ? { baseUrl: DEFAULT_APIZ_BASE_URL, model: DEFAULT_APIZ_MODEL }
    : provider === 'openai'
      ? { baseUrl: 'https://api.openai.com/v1', model: '' }
      : provider === 'aliyun'
        ? { baseUrl: '', model: '' }
        : { baseUrl: DEFAULT_VOLCENGINE_BASE_URL, model: DEFAULT_VOLCENGINE_MODEL }
  const profile = {
    baseUrl: String(config.apiBaseUrl ?? '').trim() || defaults.baseUrl,
    apiKey: String(config.apiKey ?? ''),
    model: String(config.model ?? '').trim() || defaults.model,
    timeoutMs: config.timeoutMs ?? 600_000,
    pollIntervalMs: config.pollIntervalMs,
    quality: config.quality,
    transparency: config.transparency === true,
    responseFormatB64Json: config.responseFormatB64Json === true,
    uploadOptions: { bin: config.apizBin, timeoutMs: 120_000, uploader: config.uploader },
  }

  // 阿里云地址自动识别：openai 配置指向 DashScope 时切原生协议（上游同款行为）
  const effectiveProvider = provider === 'openai' && isAliyunApiBaseUrl(profile.baseUrl) ? 'aliyun' : provider

  // apiz 的参考图要走 CDN 上传，体积由上传侧自己校验；其余同步接口按 data URL 总负载限制
  if (effectiveProvider !== 'apiz') {
    assertImageInputPayloadSize(
      (opts.inputImageDataUrls ?? []).reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0),
    )
  }

  const callOpts = {
    prompt: opts.prompt,
    params: {
      size: opts.size || '2048x2048',
      quality: opts.quality ?? config.quality ?? 'auto',
      output_format: opts.outputFormat ?? 'png',
      n: opts.n ?? 1,
    },
    inputImageDataUrls: opts.inputImageDataUrls ?? [],
    maskDataUrl: undefined,
    getApiErrorMessage,
  }

  if (effectiveProvider === 'apiz') return callApizImageApi(callOpts, profile)
  if (effectiveProvider === 'volces') return callVolcengineImageApi(callOpts, profile)
  if (effectiveProvider === 'aliyun') return callAliyunQwenImageApi(callOpts, profile)
  return callOpenAICompatibleImageApi(callOpts, profile)
}

export { isOpenRouterBaseUrl }
