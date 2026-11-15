// Listing 槽位规则 + A+ 模块规格表 + 最终 Prompt 组装（移植自上游 listingPlanner.ts / amazonPrompt.ts）
import { getAmazonMarketplace } from './knowledge.js'
import { calculateImageSize, normalizeSizeTier } from './size.js'

// ---------------------------------------------------------------- 图型预设（amazonPrompt.ts）

export const AMAZON_IMAGE_KINDS = ['main', 'lifestyle', 'detail', 'scale', 'bundle', 'steps']

export const AMAZON_IMAGE_PRESETS = [
  {
    id: 'main',
    label: '主图',
    shortLabel: 'MAIN',
    goal: '白底商品识别图',
    guidance: [
      'Pure white background RGB 255,255,255.',
      'The product fills about 85% of the frame.',
      'Show the complete product once, uncropped, with true color and proportion.',
      'No text, badges, watermark, border, price, review quote, or decorative graphic.',
    ],
  },
  {
    id: 'lifestyle',
    label: '场景图',
    shortLabel: 'LIFE',
    goal: '还原使用环境',
    guidance: [
      'Use a realistic lifestyle scene that matches the product and target customer.',
      'Keep the product as the clear hero, with no misleading extra included items.',
      'No Amazon logo, Prime mark, best-seller badge, review claim, or pricing message.',
    ],
  },
  {
    id: 'detail',
    label: '细节图',
    shortLabel: 'DETAIL',
    goal: '突出材质/结构/工艺',
    guidance: [
      'Use close-up product photography with crisp surface detail.',
      'Focus on the listed materials, finish, structure, seams, texture, ports, or craftsmanship.',
      'Avoid text overlays unless they are physically printed on the product itself.',
    ],
  },
  {
    id: 'scale',
    label: '比例图',
    shortLabel: 'SCALE',
    goal: '表达尺寸/使用尺度',
    guidance: [
      'Show the product at a believable real-world scale.',
      'Use only neutral context objects or body parts when they do not imply extra included accessories.',
      'Do not add measurements, price, star ratings, Amazon badges, or sales claims.',
    ],
  },
  {
    id: 'bundle',
    label: '套装图',
    shortLabel: 'SET',
    goal: '展示包装清单',
    guidance: [
      'Show every item included in the package at equal visual importance.',
      'Do not enlarge one item in a multi-pack unless the package contents require it.',
      'Avoid showing packaging unless the packaging is a real product feature.',
    ],
  },
  {
    id: 'steps',
    label: '步骤图',
    shortLabel: 'STEP',
    goal: '表达安装/使用动作',
    guidance: [
      'Create a clean sequence-like product use image without written instructions.',
      'Use realistic hands or environment only when appropriate for the category.',
      'Keep all visible items relevant to the sold product and avoid pricing or review claims.',
    ],
  },
]

export const DEFAULT_AMAZON_PROMPT_DRAFT = {
  kind: 'main',
  productTitle: '',
  category: '',
  brand: '',
  color: '',
  material: '',
  sellingPoints: '',
  packageIncludes: '',
  scene: '',
  forbidden: '',
  audience: '',
}

/** 把任意输入规范成 AmazonPromptDraft（策划请求里的「用户已知商品事实」）。 */
export function normalizeAmazonPromptDraft(input) {
  const record = input && typeof input === 'object' ? input : {}
  const text = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value))
  const kind = AMAZON_IMAGE_KINDS.includes(record.kind) ? record.kind : 'main'
  return {
    kind,
    productTitle: text(record.productTitle),
    category: text(record.category),
    brand: text(record.brand),
    color: text(record.color),
    material: text(record.material),
    sellingPoints: Array.isArray(record.sellingPoints) ? record.sellingPoints.map(text).filter(Boolean).join('\n') : text(record.sellingPoints),
    packageIncludes: Array.isArray(record.packageIncludes) ? record.packageIncludes.map(text).filter(Boolean).join(', ') : text(record.packageIncludes),
    scene: text(record.scene),
    forbidden: text(record.forbidden),
    audience: text(record.audience),
  }
}

