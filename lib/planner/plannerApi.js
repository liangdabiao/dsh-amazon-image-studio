// AI 策划 API：Chat Completions / Responses 双协议 + 严格 JSON Schema + 响应规范化
// （移植自上游 listingPlannerApi.ts；Node 侧直连，无代理层）
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

export const DEFAULT_PLANNER_CHAT_MODEL = 'deepseek-v4-flash'
export const DEFAULT_PLANNER_RESPONSES_MODEL = 'gpt-5.6-terra'

const DEEPSEEK_TEXT_ONLY_PLANNER_GUARD = 'Because DeepSeek cannot receive or understand reference images in this request, do not infer or describe product facts that are not explicitly present in the listing text or user-provided product facts. Do not invent colors, shapes, structures, accessories, logos, bundle quantity, package contents, materials, printed text, ports, buttons, or product variants. If a visual detail is unknown, keep the prompt neutral and refer to the exact product described by the provided facts.'

const PRODUCT_REFERENCE_FACTS_ONLY_PLANNER_GUIDE = [
  'Product reference image rule:',
  '- Use product reference images only to identify product facts: real appearance, color, shape, structure, included accessories, materials, package contents, and feature evidence.',
  '- Do not use product reference images to choose the final visual style, color palette, background mood, typography style, decorative accents, or overall aesthetic unless the listing text explicitly requests it.',
  '- imagePlans[].prompt and aPlusPlans[].prompt must avoid fixed non-product aesthetics such as coastal resort, warm cream background, botanical accents, luxury editorial, cyberpunk, or magazine fashion unless those are explicit product, brand, or listing requirements.',
  '- seriesStyleGuide should preserve cross-image product consistency, factual visual continuity, copy hierarchy, and product appearance only; it must not lock the final palette, typography, background, lighting mood, or decorative system because the user-selected preset style controls those during image generation.',
].join('\n')

// ---------------------------------------------------------------- schema

const PRODUCT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    category: { type: 'string' },
    brand: { type: 'string' },
    color: { type: 'string' },
    material: { type: 'string' },
    audience: { type: 'string' },
    packageIncludes: { type: 'string' },
  },
  required: ['title', 'category', 'brand', 'color', 'material', 'audience', 'packageIncludes'],
}

const SELLING_POINTS_SCHEMA = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } }
const CHINESE_LABEL_SCHEMA = { type: 'string', description: 'Concise Simplified Chinese label for UI display.' }
const PLAN_MARKDOWN_SCHEMA = { type: 'string', description: 'Detailed Simplified Chinese planning write-up for this slot, similar to a ChatGPT agent response. Markdown is allowed.' }
const NEGATIVE_PROMPT_SCHEMA = { type: 'string', description: 'English negative prompt for the image model. Never include Chinese characters.' }

function getVisibleCopyLanguageRule(marketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return marketplace.allowsCjkVisibleCopy
    ? `Visible customer-facing copy inside the prompt must be natural ${marketplace.onImageCopyLanguage} for ${marketplace.domain}; Japanese characters are allowed for visible copy, but do not include Simplified Chinese UI wording.`
    : `Visible customer-facing copy inside the prompt must be natural ${marketplace.onImageCopyLanguage} for ${marketplace.domain}; never include Chinese or Japanese characters in visible copy.`
}

function createImagePromptSchema(marketplaceId) {
  return {
    type: 'string',
    description: `Professional English image-generation prompt. ${getVisibleCopyLanguageRule(marketplaceId)} The overall prompt instructions should remain English for image-model stability.`,
  }
}

function createAPlusExternalTextSchema(field, marketplaceId) {
  const marketplace = getAmazonMarketplace(marketplaceId)
  return {
    type: 'string',
    description: `External A+ ${field} text in natural ${marketplace.copyLanguage} for ${marketplace.domain}, or an empty string when not needed.`,
  }
}

export function createListingPlannerSchema(listingImageCount, marketplaceId) {
  const slots = getAmazonListingImageSlots(listingImageCount)
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      product: PRODUCT_SCHEMA,
      sellingPoints: SELLING_POINTS_SCHEMA,
      seriesStyleGuide: { type: 'string', description: 'LLM-authored English visual style guide to keep the whole image set coherent.' },
      imagePlans: {
        type: 'array',
        minItems: slots.length,
        maxItems: slots.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slot: { type: 'string', enum: slots },
            label: CHINESE_LABEL_SCHEMA,
            planMarkdown: PLAN_MARKDOWN_SCHEMA,
            prompt: createImagePromptSchema(marketplaceId),
            negativePrompt: NEGATIVE_PROMPT_SCHEMA,
          },
          required: ['slot', 'label', 'planMarkdown', 'prompt', 'negativePrompt'],
        },
      },
    },
    required: ['product', 'sellingPoints', 'seriesStyleGuide', 'imagePlans'],
  }
}

