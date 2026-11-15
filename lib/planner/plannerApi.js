// 策划指引与结果规范化：给对话里的模型生成「自策划指引」（系统指令 + 字段语言规则 + JSON 形状），
// 并把模型产出的策划 JSON 规范化成档案。本插件不直连任何策划模型。
// （指令与规范化移植自上游 listingPlannerApi.ts）
import { formatAmazonAPlusReferenceMaterial, formatAmazonListingReferenceMaterial, getAmazonMarketplace, normalizeAmazonMarketplaceId } from './knowledge.js'
import {
  DEFAULT_LISTING_IMAGE_COUNT,
  getAmazonListingImageSlots,
  getAPlusContentTypeLabel,
  getAPlusModuleGenerationSize,
  getAPlusModuleUploadSize,
  normalizeListingImageCount,
  normalizeAPlusModuleSpecs,
} from './slots.js'
import { normalizeSizeTier } from './size.js'


const DEEPSEEK_TEXT_ONLY_PLANNER_GUARD = 'Because DeepSeek cannot receive or understand reference images in this request, do not infer or describe product facts that are not explicitly present in the listing text or user-provided product facts. Do not invent colors, shapes, structures, accessories, logos, bundle quantity, package contents, materials, printed text, ports, buttons, or product variants. If a visual detail is unknown, keep the prompt neutral and refer to the exact product described by the provided facts.'

const PRODUCT_REFERENCE_FACTS_ONLY_PLANNER_GUIDE = [
  'Product reference image rule:',
  '- Use product reference images only to identify product facts: real appearance, color, shape, structure, included accessories, materials, package contents, and feature evidence.',
  '- Do not use product reference images to choose the final visual style, color palette, background mood, typography style, decorative accents, or overall aesthetic unless the listing text explicitly requests it.',
  '- imagePlans[].prompt and aPlusPlans[].prompt must avoid fixed non-product aesthetics such as coastal resort, warm cream background, botanical accents, luxury editorial, cyberpunk, or magazine fashion unless those are explicit product, brand, or listing requirements.',
  '- seriesStyleGuide should preserve cross-image product consistency, factual visual continuity, copy hierarchy, and product appearance only; it must not lock the final palette, typography, background, lighting mood, or decorative system because the user-selected preset style controls those during image generation.',
].join('\n')

// ---------------------------------------------------------------- 系统指令

function buildMarketplaceInstructionBlock(marketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return [
    `Target marketplace: ${marketplace.label} (${marketplace.domain}, locale ${marketplace.locale}).`,
    `Customer-facing visible copy must be concise, natural ${marketplace.onImageCopyLanguage}.`,
    ...marketplace.localGuidance,
    'Keep image-generation prompt and negativePrompt fields written in English for image-model stability, but quote any visible customer-facing copy in the target marketplace language.',
  ].join('\n')
}

function buildFieldLanguageRules(marketplaceId, options = {}) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  const externalTextRule = options.includeAPlusExternalText
    ? ` textTitle/textBody must be natural ${marketplace.copyLanguage} for ${marketplace.domain} or empty;`
    : ''
  return `Field language rules: label and planMarkdown must be Simplified Chinese;${externalTextRule} seriesStyleGuide, prompt, and negativePrompt must be English. Visible customer-facing copy described inside prompt must be ${marketplace.onImageCopyLanguage}.`
}