/** 旧版单图工作流：由商品事实 + 图型预设组装单图 Prompt（策划模式不用它，但 skill 引导时可用）。 */
export function buildAmazonPrompt(draft) {
  const d = normalizeAmazonPromptDraft(draft)
  const preset = AMAZON_IMAGE_PRESETS.find((item) => item.id === d.kind) ?? AMAZON_IMAGE_PRESETS[0]
  const normalizeLines = (value) => value.split(/\r?\n|[;；]/).map((item) => item.trim()).filter(Boolean)
  const sellingPoints = normalizeLines(d.sellingPoints)
  const forbidden = normalizeLines(d.forbidden)

  const formatOptionalLine = (label, value) => (value.trim() ? `- ${label}: ${value.trim()}` : '')
  const productFacts = [
    formatOptionalLine('Product title', d.productTitle),
    formatOptionalLine('Category', d.category),
    formatOptionalLine('Brand or model', d.brand),
    formatOptionalLine('Color', d.color),
    formatOptionalLine('Material / finish', d.material),
    formatOptionalLine('Package includes', d.packageIncludes),
    formatOptionalLine('Target customer', d.audience),
  ].filter(Boolean)

  const scene = d.scene.trim()
  const customScene = scene ? [`Scene direction: ${scene}`] : []

  return [
    'Create a professional Amazon product listing image.',
    '',
    'Product facts:',
    productFacts.length ? productFacts.join('\n') : '- Product title: [fill in exact product name]',
    ...(sellingPoints.length ? ['', 'Key selling points to communicate visually:', ...sellingPoints.map((item) => `- ${item}`)] : []),
    '',
    `Image type: ${preset.label} (${preset.goal}).`,
    ...preset.guidance.map((item) => `- ${item}`),
    ...customScene,
    '',
    'Amazon compliance guard:',
    '- Accurately represent only the product being sold, matching the product title.',
    '- Keep colors, quantity, scale, and included accessories truthful.',
    '- No nudity or sexually suggestive content.',
    '- No customer reviews, five-star ratings, free shipping claims, seller-specific claims, pricing, coupons, or discount text.',
    '- No Amazon, Prime, Alexa, Amazon Choice, Best Seller, hot sale, marketplace badges, or lookalike marks.',
    '- No watermark, border, placeholder, mock UI, or graphic overlay that is not physically part of the product.',
    ...(forbidden.length ? ['- Exclude these specific items or visual risks:', ...forbidden.map((item) => `  - ${item}`)] : []),
    '',
    'Rendering requirements:',
    '- Photorealistic commercial product photography, sharp edges, clean lighting, high resolution, no pixelation, no artifacts.',
    '- Preserve the exact product design from any uploaded reference images; do not invent extra parts or accessories.',
  ].join('\n')
}

// ---------------------------------------------------------------- Listing 槽位

export const DEFAULT_LISTING_IMAGE_COUNT = 7
export const MIN_LISTING_IMAGE_COUNT = 7
export const MAX_LISTING_IMAGE_COUNT = 12
export const LISTING_IMAGE_COUNT_OPTIONS = Array.from(
  { length: MAX_LISTING_IMAGE_COUNT - MIN_LISTING_IMAGE_COUNT + 1 },
  (_, index) => MIN_LISTING_IMAGE_COUNT + index,
)

export function normalizeListingImageCount(value) {
  const count = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : DEFAULT_LISTING_IMAGE_COUNT
  if (!Number.isFinite(count)) return DEFAULT_LISTING_IMAGE_COUNT
  return Math.min(MAX_LISTING_IMAGE_COUNT, Math.max(MIN_LISTING_IMAGE_COUNT, Math.trunc(count)))
}

export function getAmazonListingImageSlots(count = DEFAULT_LISTING_IMAGE_COUNT) {
  const normalizedCount = normalizeListingImageCount(count)
  return [
    'MAIN',
    ...Array.from({ length: normalizedCount - 1 }, (_, index) => `PT${String(index + 1).padStart(2, '0')}`),
  ]
}

export function formatAmazonListingSlotRange(count = DEFAULT_LISTING_IMAGE_COUNT) {
  const slots = getAmazonListingImageSlots(count)
  const tailSlots = slots.slice(1)
  if (!tailSlots.length) return slots[0] ?? 'MAIN'
  return `MAIN + ${tailSlots[0]}-${tailSlots[tailSlots.length - 1]}`
}

export function isAmazonListingMainSlot(slot) {
  return typeof slot === 'string' && slot.trim().toUpperCase() === 'MAIN'
}

const CJK_ON_IMAGE_TEXT_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/

/** 按站点过滤图片可见文案里的 CJK（日本站除外）。 */
export function normalizeOnImageCopy(copy, marketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return copy
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (marketplace.allowsCjkVisibleCopy || !CJK_ON_IMAGE_TEXT_RE.test(line)))
    .join('\n')
}