export function createAPlusPlannerSchema(specs, marketplaceId) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      product: PRODUCT_SCHEMA,
      sellingPoints: SELLING_POINTS_SCHEMA,
      seriesStyleGuide: { type: 'string', description: 'LLM-authored English visual style guide to keep the whole A+ module set coherent.' },
      aPlusPlans: {
        type: 'array',
        minItems: specs.length,
        maxItems: specs.length,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slot: { type: 'string', enum: specs.map((spec) => spec.slot) },
            label: CHINESE_LABEL_SCHEMA,
            moduleType: { type: 'string', enum: Array.from(new Set(specs.map((spec) => spec.moduleType))) },
            planMarkdown: PLAN_MARKDOWN_SCHEMA,
            textTitle: createAPlusExternalTextSchema('title', marketplaceId),
            textBody: createAPlusExternalTextSchema('body', marketplaceId),
            prompt: createImagePromptSchema(marketplaceId),
            negativePrompt: NEGATIVE_PROMPT_SCHEMA,
          },
          required: ['slot', 'label', 'moduleType', 'planMarkdown', 'textTitle', 'textBody', 'prompt', 'negativePrompt'],
        },
      },
    },
    required: ['product', 'sellingPoints', 'seriesStyleGuide', 'aPlusPlans'],
  }
}

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

function formatDraftFact(label, value) {
  const trimmed = String(value ?? '').trim()
  return trimmed ? `- ${label}: ${trimmed}` : ''
}

function buildUserProductFactsText(baseDraft) {
  const facts = [
    formatDraftFact('Product title', baseDraft.productTitle),
    formatDraftFact('Category', baseDraft.category),
    formatDraftFact('Brand or model', baseDraft.brand),
    formatDraftFact('Color', baseDraft.color),
    formatDraftFact('Material / finish', baseDraft.material),
    formatDraftFact('Target customer', baseDraft.audience),
    formatDraftFact('Package includes', baseDraft.packageIncludes),
    formatDraftFact('Key selling points', baseDraft.sellingPoints),
    formatDraftFact('Do not show / avoid', baseDraft.forbidden),
  ].filter(Boolean)

  return facts.length
    ? ['User-provided product facts. Treat these as authoritative and do not contradict them:', ...facts].join('\n')
    : ''
}

function buildPlannerInputText(listingText, mode, aPlusType, options = {}) {
  const referenceImageInstruction = options.includeReferenceImageInstruction
    ? 'If reference images are attached, use them to understand the actual product appearance and included items.'
    : ''
  const userProductFacts = options.userProductFacts?.trim()
  const marketplace = getAmazonMarketplace(options.marketplaceId)
  if (mode === 'aplus') {
    const specs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
    return [
      `Parse this ${marketplace.domain} listing copy and produce the ${getAPlusContentTypeLabel(aPlusType)} module plan for ${marketplace.label}.`,
      'Use the title and bullet points from the pasted text. If a field is uncertain, infer conservatively from the listing.',
      `Target marketplace language for visible customer-facing copy: ${marketplace.copyLanguage}.`,
      `Use these A+ modules exactly: ${specs.map((spec) => spec.slot).join(', ')}.`,
      referenceImageInstruction,
      userProductFacts,
      '',
      listingText,
    ].filter((item) => item !== '').join('\n')
  }

  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  return [
    `Parse this ${marketplace.domain} listing copy and produce the ${listingImageCount}-image visual plan for ${marketplace.label}.`,
    'Use the title and bullet points from the pasted text. If a field is uncertain, infer conservatively from the listing.',
    `Target marketplace language for visible customer-facing copy: ${marketplace.copyLanguage}.`,
    referenceImageInstruction,
    userProductFacts,
    '',
    listingText,
  ].filter((item) => item !== '').join('\n')
}

function buildChatPlannerUserContent(text, referenceImageDataUrls) {
  if (!referenceImageDataUrls.length) return text
  return [
    { type: 'text', text },
    ...referenceImageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ]
}

