// 生图适配器分发 + 统一错误信息读取
import { callAliyunQwenImageApi, isAliyunApiBaseUrl } from './aliyun.js'
import { callOpenAICompatibleImageApi, isOpenRouterBaseUrl } from './openai.js'
import { assertImageInputPayloadSize, getDataUrlEncodedByteSize } from './shared.js'
import { callVolcengineImageApi, DEFAULT_VOLCENGINE_BASE_URL, DEFAULT_VOLCENGINE_MODEL } from './volces.js'

export { DEFAULT_VOLCENGINE_BASE_URL, DEFAULT_VOLCENGINE_MODEL }

export async function getApiErrorMessage(response) {
  try {
    const raw = await response.text()
    if (!raw.trim()) return `HTTP ${response.status}`
    try {
      const payload = JSON.parse(raw)
      const message = payload?.error?.message ?? payload?.error?.code ?? payload?.message ?? payload?.msg
      if (typeof message === 'string' && message.trim()) return message.trim()
      if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim()
    } catch { /* 非 JSON 错误体 */ }
    return raw.trim().slice(0, 1200)
  } catch {
    return `HTTP ${response.status}`
  }
}

/**
 * 统一生图入口。
 * config: { provider: 'volces'|'openai'|'aliyun', apiBaseUrl, apiKey, model, timeoutMs, responseFormatB64Json }
 * opts: { prompt, size, outputFormat, n, inputImageDataUrls, getApiErrorMessage }
 * 返回 { images, actualParams, revisedPrompts?, rawImageUrls? }
 */
export async function generateImage(opts, config) {
  const provider = config.provider === 'openai' || config.provider === 'aliyun' ? config.provider : 'volces'
  const profile = {
    baseUrl: String(config.apiBaseUrl ?? '').trim() || DEFAULT_VOLCENGINE_BASE_URL,
    apiKey: String(config.apiKey ?? ''),
    model: String(config.model ?? '').trim() || DEFAULT_VOLCENGINE_MODEL,
    timeoutMs: config.timeoutMs ?? 600_000,
    responseFormatB64Json: config.responseFormatB64Json === true,
  }

  // 阿里云地址自动识别：openai 配置指向 DashScope 时切原生协议（上游同款行为）
  const effectiveProvider = provider === 'openai' && isAliyunApiBaseUrl(profile.baseUrl) ? 'aliyun' : provider

  assertImageInputPayloadSize(
    (opts.inputImageDataUrls ?? []).reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0),
  )

  const callOpts = {
    prompt: opts.prompt,
    params: {
      size: opts.size || '2048x2048',
      quality: opts.quality ?? 'auto',
      output_format: opts.outputFormat ?? 'png',
      n: opts.n ?? 1,
    },
    inputImageDataUrls: opts.inputImageDataUrls ?? [],
    maskDataUrl: undefined,
    getApiErrorMessage,
  }

  if (effectiveProvider === 'volces') return callVolcengineImageApi(callOpts, profile)
  if (effectiveProvider === 'aliyun') return callAliyunQwenImageApi(callOpts, profile)
  return callOpenAICompatibleImageApi(callOpts, profile)
}

export { isOpenRouterBaseUrl }