// ---------------------------------------------------------------- A+ 类型与模块规格

export const A_PLUS_CONTENT_TYPES = ['standard-large', 'standard', 'premium', 'mobile']
export const MIN_A_PLUS_MODULE_COUNT = 1
export const MAX_A_PLUS_MODULE_COUNT = 12

const A_PLUS_MODULE_KINDS = [
  'header-banner',
  'single-image',
  'highlight-tile',
  'hero-banner',
  'feature-image',
  'brand-story',
  'logo',
  'comparison-thumbnail',
]

function makeModules(contentType, items) {
  return items.map((item) => ({ contentType, ...item }))
}

export const STANDARD_A_PLUS_MODULE_SPECS = makeModules('standard', [
  { slot: 'A+S01', label: 'Header Banner', displayLabel: '顶部横幅', moduleType: 'header-banner', uploadWidth: 970, uploadHeight: 300, objective: '用横幅建立品牌质感和核心产品利益点。' },
  ...Array.from({ length: 3 }, (_, index) => ({
    slot: `A+S0${index + 2}`, label: `Single Image ${index + 1}`, displayLabel: `大图模块 ${index + 1}`,
    moduleType: 'single-image', uploadWidth: 970, uploadHeight: 600,
    objective: '用单图模块讲清一个关键卖点或使用场景。',
  })),
  ...Array.from({ length: 4 }, (_, index) => ({
    slot: `A+S0${index + 5}`, label: `Highlight Tile ${index + 1}`, displayLabel: `卖点方块 ${index + 1}`,
    moduleType: 'highlight-tile', uploadWidth: 220, uploadHeight: 220,
    objective: '用方形图块快速呈现一个产品亮点。',
  })),
])

export const STANDARD_LARGE_A_PLUS_MODULE_SPECS = makeModules('standard-large', [
  { slot: 'A+L01', label: 'Header Banner', displayLabel: '顶部横幅', moduleType: 'header-banner', uploadWidth: 970, uploadHeight: 300, objective: '用横幅建立品牌质感和核心产品利益点。' },
  ...Array.from({ length: 4 }, (_, index) => ({
    slot: `A+L0${index + 2}`, label: `Single Image ${index + 1}`, displayLabel: `大图模块 ${index + 1}`,
    moduleType: 'single-image', uploadWidth: 970, uploadHeight: 600,
    objective: '用整张大图讲清一个关键卖点、使用场景或细节证据。',
  })),
])

export const PREMIUM_A_PLUS_MODULE_SPECS = makeModules('premium', [
  { slot: 'A+P01', label: 'Hero Banner', displayLabel: '高级首屏横幅', moduleType: 'hero-banner', uploadWidth: 1464, uploadHeight: 600, objective: '用高级横幅建立首屏视觉冲击和品牌氛围。' },
  ...Array.from({ length: 3 }, (_, index) => ({
    slot: `A+P0${index + 2}`, label: `Feature Image ${index + 1}`, displayLabel: `高级大图模块 ${index + 1}`,
    moduleType: 'feature-image', uploadWidth: 970, uploadHeight: 600,
    objective: '用大图模块展示核心功能、材质或真实场景。',
  })),
  ...Array.from({ length: 2 }, (_, index) => ({
    slot: `A+P0${index + 5}`, label: `Brand Story ${index + 1}`, displayLabel: `品牌故事 ${index + 1}`,
    moduleType: 'brand-story', uploadWidth: 463, uploadHeight: 625,
    objective: '用竖版品牌故事模块强化信任和使用想象。',
  })),
])

export const MOBILE_A_PLUS_MODULE_SPECS = makeModules('mobile', [
  { slot: 'A+M01', label: 'Mobile Hero', displayLabel: '手机首屏', moduleType: 'hero-banner', uploadWidth: 600, uploadHeight: 450, objective: '用移动端首屏图建立产品核心卖点和清晰视觉吸引力。' },
  ...Array.from({ length: 4 }, (_, index) => ({
    slot: `A+M0${index + 2}`, label: `Mobile Feature ${index + 1}`, displayLabel: `手机卖点图 ${index + 1}`,
    moduleType: 'feature-image', uploadWidth: 600, uploadHeight: 450,
    objective: '用移动端友好的 4:3 图片讲清一个关键卖点、细节证据或使用场景。',
  })),
])

