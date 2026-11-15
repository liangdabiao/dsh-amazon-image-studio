// 视觉风格系统：4 内置风格预设（色卡 C1-C6 语义）+ 风格块构造
// （移植自上游 stylePresets.ts / stylePalette.ts；预设板 PNG 随包 assets/style-presets/）
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

export const STYLE_PRESETS = [
  {
    id: 'clean-tech',
    label: '清爽科技',
    description: '冷色光感、干净层级、精准标注，适合电子、工具、办公类产品。',
    fileName: 'clean-tech.png',
    palette: ['#F8FAFC', '#E0F2FE', '#38BDF8', '#0F172A', '#94A3B8', '#14B8A6'],
  },
  {
    id: 'natural-warm',
    label: '自然暖调',
    description: '柔和日光、自然材质、温暖背景，适合家居、母婴、户外生活类产品。',
    fileName: 'natural-warm.png',
    palette: ['#FFF8ED', '#F4D6A6', '#C58A45', '#2F3A2F', '#8FA478', '#E76F51'],
  },
  {
    id: 'premium-contrast',
    label: '高级对比',
    description: '深浅对比、金属质感、编辑感聚焦，适合高客单、礼品、精品配件。',
    fileName: 'premium-contrast.png',
    palette: ['#F5F5F4', '#D6D3D1', '#A8A29E', '#111827', '#C8A24A', '#7C2D12'],
  },
  {
    id: 'bright-retail',
    label: '明亮零售',
    description: '明快色块、清晰卖点区域、购物页友好，适合快消、厨房、运动配件。',
    fileName: 'bright-retail.png',
    palette: ['#FFFFFF', '#FEF3C7', '#F97316', '#2563EB', '#16A34A', '#111827'],
  },
]

export const DEFAULT_STYLE_PRESET_ID = STYLE_PRESETS[0].id

export function getStylePresetById(id) {
  if (!id) return null
  return STYLE_PRESETS.find((preset) => preset.id === id) ?? null
}

export function getStylePresetPath(preset) {
  return join(ASSETS_DIR, 'style-presets', preset.fileName)
}

/** 读预设风格板 PNG 并转 data URL（作为生图请求的最后一张隐藏风格参考图）。 */
export function loadStylePresetDataUrl(presetId) {
  const preset = getStylePresetById(presetId)
  if (!preset) throw new Error('预设风格不存在')
  const file = getStylePresetPath(preset)
  if (!existsSync(file)) throw new Error(`预设风格图缺失：${preset.fileName}`)
  const bytes = readFileSync(file)
  return { preset, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
}

// ---------------------------------------------------------------- 色卡 C1-C6 语义

export const STYLE_PALETTE_ROLES = [
  { key: 'background', label: '背景底色', description: '页面底色与整体氛围' },
  { key: 'soft', label: '柔和辅助色', description: '辅助背景、浅色区域与缓冲层次' },
  { key: 'accent', label: '主强调色', description: '重点信息、按钮或视觉焦点' },
  { key: 'ink', label: '深色文字 / 对比色', description: '标题、正文和清晰对比' },
  { key: 'muted', label: '中性色', description: '次要信息、边界与低对比区域' },
  { key: 'highlight', label: '高亮点缀色', description: '小面积装饰、局部高光与活力点缀' },
]

const COLOR_NAME_REFERENCES = [
  { name: '纯白', hex: '#FFFFFF' },
  { name: '奶油白', hex: '#FFF8ED' },
  { name: '浅杏色', hex: '#F4D6A6' },
  { name: '浅灰', hex: '#E5E7EB' },
  { name: '暖灰', hex: '#A8A29E' },
  { name: '墨黑', hex: '#111827' },
  { name: '深棕', hex: '#7C2D12' },
  { name: '焦糖棕', hex: '#C58A45' },
  { name: '珊瑚橙', hex: '#E76F51' },
  { name: '亮橙', hex: '#F97316' },
  { name: '明黄', hex: '#FACC15' },
  { name: '金色', hex: '#C8A24A' },
  { name: '柔粉', hex: '#F4A3C1' },
  { name: '珊瑚粉', hex: '#FE819A' },
  { name: '玫瑰红', hex: '#F43F5E' },
  { name: '橄榄绿', hex: '#8FA478' },
  { name: '鲜绿', hex: '#16A34A' },
  { name: '湖水青', hex: '#14B8A6' },
  { name: '天蓝', hex: '#38BDF8' },
  { name: '雾蓝', hex: '#94A3B8' },
  { name: '灰蓝', hex: '#7981A4' },
  { name: '亮蓝', hex: '#676CFE' },
  { name: '靛蓝', hex: '#6366F1' },
  { name: '柔和紫', hex: '#7C3AED' },
  { name: '深紫', hex: '#571D91' },
]

function parseHexColor(value) {
  const normalized = value.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

const COLOR_NAME_REFERENCE_RGB = COLOR_NAME_REFERENCES.map((reference) => ({
  ...reference,
  rgb: parseHexColor(reference.hex),
}))

export function isStyleHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
}

export function getApproximateChineseColorName(value) {
  const rgb = value ? parseHexColor(value) : null
  if (!rgb) return '自定义颜色'
  const closest = COLOR_NAME_REFERENCE_RGB.reduce((best, current) => {
    const distance = (rgb.r - current.rgb.r) ** 2 + (rgb.g - current.rgb.g) ** 2 + (rgb.b - current.rgb.b) ** 2
    return distance < best.distance ? { reference: current, distance } : best
  }, { reference: COLOR_NAME_REFERENCE_RGB[0], distance: Number.POSITIVE_INFINITY })
  return closest.reference.name
}

export function getStylePaletteEntries(palette) {
  return STYLE_PALETTE_ROLES.map((role, index) => {
    const rawColor = typeof palette?.[index] === 'string' ? palette[index].trim() : ''
    const color = isStyleHexColor(rawColor) ? rawColor.toUpperCase() : rawColor || '#FFFFFF'
    return {
      index,
      code: `C${index + 1}`,
      roleKey: role.key,
      roleLabel: role.label,
      roleDescription: role.description,
      color,
      colorName: getApproximateChineseColorName(rawColor),
    }
  })
}

/**
 * 构造 formatPromptBlock 的 selectedVisualStyle 入参。
 * styleReference: { kind: 'preset'|'custom'|'uploaded', label, description, palette } 或 null
 */
export function buildSelectedVisualStyle(styleReference) {
  if (!styleReference || typeof styleReference !== 'object') return null
  const label = String(styleReference.label ?? '').trim()
  const description = String(styleReference.description ?? '').trim()
  if (!label && !description) return null
  const palette = Array.isArray(styleReference.palette)
    ? styleReference.palette.filter(isStyleHexColor).map((c) => c.trim().toUpperCase())
    : []
  return {
    label: label || '自定义风格',
    description: description || 'Follow the attached style reference image.',
    palette,
  }
}
