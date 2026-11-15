// 面板「设置」页的读写：走宿主 config-editor 服务（写 profile patch → Loader 热应用），
// 不自己动 YAML 文件——那样容易把 !js 表达式、注释或更高层覆盖搞坏。
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APIZ_MODEL } from './image/apiz.js'
import { getConfig, imageKeySource } from './tools.js'

// 面板可写的字段白名单（写别的字段一律拒绝，避免把插件配置当任意写入口）
const EDITABLE = ['imageApiKey', 'imageModel', 'imageQuality', 'imageTransparency', 'outputTier', 'imageUseApizCliAuth', 'requireReferenceImages', 'timeoutSeconds']
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max']
const TIERS = ['1K', '2K', '4K']

export function maskSecret(value) {
  const text = String(value ?? '')
  if (!text) return ''
  if (text.length <= 8) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}****${text.slice(-4)}`
}

function configEditor(ctx) {
  if (typeof ctx?.get !== 'function') return null
  const editor = ctx.get('configEditor')
  return editor && typeof editor.edit === 'function' ? editor : null
}

export function settingsAvailable(ctx) {
  return configEditor(ctx) !== null
}

/** 当前设置（Key 脱敏）。 */
export function readSettings(ctx) {
  const config = getConfig()
  return {
    available: settingsAvailable(ctx),
    image: {
      apiKey: maskSecret(config.imageApiKey),
      hasApiKey: Boolean(String(config.imageApiKey ?? '').trim()),
      keySource: imageKeySource(),
      model: String(config.imageModel ?? '') || DEFAULT_APIZ_MODEL,
      quality: QUALITIES.includes(String(config.imageQuality)) ? String(config.imageQuality) : 'low',
      transparency: config.imageTransparency === true,
      outputTier: TIERS.includes(String(config.outputTier)) ? String(config.outputTier) : '2K',
      useCliAuth: config.imageUseApizCliAuth === true,
      requireReferenceImages: config.requireReferenceImages !== false,
      timeoutSeconds: Number(config.timeoutSeconds ?? 600),
      cliKeyAvailable: cliKeyPresent(),
    },
    qualities: QUALITIES,
    tiers: TIERS,
    defaultModel: DEFAULT_APIZ_MODEL,
  }
}

function cliKeyPresent() {
  // 只探测文件是否存在，不读取也不返回 Key 内容
  const override = String(process.env.APIZ_CONFIG ?? '').trim()
  return existsSync(override || join(homedir(), '.config', 'apiz', 'config.toml'))
}

function pick(patch) {
  const next = {}
  for (const key of EDITABLE) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (key === 'imageApiKey') {
      if (typeof value !== 'string') throw new Error('imageApiKey 必须是字符串')
      if (value.trim()) next[key] = value.trim()
      else next[key] = '' // 空串 = 清空
      continue
    }
    if (key === 'imageModel') {
      if (typeof value !== 'string') throw new Error('imageModel 必须是字符串')
      next[key] = value.trim()
      continue
    }
    if (key === 'imageQuality') {
      const quality = String(value).trim().toLowerCase()
      if (!QUALITIES.includes(quality)) throw new Error(`imageQuality 只能是 ${QUALITIES.join(' / ')}`)
      next[key] = quality
      continue
    }
    if (key === 'outputTier') {
      const tier = String(value).trim().toUpperCase()
      if (!TIERS.includes(tier)) throw new Error(`outputTier 只能是 ${TIERS.join(' / ')}`)
      next[key] = tier
      continue
    }
    if (key === 'timeoutSeconds') {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600) throw new Error('timeoutSeconds 需在 30-3600 之间')
      next[key] = Math.round(seconds)
      continue
    }
    next[key] = value === true
  }
  if (!Object.keys(next).length) throw new Error('没有任何可保存的字段')
  return next
}

/** 保存设置：写 profile patch 并让 Loader 热应用。 */
export async function saveSettings(ctx, patch) {
  // 先校验入参（与宿主能力无关），这样报错说的是"字段不对"而不是"服务没有"
  const next = pick(patch ?? {})
  const editor = configEditor(ctx)
  if (!editor) {
    throw new Error('宿主没有 config-editor 服务（dsh 版本较老）：请在 profile 的 cordis.patch.yml 里手写 amazon-image-studio 的 config，或升级 dsh')
  }
  const entry = editor.entries().find((item) => item.options?.id === 'amazon-image-studio')
  if (!entry) throw new Error('找不到本插件的配置行（include:amazon-image-studio）：当前 profile 可能没通过 patch 寻址这一行')
  await editor.edit(entry, (current) => ({ ...current, ...next }))
  return readSettings(ctx)
}