function buildListingPlannerInstructions(baseDraft, listingImageCount, marketplaceId) {
  const slots = getAmazonListingImageSlots(listingImageCount)
  return [
    'You are an Amazon image-planning agent. The user provides listing copy and optional product reference images.',
    buildMarketplaceInstructionBlock(marketplaceId),
    `Create a complete visual plan for exactly ${slots.length} Amazon listing image slots: ${slots.join(', ')}.`,
    'The application only fixes the slot count and order. You must decide the strategy, composition, copy approach, visual treatment, prompt content, and negative prompt content.',
    'Use the Amazon reference material below to improve compliance judgment. It is not a fixed slot-by-slot framework, and it must not replace the product facts from the listing and reference images.',
    formatAmazonListingReferenceMaterial(marketplaceId),
    PRODUCT_REFERENCE_FACTS_ONLY_PLANNER_GUIDE,
    'For each slot, write planMarkdown in Simplified Chinese as a detailed agent-style plan similar to a ChatGPT web response, then write a professional English image prompt and English negative prompt.',
    `Each image prompt should fully plan the finished Amazon image: composition, product evidence, on-image ${getAmazonMarketplace(marketplaceId).onImageCopyLanguage} copy when useful, callouts or information areas when useful, visual hierarchy, and rendering style.`,
    'For secondary information images, prefer complete information design with clear hierarchy and useful product evidence; lifestyle or beauty slots should still have purposeful composition and visible product support.',
    'Return one seriesStyleGuide string in English for cross-image product consistency and factual visual continuity. Keep it style-neutral and do not use it to choose the final color palette, typography, background mood, lighting mood, or decorative style.',
    'Do not create, request, or describe separate style reference board images. The application uses built-in preset style reference boards.',
    buildFieldLanguageRules(marketplaceId),
    'Do not generate images. Only return JSON matching the schema.',
    baseDraft.category ? `Known category: ${baseDraft.category}` : '',
  ].filter(Boolean).join('\n')
}

function getAPlusPlannerTypeName(aPlusType) {
  switch (aPlusType) {
    case 'premium': return 'Premium A+ Content'
    case 'mobile': return 'Mobile A+ Content 600x450 module set'
    case 'standard-large': return 'Regular A+ Content large-image template'
    default: return 'Standard A+ Content'
  }
}

function buildAPlusPlannerInstructions(baseDraft, aPlusType, specs, marketplaceId) {
  const typeLabel = getAPlusPlannerTypeName(aPlusType)
  const marketplace = getAmazonMarketplace(marketplaceId)
  const mobileGuidance = aPlusType === 'mobile'
    ? `For Mobile A+ modules, design every 600x450 image for compact mobile screens: one clear message per module, large product evidence, short mobile-readable ${marketplace.onImageCopyLanguage} copy, and no dense multi-column layouts.`
    : ''
  return [
    'You are an Amazon A+ Content image-planning agent. The user provides listing copy, optional brand notes, and optional product reference images.',
    buildMarketplaceInstructionBlock(marketplaceId),
    `Create a ${typeLabel} image module plan. Do not generate images. Only return JSON matching the schema.`,
    `Return exactly ${specs.length} modules in this order: ${specs.map((spec) => `${spec.slot} ${spec.label} ${getAPlusModuleUploadSize(spec)}px`).join('; ')}.`,
    'The application only fixes the module order, module type, upload size, and generation size. You must decide the strategy, composition, copy approach, visual treatment, prompt content, and negative prompt content.',
    'Use the Amazon A+ reference material below to improve compliance judgment. It is not a fixed module creative framework, and it must not replace the product facts from the listing and reference images.',
    formatAmazonAPlusReferenceMaterial(marketplaceId),
    PRODUCT_REFERENCE_FACTS_ONLY_PLANNER_GUIDE,
    'For each module, write planMarkdown in Simplified Chinese as a detailed agent-style plan similar to a ChatGPT web response, then write a professional English image prompt and English negative prompt.',
    `Each module prompt should fully plan the finished Amazon image: composition, product evidence, on-image ${marketplace.onImageCopyLanguage} copy when useful, callouts or information areas when useful, visual hierarchy, and rendering style.`,
    'For A+ information modules, prefer complete information design with clear hierarchy and useful product evidence; lifestyle or brand modules should still have purposeful composition and visible product support.',
    mobileGuidance,
    baseDraft.brand
      ? `Known brand/model: ${baseDraft.brand}. For header-banner and hero-banner modules, naturally include this real brand/model as a small brand line, headline prefix, or subline when it improves the composition. For brand-story modules, use this brand/model to frame the brand tone or promise only when supported by the provided listing or brand notes.`
      : 'If no real brand/model is provided, do not invent a brand name, logo, trademark, brand history, brand promise, authorization claim, website, contact detail, or external link.',
    'Use brand names as text only unless the user provides a real logo reference image. Do not invent logo artwork, standalone trademark/copyright symbols, brand history, authorization claims, websites, contact details, or external links.',
    'Return one seriesStyleGuide string in English for cross-module product consistency and factual visual continuity. Keep it style-neutral and do not use it to choose the final color palette, typography, background mood, lighting mood, or decorative style.',
    'Do not create, request, or describe separate style reference board images. The application uses built-in preset style reference boards.',
    `For modules that need external A+ text outside the image, write textTitle and textBody in natural ${marketplace.copyLanguage}. Otherwise return empty strings.`,
    buildFieldLanguageRules(marketplaceId, { includeAPlusExternalText: true }),
    baseDraft.category ? `Known category: ${baseDraft.category}` : '',
  ].filter(Boolean).join('\n')
}