export const OPTIONAL_A_PLUS_MODULE_SPECS = makeModules('optional', [
  { slot: 'A+LOGO', label: 'Logo Image', displayLabel: '品牌 Logo', moduleType: 'logo', uploadWidth: 600, uploadHeight: 180, objective: '用于已有品牌标志素材，不默认生成虚构 Logo。' },
  { slot: 'A+CMP', label: 'Comparison Thumbnail', displayLabel: '对比缩略图', moduleType: 'comparison-thumbnail', uploadWidth: 150, uploadHeight: 300, objective: '用于同品牌 SKU 对比，不默认生成不确定对比信息。' },
])

export function isAPlusContentType(value) {
  return A_PLUS_CONTENT_TYPES.includes(value)
}

export function normalizeAPlusContentType(value, fallback = 'standard-large') {
  return isAPlusContentType(value) ? value : fallback
}

export function getAPlusContentTypeLabel(type) {
  switch (type) {
    case 'premium': return '高级A+'
    case 'mobile': return '手机A+'
    case 'standard-large': return '普通A+'
    default: return '标准A+'
  }
}

export function getAPlusModuleSpecs(type) {
  switch (type) {
    case 'premium': return PREMIUM_A_PLUS_MODULE_SPECS.map((s) => ({ ...s }))
    case 'mobile': return MOBILE_A_PLUS_MODULE_SPECS.map((s) => ({ ...s }))
    case 'standard-large': return STANDARD_LARGE_A_PLUS_MODULE_SPECS.map((s) => ({ ...s }))
    default: return STANDARD_A_PLUS_MODULE_SPECS.map((s) => ({ ...s }))
  }
}

export function findAPlusModuleSpec(slot) {
  return [
    ...STANDARD_A_PLUS_MODULE_SPECS,
    ...STANDARD_LARGE_A_PLUS_MODULE_SPECS,
    ...PREMIUM_A_PLUS_MODULE_SPECS,
    ...MOBILE_A_PLUS_MODULE_SPECS,
    ...OPTIONAL_A_PLUS_MODULE_SPECS,
  ].find((spec) => spec.slot === slot)
}

function getAPlusModuleSlotPrefix(type) {
  switch (type) {
    case 'premium': return 'A+P'
    case 'mobile': return 'A+M'
    case 'standard-large': return 'A+L'
    default: return 'A+S'
  }
}

function isAPlusModuleKind(value) {
  return typeof value === 'string' && A_PLUS_MODULE_KINDS.includes(value)
}

function getAPlusModuleTypeText(type, moduleType, ordinal) {
  const suffix = ordinal > 1 || !['header-banner', 'hero-banner', 'logo', 'comparison-thumbnail'].includes(moduleType)
    ? ` ${ordinal}`
    : ''

  switch (moduleType) {
    case 'header-banner': return { label: `Header Banner${suffix}`, displayLabel: `顶部横幅${suffix}` }
    case 'single-image': return { label: `Single Image${suffix}`, displayLabel: `大图模块${suffix}` }
    case 'highlight-tile': return { label: `Highlight Tile${suffix}`, displayLabel: `卖点方块${suffix}` }
    case 'hero-banner':
      return type === 'mobile'
        ? { label: `Mobile Hero${suffix}`, displayLabel: `手机首屏${suffix}` }
        : { label: `Hero Banner${suffix}`, displayLabel: `高级首屏横幅${suffix}` }
    case 'feature-image':
      return type === 'mobile'
        ? { label: `Mobile Feature${suffix}`, displayLabel: `手机卖点图${suffix}` }
        : { label: `Feature Image${suffix}`, displayLabel: `高级大图模块${suffix}` }
    case 'brand-story': return { label: `Brand Story${suffix}`, displayLabel: `品牌故事${suffix}` }
    case 'logo': return { label: `Logo Image${suffix}`, displayLabel: `品牌 Logo${suffix}` }
    case 'comparison-thumbnail': return { label: `Comparison Thumbnail${suffix}`, displayLabel: `对比缩略图${suffix}` }
    default: return { label: `A+ Module${suffix}`, displayLabel: `A+ 模块${suffix}` }
  }
}

function normalizeAPlusDimension(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.trunc(numeric)
}