function buildResponsesPlannerInput(text, referenceImageDataUrls) {
  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...referenceImageDataUrls.map((url) => ({ type: 'input_image', image_url: url })),
      ],
    },
  ]
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

function buildChatPlannerSystemPrompt(baseDraft, mode, aPlusType, options = {}) {
  return [
    buildPlannerInstructions(baseDraft, mode, aPlusType, options),
    'Return a valid JSON object only. Do not output Markdown fences, comments, or any text outside the JSON object.',
    buildChatPlannerSchemaGuide(mode, aPlusType, {
      listingImageCount: normalizeListingImageCount(options.listingImageCount),
      aPlusModuleSpecs: options.aPlusModuleSpecs,
      marketplaceId: options.marketplaceId,
    }),
  ].join('\n\n')
}

// ---------------------------------------------------------------- 响应解析

export function isOfficialDeepSeekBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return false
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  try {
    return new URL(input).hostname.toLowerCase() === 'api.deepseek.com'
  } catch {
    return /^(?:https?:\/\/)?api\.deepseek\.com(?:[/:]|$)/i.test(raw)
  }
}

function extractResponseText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload
  if (typeof record.output_text === 'string') return record.output_text

  const choices = Array.isArray(record.choices) ? record.choices : []
  const chatChunks = []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const message = choice.message
    if (message && typeof message === 'object') {
      const content = message.content
      if (typeof content === 'string') chatChunks.push(content)
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          if (typeof part.text === 'string') chatChunks.push(part.text)
        }
      }
    }
    const delta = choice.delta
    if (delta && typeof delta === 'object' && typeof delta.content === 'string') chatChunks.push(delta.content)
  }
  if (chatChunks.length) return chatChunks.join('\n').trim()

  const output = Array.isArray(record.output) ? record.output : []
  const chunks = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray(item.content) ? item.content : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      if (typeof part.text === 'string') chunks.push(part.text)
    }
  }
  return chunks.join('\n').trim()
}

// 部分 OpenAI 兼容网关即使 stream:false 也回 SSE——做一个轻量兜底解析。
export function extractTextFromSseTextInternal(rawText) {
  let completedText = ''
  let outputItemText = ''
  let doneText = ''
  let deltaText = ''

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('data:')) continue
    const body = line.slice(5).trim()
    if (!body || body === '[DONE]') continue
    let event
    try { event = JSON.parse(body) } catch { continue }
    if (!event || typeof event !== 'object') continue

    const type = typeof event.type === 'string' ? event.type : ''
    const directText = extractResponseText(event)
    const payloadText = event.response && typeof event.response === 'object' ? extractResponseText(event.response) : ''
    const text = directText || payloadText || (typeof event.text === 'string' ? event.text : '')

    if (type === 'response.output_text.delta') { deltaText += typeof event.delta === 'string' ? event.delta : ''; continue }
    if (!text) continue
    if (type === 'response.completed') completedText = text
    else if (type === 'response.output_item.done') outputItemText = text
    else if (type === 'response.output_text.done' || type === 'response.content_part.done') doneText = text
    else if (!type) deltaText += text
  }

  return completedText.trim() || outputItemText.trim() || doneText.trim() || deltaText.trim()
}

export function parsePlannerPayload(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  return JSON.parse(fenced ?? trimmed)
}

function truncateForError(text) {
  const trimmed = text.trim()
  return trimmed.length <= 1200 ? trimmed : `${trimmed.slice(0, 1200)}...`
}

async function getApiErrorMessage(response) {
  try {
    const raw = await response.text()
    if (!raw.trim()) return `HTTP ${response.status}`
    try {
      const payload = JSON.parse(raw)
      const message = payload?.error?.message ?? payload?.error?.code ?? payload?.message ?? payload?.msg
      if (typeof message === 'string' && message.trim()) return message.trim()
      if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim()
    } catch { /* 非 JSON 错误体 */ }
    return truncateForError(raw)
  } catch {
    return `HTTP ${response.status}`
  }
}