export function buildPlannerInstructions(baseDraft, mode, aPlusType, options = {}) {
  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const aPlusModuleSpecs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
  return [
    mode === 'aplus'
      ? buildAPlusPlannerInstructions(baseDraft, aPlusType, aPlusModuleSpecs, options.marketplaceId)
      : buildListingPlannerInstructions(baseDraft, listingImageCount, options.marketplaceId),
    options.textOnlyReferenceGuard ? DEEPSEEK_TEXT_ONLY_PLANNER_GUARD : '',
  ].filter(Boolean).join('\n')
}

export function buildChatPlannerSchemaGuide(mode, aPlusType, options = {}) {
  const productFields = 'product { title, category, color, material, audience, packageIncludes }'
  const styleFields = 'seriesStyleGuide string'
  const marketplace = getAmazonMarketplace(options.marketplaceId)
  if (mode === 'aplus') {
    const specs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
    return [
      `Return JSON with: ${productFields}, sellingPoints string[], ${styleFields}, aPlusPlans array.`,
      `aPlusPlans must contain exactly ${specs.length} items in this order: ${specs.map((spec) => spec.slot).join(', ')}.`,
      'Each aPlusPlans item must include: slot, label, moduleType, planMarkdown, textTitle, textBody, prompt, negativePrompt.',
      `textTitle/textBody and visible on-image copy must use natural ${marketplace.copyLanguage} for ${marketplace.domain}; prompt and negativePrompt should remain English.`,
    ].join('\n')
  }

  const slots = getAmazonListingImageSlots(options.listingImageCount ?? DEFAULT_LISTING_IMAGE_COUNT)
  return [
    `Return JSON with: ${productFields}, sellingPoints string[], ${styleFields}, imagePlans array.`,
    `imagePlans must contain exactly ${slots.length} items in this order: ${slots.join(', ')}.`,
    'Each imagePlans item must include: slot, label, planMarkdown, prompt, negativePrompt.',
    `Visible on-image copy inside prompt must use natural ${marketplace.copyLanguage} for ${marketplace.domain}; prompt and negativePrompt should remain English.`,
  ].join('\n')
}

// ---------------------------------------------------------------- 结果规范化（amz_validate_plan 复用）

function normalizePlannerText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePackageIncludes(value) {
  if (!Array.isArray(value)) return normalizePlannerText(value)
  return value.map(normalizePlannerText).filter(Boolean).join(', ')
}