/** 重排 slot 编号、按 moduleType 补全尺寸 fallback；最多 MAX_A_PLUS_MODULE_COUNT 个。 */
export function normalizeAPlusModuleSpecs(type, specs) {
  const fallbackSpecs = getAPlusModuleSpecs(type)
  const sourceSpecs = Array.isArray(specs) && specs.length ? specs : fallbackSpecs
  const fallbackByModuleType = new Map(fallbackSpecs.map((spec) => [spec.moduleType, spec]))
  const moduleTypeCounts = new Map()
  const normalizedSource = sourceSpecs
    .slice(0, MAX_A_PLUS_MODULE_COUNT)
    .filter((spec) => spec && isAPlusModuleKind(spec.moduleType))

  const safeSource = normalizedSource.length ? normalizedSource : fallbackSpecs
  return safeSource.slice(0, MAX_A_PLUS_MODULE_COUNT).map((spec, index) => {
    const fallback = fallbackByModuleType.get(spec.moduleType) ?? fallbackSpecs[index] ?? fallbackSpecs[0]
    const moduleType = isAPlusModuleKind(spec.moduleType) ? spec.moduleType : fallback.moduleType
    const nextOrdinal = (moduleTypeCounts.get(moduleType) ?? 0) + 1
    moduleTypeCounts.set(moduleType, nextOrdinal)
    const text = getAPlusModuleTypeText(type, moduleType, nextOrdinal)
    return {
      contentType: type,
      slot: `${getAPlusModuleSlotPrefix(type)}${String(index + 1).padStart(2, '0')}`,
      label: text.label,
      displayLabel: text.displayLabel,
      moduleType,
      uploadWidth: normalizeAPlusDimension(spec.uploadWidth, fallback.uploadWidth),
      uploadHeight: normalizeAPlusDimension(spec.uploadHeight, fallback.uploadHeight),
      objective: typeof spec.objective === 'string' && spec.objective.trim() ? spec.objective : fallback.objective,
    }
  })
}

export function insertAPlusModuleSpecAfter(type, specs, index) {
  const normalizedSpecs = normalizeAPlusModuleSpecs(type, specs)
  if (normalizedSpecs.length >= MAX_A_PLUS_MODULE_COUNT) return normalizedSpecs
  const insertIndex = Math.min(Math.max(index, 0), normalizedSpecs.length - 1)
  const source = normalizedSpecs[insertIndex] ?? normalizedSpecs[normalizedSpecs.length - 1]
  return normalizeAPlusModuleSpecs(type, [
    ...normalizedSpecs.slice(0, insertIndex + 1),
    { ...source },
    ...normalizedSpecs.slice(insertIndex + 1),
  ])
}

export function removeAPlusModuleSpecAt(type, specs, index) {
  const normalizedSpecs = normalizeAPlusModuleSpecs(type, specs)
  if (normalizedSpecs.length <= MIN_A_PLUS_MODULE_COUNT) return normalizedSpecs
  const removeIndex = Math.min(Math.max(index, 0), normalizedSpecs.length - 1)
  return normalizeAPlusModuleSpecs(type, normalizedSpecs.filter((_, itemIndex) => itemIndex !== removeIndex))
}

export function getAPlusModuleUploadSize(spec) {
  return `${spec.uploadWidth}x${spec.uploadHeight}`
}

function getSafeAPlusRatio(width, height) {
  const ratio = width / height
  if (ratio > 3) return '3:1'
  if (ratio < 1 / 3) return '1:3'
  return `${width}:${height}`
}

function getAPlusGenerationSizeFromDimensions(width, height, tier) {
  return calculateImageSize(tier, getSafeAPlusRatio(width, height)) ?? (tier === '4K' ? '2880x2880' : '2048x2048')
}

export function getAPlusModuleGenerationSize(spec, tier) {
  return getAPlusGenerationSizeFromDimensions(spec.uploadWidth, spec.uploadHeight, normalizeSizeTier(tier))
}

export function getAPlusPlanGenerationSize(plan, tier) {
  const normalizedTier = normalizeSizeTier(tier)
  const match = typeof plan?.uploadSize === 'string' ? plan.uploadSize.match(/^(\d+)x(\d+)$/) : null
  if (match) return getAPlusGenerationSizeFromDimensions(Number(match[1]), Number(match[2]), normalizedTier)

  const spec = findAPlusModuleSpec(plan.slot)
  if (spec) return getAPlusModuleGenerationSize(spec, normalizedTier)
  return normalizedTier === '4K' ? '2880x2880' : '2048x2048'
}

export function isAPlusTextModule(moduleOrSpec) {
  return moduleOrSpec?.moduleType === 'highlight-tile'
}