async function readPlannerResponseText(response) {
  const rawText = await response.text()
  if (!rawText.trim()) throw new Error('AI 策划接口返回空内容')

  if (/^\s*data:|^\s*event:/m.test(rawText.slice(0, 2000)) && !/^[{\[]/.test(rawText.trimStart())) {
    const text = extractTextFromSseTextInternal(rawText)
    if (text) return text
    throw new Error('AI 策划流式接口未返回文本内容')
  }

  if (!/application\/json|\+json/i.test(response.headers.get('content-type') ?? '') && !/^[{\[]/.test(rawText.trimStart())) {
    throw new Error(`AI 策划接口返回了非 JSON 内容：${truncateForError(rawText)}`)
  }

  let payload
  try {
    payload = JSON.parse(rawText)
  } catch (err) {
    throw new Error(`AI 策划接口返回了无法解析的 JSON：${err.message}\n\n${truncateForError(rawText)}`)
  }

  const text = extractResponseText(payload)
  if (!text) throw new Error('AI 策划接口未返回文本内容')
  return text
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

// ---------------------------------------------------------------- 调用入口

function buildPlannerUrl(baseUrl, apiMode) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (apiMode === 'chat') {
    // Chat Completions 约定 baseUrl 自带 /v1（与上游一致）
    return `${base}/chat/completions`
  }
  return /\/v\d+$/.test(base) ? `${base}/responses` : `${base}/v1/responses`
}

/**
 * 调策划 LLM。profile: { baseUrl, apiKey, model, apiMode: 'chat'|'responses', timeoutMs? }
 * 返回规范化后的 PlannerApiResult（见 normalizeListingPlannerPayload / normalizeAPlusPlannerPayload）。
 */
export async function callAmazonPlannerApi(options) {
  const profile = options.profile ?? {}
  const apiMode = profile.apiMode === 'responses' ? 'responses' : 'chat'
  const fallbackModel = apiMode === 'chat' ? DEFAULT_PLANNER_CHAT_MODEL : DEFAULT_PLANNER_RESPONSES_MODEL
  const model = String(options.model ?? profile.model ?? '').trim() || fallbackModel
  const mode = options.mode === 'aplus' ? 'aplus' : 'listing'
  const marketplaceId = normalizeAmazonMarketplaceId(options.marketplaceId)
  const aPlusType = options.aPlusType ?? 'standard-large'
  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const aPlusModuleSpecs = normalizeAPlusModuleSpecs(aPlusType, options.aPlusModuleSpecs)
  const aPlusGenerationTier = normalizeSizeTier(options.aPlusGenerationTier ?? '2K')
  const baseDraft = options.baseDraft ?? {}
  const schema = mode === 'aplus'
    ? createAPlusPlannerSchema(aPlusModuleSpecs, marketplaceId)
    : createListingPlannerSchema(listingImageCount, marketplaceId)

  const isDeepSeek = isOfficialDeepSeekBaseUrl(profile.baseUrl)
  const inputText = buildPlannerInputText(options.listingText, mode, aPlusType, {
    includeReferenceImageInstruction: !isDeepSeek,
    userProductFacts: isDeepSeek ? buildUserProductFactsText(baseDraft) : '',
    listingImageCount,
    aPlusModuleSpecs,
    marketplaceId,
  })
  const referenceImageDataUrls = isDeepSeek ? [] : (options.referenceImageDataUrls ?? [])

  const response = await fetch(buildPlannerUrl(profile.baseUrl, apiMode), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${profile.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(apiMode === 'chat'
      ? {
        model,
        messages: [
          {
            role: 'system',
            content: buildChatPlannerSystemPrompt(baseDraft, mode, aPlusType, {
              textOnlyReferenceGuard: isDeepSeek,
              listingImageCount,
              aPlusModuleSpecs,
              marketplaceId,
            }),
          },
          { role: 'user', content: buildChatPlannerUserContent(inputText, referenceImageDataUrls) },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      }
      : {
        model,
        instructions: buildPlannerInstructions(baseDraft, mode, aPlusType, {
          textOnlyReferenceGuard: isDeepSeek,
          listingImageCount,
          aPlusModuleSpecs,
          marketplaceId,
        }),
        input: buildResponsesPlannerInput(inputText, referenceImageDataUrls),
        text: {
          format: {
            type: 'json_schema',
            name: mode === 'aplus' ? 'amazon_aplus_image_plan' : 'amazon_listing_image_plan',
            strict: true,
            schema,
          },
        },
        stream: false,
      }),
    signal: options.signal ?? AbortSignal.timeout(profile.timeoutMs ?? 600_000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await getApiErrorMessage(response)}`)
  }
  const text = await readPlannerResponseText(response)
  const payload = parsePlannerPayload(text)
  return mode === 'aplus'
    ? normalizeAPlusPlannerPayload(payload, aPlusType, aPlusGenerationTier, aPlusModuleSpecs, marketplaceId)
    : normalizeListingPlannerPayload(payload, listingImageCount, marketplaceId)
}