function normalizeParsedListing(payload) {
  const product = payload.product ?? {}
  const sellingPoints = Array.isArray(payload.sellingPoints)
    ? payload.sellingPoints.filter((item) => typeof item === 'string' && item.trim()).slice(0, 5)
    : []
  const title = normalizePlannerText(product.title)
  if (!title) throw new Error('AI 策划结果缺少商品标题')

  const brand = normalizePlannerText(product.brand)
  return {
    title,
    bullets: sellingPoints,
    inferred: {
      productTitle: title,
      category: normalizePlannerText(product.category),
      ...(brand ? { brand } : {}),
      color: normalizePlannerText(product.color),
      material: normalizePlannerText(product.material),
      audience: normalizePlannerText(product.audience),
      packageIncludes: normalizePackageIncludes(product.packageIncludes),
      sellingPoints: sellingPoints.join('\n'),
    },
  }
}

function normalizeSeriesStyleGuide(payload) {
  return typeof payload.seriesStyleGuide === 'string' ? payload.seriesStyleGuide.trim() : ''
}

function normalizePlan(plan, index, slots) {
  const source = plan && typeof plan === 'object' ? plan : {}
  return {
    slot: source.slot || slots[index] || `PT${String(index).padStart(2, '0')}`,
    label: source.label || '图片方案',
    ...(source.kind ? { kind: source.kind } : {}),
    planMarkdown: source.planMarkdown || '',
    prompt: source.prompt || '',
    negativePrompt: source.negativePrompt || '',
  }
}

export function normalizeListingPlannerPayload(payload, listingImageCount, marketplaceId) {
  const parsed = normalizeParsedListing(payload)
  const seriesStyleGuide = normalizeSeriesStyleGuide(payload)
  const slots = getAmazonListingImageSlots(listingImageCount)
  const count = slots.length
  const plans = Array.isArray(payload.imagePlans)
    ? payload.imagePlans.map((plan, index) => normalizePlan(plan, index, slots))
      .filter((plan) => plan.prompt.trim() && plan.planMarkdown.trim())
      .slice(0, count)
    : []

  if (plans.length !== count) throw new Error(`AI 策划结果不是 ${count} 张图`)

  return {
    mode: 'listing',
    marketplaceId,
    parsed,
    seriesStyleGuide,
    plans,
    aPlusPlans: [],
  }
}

function normalizeAPlusPlan(plan, index, tier, specs) {
  const spec = specs[index]
  if (!spec) throw new Error('A+ 模块规格不存在')
  const source = plan && typeof plan === 'object' ? plan : {}

  return {
    slot: source.slot || spec.slot,
    label: spec.label,
    moduleType: spec.moduleType,
    uploadSize: getAPlusModuleUploadSize(spec),
    generationSize: getAPlusModuleGenerationSize(spec, tier),
    planMarkdown: source.planMarkdown || '',
    textTitle: source.textTitle || '',
    textBody: source.textBody || '',
    prompt: source.prompt || '',
    negativePrompt: source.negativePrompt || '',
  }
}

export function normalizeAPlusPlannerPayload(payload, aPlusType, tier, specs, marketplaceId) {
  const parsed = normalizeParsedListing(payload)
  const seriesStyleGuide = normalizeSeriesStyleGuide(payload)
  const rawPlans = Array.isArray(payload.aPlusPlans) ? payload.aPlusPlans : []
  if (rawPlans.length !== specs.length) throw new Error(`AI A+ 策划结果不是 ${specs.length} 个模块`)

  const aPlusPlans = specs.map((spec, index) => {
    const bySlot = rawPlans.find((plan) => plan?.slot === spec.slot)
    return normalizeAPlusPlan(bySlot ?? rawPlans[index], index, tier, specs)
  })

  const emptyPrompt = aPlusPlans.find((plan) => !plan.prompt.trim())
  if (emptyPrompt) throw new Error(`AI A+ 策划结果缺少 ${emptyPrompt.slot} 的提示词`)
  const emptyPlan = aPlusPlans.find((plan) => !plan.planMarkdown.trim())
  if (emptyPlan) throw new Error(`AI A+ 策划结果缺少 ${emptyPlan.slot} 的策划说明`)

  return {
    mode: 'aplus',
    marketplaceId,
    parsed,
    seriesStyleGuide,
    plans: [],
    aPlusPlans,
    aPlusType,
  }
}