export function formatAPlusModuleText(plan) {
  return [String(plan.textTitle ?? '').trim(), String(plan.textBody ?? '').trim()].filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------- 最终 Prompt 组装（formatPromptBlock）

const STYLE_REFERENCE_GUARD = [
  'Style reference rule:',
  '- The last input image is a hidden style reference selected by the user.',
  '- Use it only for color palette, lighting, contrast, material finish, typography feel, and overall visual polish.',
  '- The selected visual style text block is higher priority than any conflicting aesthetic language in the image task or series style guide.',
  '- Do not copy any placeholder words, fixed layout, color swatch positions, exact composition, product arrangement, product count, props, scene, or information density from the style reference board.',
  '- Follow the image task, layout density, and negative prompt sections for the actual content and arrangement.',
].join('\n')

function getStyleDensityGuide(mode, marketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  if (mode === 'minimal') {
    return [
      'Layout density:',
      '- Use a refined minimal Amazon layout with fewer callouts, generous balanced spacing, light icon or line treatment, and restrained visible copy.',
      `- Any customer-facing copy visible in the image must be concise, natural ${marketplace.onImageCopyLanguage} for ${marketplace.domain}.`,
      '- Keep the product and one or two strongest messages dominant, with clean hierarchy and no clutter.',
    ].join('\n')
  }

  return [
    'Layout density:',
    '- Use a polished, information-rich Amazon gallery layout when the selected image type benefits from explanation.',
    `- Build clear hierarchy with mobile-readable ${marketplace.onImageCopyLanguage} copy for ${marketplace.domain}, multiple well-spaced callouts, detail crops, comparison areas, measurement arrows, or use-case zones as appropriate.`,
    '- Keep the composition premium and organized; information-rich should still be readable, balanced, and uncluttered.',
  ].join('\n')
}

/**
 * Listing 与 A+ 共用的最终 Prompt 组装：
 * 图片任务 prompt → 选中视觉风格块（挂风格参考图时，最高优先级）→ seriesStyleGuide（低优先级）
 * → 版面密度指令 → 负面词 → 风格参考图防复制守卫。
 */
export function formatPromptBlock(options) {
  const styleReferenceAttached = Boolean(options.styleReferenceAttached)
  const selectedVisualStyle = styleReferenceAttached ? options.selectedVisualStyle : null
  const selectedStyleBlock = selectedVisualStyle
    ? [
      'Selected visual style (highest priority):',
      `- Style reference: ${selectedVisualStyle.label}.`,
      `- Style direction: ${selectedVisualStyle.description}`,
      selectedVisualStyle.palette?.length ? `- Palette anchors: ${selectedVisualStyle.palette.join(', ')}.` : '',
      '- This selected visual style is the highest-priority visual system for background, palette, typography, lighting, decorative accents, material finish, and information-panel styling.',
      '- If the image task prompt or Series style guide contains a conflicting aesthetic, background mood, color palette, typography direction, or decorative accent, override that conflict with this selected visual style while preserving product facts and required copy.',
    ].filter(Boolean).join('\n')
    : ''
  const seriesStyleGuideLabel = selectedStyleBlock
    ? 'Series style guide (lower priority than the selected visual style):'
    : 'Series style guide:'
  const sections = [
    String(options.prompt ?? '').trim(),
    selectedStyleBlock,
    options.seriesStyleGuide?.trim()
      ? `${seriesStyleGuideLabel}\n${options.seriesStyleGuide.trim()}`
      : '',
    styleReferenceAttached ? getStyleDensityGuide(options.styleDensityMode ?? 'rich', options.marketplaceId) : '',
    options.negativePrompt?.trim()
      ? `Negative prompt:\n${options.negativePrompt.trim()}`
      : '',
    styleReferenceAttached ? STYLE_REFERENCE_GUARD : '',
  ].filter(Boolean)

  return sections.join('\n\n')
}

export function buildAmazonPlanPrompt(plan, options = {}) {
  return formatPromptBlock({
    prompt: plan.prompt,
    negativePrompt: plan.negativePrompt,
    seriesStyleGuide: options.seriesStyleGuide ?? null,
    styleReferenceAttached: options.styleReferenceAttached,
    styleDensityMode: options.styleDensityMode,
    marketplaceId: options.marketplaceId,
    selectedVisualStyle: options.selectedVisualStyle ?? null,
  })
}

export const buildAmazonAPlusPlanPrompt = buildAmazonPlanPrompt

/** 期望输出分辨率追加行（生图提示词与尺寸参数保持一致）。 */
export function withExpectedResolution(prompt, size) {
  if (!size || size === 'auto') return prompt
  return `${prompt}\n\nExpected output resolution: ${size}.`
}
