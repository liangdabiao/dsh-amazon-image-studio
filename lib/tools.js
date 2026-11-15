// 插件工具集 + 面板 API 共用的执行引擎（保证面板和工具走同一条校验/落盘路径）
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, resolve as resolvePath } from 'node:path'
import { generateImage, normalizeImageProvider } from './image/index.js'
import { DEFAULT_APIZ_BASE_URL, DEFAULT_APIZ_MODEL, DEFAULT_APIZ_QUALITY } from './image/apiz.js'
import { resolveApizApiKey } from './image/apizUpload.js'
import { DEFAULT_IMAGES_MODEL } from './image/openai.js'
import { DEFAULT_ALIYUN_QWEN_BASE_URL, DEFAULT_ALIYUN_QWEN_MODEL } from './image/aliyun.js'
import { DEFAULT_VOLCENGINE_BASE_URL, DEFAULT_VOLCENGINE_MODEL } from './image/volces.js'
import {
  addHistoryRecord, clearHistory, ensureDirs, fileExists, listPlans, loadPlan,
  readHistory, removeHistoryRecord, removePlan, saveImage, savePlan,
} from './data.js'
import {
  LISTING_COMPLIANCE_ZH, APLUS_COMPLIANCE_ZH, getAmazonMarketplace, normalizeAmazonMarketplaceId,
} from './planner/knowledge.js'
import {
  A_PLUS_CONTENT_TYPES, DEFAULT_LISTING_IMAGE_COUNT, DEFAULT_AMAZON_PROMPT_DRAFT, MAX_A_PLUS_MODULE_COUNT,
  buildAmazonPlanPrompt, buildAmazonPrompt, getAmazonListingImageSlots, formatAmazonListingSlotRange,
  getAPlusContentTypeLabel, getAPlusModuleGenerationSize, getAPlusModuleSpecs, getAPlusModuleUploadSize,
  insertAPlusModuleSpecAfter, isAmazonListingMainSlot, normalizeAmazonPromptDraft,
  normalizeAPlusContentType, normalizeAPlusModuleSpecs, normalizeListingImageCount, removeAPlusModuleSpecAt,
  withExpectedResolution,
} from './planner/slots.js'
import {
  buildPlannerInstructions, buildChatPlannerSchemaGuide, callAmazonPlannerApi,
  normalizeAPlusPlannerPayload, normalizeListingPlannerPayload,
} from './planner/plannerApi.js'
import { normalizeSizeTier } from './planner/size.js'
import { STYLE_PRESETS, buildSelectedVisualStyle, getStylePresetById, loadStylePresetDataUrl } from './style.js'
import {
  MAX_SYNTHETIC_PERFORMER_BATCH_BYTES, checkSyntheticPerformerBytes,
  getSyntheticPerformerMediaFormat, getSyntheticPerformerMediaMimeType,
  getSyntheticPerformerMediaValidationError, tagSyntheticPerformerBytes,
} from './tagger.js'

export const PLUGIN_NAME = 'amazon-image-studio'
export const DEFAULT_STYLE_PRESET = 'clean-tech'
export const DEFAULT_IMAGE_PROVIDER = 'apiz'

// 配置引用：index.js 在 apply 时写入；宿主改配置会重新 apply。
export const configRef = { config: {} }

export function getConfig() {
  return configRef.config ?? {}
}

export function plannerConfigured() {
  const config = getConfig()
  return Boolean(String(config.plannerApiKey ?? '').trim() && String(config.plannerApiUrl ?? '').trim())
}

/** 生图 Key 来源（apiz 支持复用环境变量；本机 CLI 登录态需显式开启）。 */
export function imageKeySource() {
  const config = getConfig()
  const provider = normalizeImageProvider(str(config.imageProvider, DEFAULT_IMAGE_PROVIDER))
  if (provider !== 'apiz') return str(config.imageApiKey) ? 'config' : 'none'
  return resolveApizApiKey(config.imageApiKey, { allowCliAuth: config.imageUseApizCliAuth === true }).source
}

export function imageConfigured() {
  return imageKeySource() !== 'none'
}

/** 是否强制要求产品参考图（默认 true：不允许"凭空"生图）。 */
export function referenceImagesRequired() {
  return getConfig().requireReferenceImages !== false
}

function str(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

// dsh 0.2.x 工具 output 声明：schema + render；data 统一转 JSON 文本（对齐 dsh-ecom-image）。
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '结构化结果（JSON 文本）' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: `${value.ok ? '✅' : '❌'} ${value.summary}${value.data ? `\n\n${value.data}` : ''}`,
  }],
}

function output(ok, summary, data) {
  return { ok, summary, data: data == null ? undefined : (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) }
}

// ---------------------------------------------------------------- 参考图 / 风格图读取

const MAX_PLANNER_PAYLOAD_BYTES = 8 * 1024 * 1024

function readImageAsDataUrl(path) {
  if (!fileExists(path)) throw new Error(`参考图不存在：${path}`)
  const bytes = readFileSync(path)
  const ext = extname(path).toLowerCase()
  const mime = ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/jpeg'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** 读取参考图文件列表 → data URL 数组（总负载 8MiB 上限，超限报错）。 */
export function readReferenceImages(paths) {
  const list = Array.isArray(paths) ? paths : []
  const dataUrls = []
  let total = 0
  for (const raw of list) {
    const path = String(raw ?? '').trim()
    if (!path) continue
    const dataUrl = readImageAsDataUrl(path)
    total += Math.floor(dataUrl.length * 3 / 4)
    dataUrls.push(dataUrl)
  }
  if (total > MAX_PLANNER_PAYLOAD_BYTES) {
    throw new Error(`参考图总负载 ${(total / 1024 / 1024).toFixed(1)} MB 超过 8 MiB 上限，请压缩或减少参考图`)
  }
  return dataUrls
}

/** 解析风格参考：'none' 不挂；模板图路径优先于预设。返回 null 或 { image, selectedVisualStyle }。 */
export function resolveStyleReference({ stylePresetId, templateImagePath } = {}) {
  const templatePath = str(templateImagePath)
  if (templatePath) {
    return {
      image: readImageAsDataUrl(templatePath),
      selectedVisualStyle: buildSelectedVisualStyle({
        label: 'User uploaded template',
        description: 'Follow the attached style reference image for palette, lighting, contrast, material finish, and overall visual polish.',
        palette: [],
      }),
    }
  }
  const presetId = str(stylePresetId, DEFAULT_STYLE_PRESET)
  if (presetId === 'none') return null
  const loaded = loadStylePresetDataUrl(presetId)
  return {
    image: loaded.dataUrl,
    selectedVisualStyle: buildSelectedVisualStyle({
      label: loaded.preset.label,
      description: loaded.preset.description,
      palette: loaded.preset.palette,
    }),
  }
}

// ---------------------------------------------------------------- 策划引擎（amz_plan + /api/plan）

export async function runPlan(options = {}) {
  const config = getConfig()
  const mode = options.mode === 'aplus' ? 'aplus' : 'listing'
  const marketplaceId = normalizeAmazonMarketplaceId(options.marketplaceId)
  const listingText = String(options.listingText ?? '').trim()
  if (!listingText) throw new Error('listingText 不能为空：请粘贴产品标题、五点描述或产品说明')
  const baseDraft = normalizeAmazonPromptDraft(options.draft ?? options)
  const tier = normalizeSizeTier(options.tier ?? config.outputTier)
  const referenceImageDataUrls = options.referenceImages ? readReferenceImages(options.referenceImages) : []

  const common = {
    listingText,
    baseDraft,
    marketplaceId,
    listingImageCount: normalizeListingImageCount(options.listingImageCount),
    aPlusType: normalizeAPlusContentType(options.aPlusType ?? options.aplusType),
    aPlusModuleSpecs: Array.isArray(options.aPlusModuleSpecs ?? options.aplusModuleSpecs) ? (options.aPlusModuleSpecs ?? options.aplusModuleSpecs) : undefined,
    referenceImageDataUrls,
  }

  const result = await callAmazonPlannerApi({
    ...common,
    profile: {
      baseUrl: str(config.plannerApiUrl, 'https://api.deepseek.com'),
      apiKey: str(config.plannerApiKey),
      model: str(config.plannerModel),
      apiMode: config.plannerApiMode === 'responses' ? 'responses' : 'chat',
      timeoutMs: (config.timeoutSeconds ?? 600) * 1000,
    },
    mode,
    aPlusGenerationTier: tier,
    signal: options.signal,
  })

  return savePlanArchive({
    mode,
    marketplaceId,
    listingText,
    draft: baseDraft,
    tier,
    source: 'api',
    ...result,
  })
}

/** 把规范化后的策划结果存档（amz_plan 与 amz_validate_plan 共用）。 */
function savePlanArchive(input) {
  const id = `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const now = new Date().toISOString()
  const archive = {
    id,
    mode: input.mode,
    marketplaceId: input.marketplaceId,
    aPlusType: input.mode === 'aplus' ? input.aPlusType : undefined,
    listingImageCount: input.mode === 'listing' ? input.plans.length : undefined,
    listingText: input.listingText,
    draft: input.draft,
    parsed: input.parsed,
    seriesStyleGuide: input.seriesStyleGuide,
    plans: input.plans,
    aPlusPlans: input.aPlusPlans,
    tier: input.tier,
    source: input.source,
    stylePresetId: DEFAULT_STYLE_PRESET,
    createdAt: now,
    updatedAt: now,
  }
  savePlan(archive)
  return archive
}

/** 未配置策划 API 时，给 agent 的自策划指引（含槽位、语言规则、合规知识、schema 要求）。 */
export function buildAgentPlanningGuide(options = {}) {
  const config = getConfig()
  const mode = options.mode === 'aplus' ? 'aplus' : 'listing'
  const marketplaceId = normalizeAmazonMarketplaceId(options.marketplaceId)
  const aPlusType = normalizeAPlusContentType(options.aPlusType)
  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const baseDraft = normalizeAmazonPromptDraft(options.draft ?? options)
  const optionsForGuide = {
    listingImageCount,
    aPlusModuleSpecs: Array.isArray(options.aPlusModuleSpecs) ? options.aPlusModuleSpecs : undefined,
    marketplaceId,
  }

  return {
    mode,
    marketplaceId,
    aPlusType,
    listingImageCount,
    slots: mode === 'aplus' ? normalizeAPlusModuleSpecs(aPlusType, optionsForGuide.aPlusModuleSpecs).map((s) => ({ slot: s.slot, label: s.label, moduleType: s.moduleType, uploadSize: getAPlusModuleUploadSize(s), objective: s.objective })) : getAmazonListingImageSlots(listingImageCount),
    instructions: buildPlannerInstructions(baseDraft, mode, aPlusType, optionsForGuide),
    schemaGuide: buildChatPlannerSchemaGuide(mode, aPlusType, optionsForGuide),
    compliance: mode === 'aplus' ? APLUS_COMPLIANCE_ZH : LISTING_COMPLIANCE_ZH,
    marketplace: getAmazonMarketplace(marketplaceId),
    nextStep: '按 instructions 自行完成逐槽位策划后，把 JSON 交给 amz_validate_plan 校验存档（payload 字段），再逐槽位 amz_generate 生图。',
    plannerApiUrl: str(config.plannerApiUrl) || null,
  }
}

// ---------------------------------------------------------------- 校验引擎（amz_validate_plan + /api/validate）

/** 校验（agent 自拟或外部）策划 JSON，规范化后存档。payload 是策划 JSON 对象。 */
export function runValidatePlan(options = {}) {
  const mode = options.mode === 'aplus' ? 'aplus' : 'listing'
  const marketplaceId = normalizeAmazonMarketplaceId(options.marketplaceId)
  const tier = normalizeSizeTier(options.tier ?? getConfig().outputTier)
  const payload = typeof options.payload === 'string' ? JSON.parse(options.payload) : options.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload 必须是策划 JSON 对象（或其 JSON 字符串）')
  }
  const baseDraft = normalizeAmazonPromptDraft(options.draft ?? payload.product ?? {})
  const listingText = String(options.listingText ?? '').trim()

  const listingImageCount = normalizeListingImageCount(options.listingImageCount)
  const aPlusType = normalizeAPlusContentType(options.aPlusType ?? options.aplusType)
  const aPlusModuleSpecs = Array.isArray(options.aPlusModuleSpecs ?? options.aplusModuleSpecs) ? (options.aPlusModuleSpecs ?? options.aplusModuleSpecs) : undefined

  const result = mode === 'aplus'
    ? normalizeAPlusPlannerPayload(payload, aPlusType, tier, normalizeAPlusModuleSpecs(aPlusType, aPlusModuleSpecs), marketplaceId)
    : normalizeListingPlannerPayload(payload, listingImageCount, marketplaceId)

  const archive = savePlanArchive({
    mode,
    marketplaceId,
    listingText,
    draft: baseDraft,
    tier,
    source: 'agent',
    ...result,
  })
  return archive
}

// ---------------------------------------------------------------- Prompt 组装（amz_prompt + amz_generate 共用）

/** 取某槽位的策划条目。 */
export function getPlanEntry(archive, slot) {
  const list = archive.mode === 'aplus' ? archive.aPlusPlans ?? [] : archive.plans ?? []
  const entry = list.find((item) => item.slot === slot)
  if (!entry) {
    throw new Error(`策划档案 ${archive.id} 里没有槽位 ${slot}（可用：${list.map((item) => item.slot).join(', ')}）`)
  }
  return entry
}

/** 组装某槽位的最终生图 Prompt（含风格块 / 密度指令 / 负面词 / 分辨率行）。 */
export function composeSlotPrompt(archive, slot, options = {}) {
  const entry = getPlanEntry(archive, slot)
  const styleReference = resolveStyleReference({
    stylePresetId: options.stylePresetId ?? (slot === 'MAIN' ? 'none' : (archive.stylePresetId ?? DEFAULT_STYLE_PRESET)),
    templateImagePath: options.templateImagePath,
  })
  const isMain = isAmazonListingMainSlot(slot)
  const styleReferenceAttached = Boolean(styleReference) && !(archive.mode === 'listing' && isMain)
  const selectedVisualStyle = styleReferenceAttached ? styleReference.selectedVisualStyle : null

  const prompt = buildAmazonPlanPrompt(entry, {
    seriesStyleGuide: archive.seriesStyleGuide,
    styleReferenceAttached,
    styleDensityMode: options.styleDensityMode ?? 'rich',
    marketplaceId: archive.marketplaceId,
    selectedVisualStyle,
  })

  const generationSize = archive.mode === 'aplus'
    ? getAPlusModuleGenerationSize({ uploadWidth: parseUploadWidth(entry), uploadHeight: parseUploadHeight(entry) }, options.tier ?? archive.tier)
    : ((options.tier ?? archive.tier) === '4K' ? '4096x4096' : '2048x2048')

  return {
    slot,
    prompt: withExpectedResolution(prompt, generationSize),
    negativePrompt: entry.negativePrompt ?? '',
    generationSize,
    styleReferenceAttached,
    styleImage: styleReferenceAttached ? styleReference.image : null,
    textTitle: entry.textTitle,
    textBody: entry.textBody,
    entry,
  }
}

function parseUploadWidth(entry) {
  const match = String(entry.uploadSize ?? '').match(/^(\d+)x(\d+)$/)
  return match ? Number(match[1]) : 970
}

function parseUploadHeight(entry) {
  const match = String(entry.uploadSize ?? '').match(/^(\d+)x(\d+)$/)
  return match ? Number(match[2]) : 600
}

// ---------------------------------------------------------------- 生图引擎（amz_generate + /api/generate）

export async function runGenerate(args = {}) {
  const config = getConfig()
  ensureDirs()
  if (!imageConfigured()) {
    throw new Error('未配置 apiz API Key：打开「亚马逊图片」面板 → 设置，填入 apiz 的 sk- Key 并保存（也可以设环境变量 APIZ_API_KEY，或在设置里打开「复用本机 apiz CLI 登录态」）。没有 Key 时不允许生图。')
  }

  const tier = normalizeSizeTier(args.tier ?? config.outputTier)
  const planId = str(args.planId)
  let prompt = ''
  let generationSize = ''
  let slot = str(args.slot)
  let styleImage = null

  if (planId) {
    const archive = loadPlan(planId)
    if (!archive) throw new Error(`策划档案不存在：${planId}`)
    if (!slot) throw new Error('使用 planId 时必须同时给 slot（如 MAIN / PT01 / A+L01）')
    const composed = composeSlotPrompt(archive, slot, {
      stylePresetId: args.stylePresetId,
      templateImagePath: args.templateImagePath,
      styleDensityMode: args.styleDensityMode,
      tier,
    })
    prompt = composed.prompt
    generationSize = composed.generationSize
    styleImage = composed.styleImage
  } else {
    prompt = str(args.prompt)
    if (!prompt) throw new Error('prompt 和 planId 至少给一个')
    const negativePrompt = str(args.negativePrompt)
    if (negativePrompt) prompt = `${prompt}\n\nNegative prompt:\n${negativePrompt}`
    generationSize = str(args.size) || (tier === '4K' ? '4096x4096' : '2048x2048')
    const styleReference = resolveStyleReference({ stylePresetId: args.stylePresetId, templateImagePath: args.templateImagePath })
    styleImage = styleReference?.image ?? null
  }

  // 参考图是硬门槛：没有产品参考图不许生图（风格板不算，它是风格参考不是产品参考）
  const productReferences = args.referenceImages ? readReferenceImages(args.referenceImages) : []
  if (!productReferences.length && referenceImagesRequired()) {
    throw new Error(
      '必须提供产品参考图才能生图：在「亚马逊图片」面板的产品参考图区拖入实拍/包装/结构图（落盘后自动带上），' +
      '或在对话里把参考图的绝对路径数组传给 amz_generate 的 referenceImages。' +
      '（真不想要参考图，可在插件设置里把 requireReferenceImages 关掉，但不建议——没有参考图商品一致性无法保证。）',
    )
  }

  const inputImageDataUrls = [...productReferences]
  if (styleImage) inputImageDataUrls.push(styleImage)

  const provider = normalizeImageProvider(str(config.imageProvider, DEFAULT_IMAGE_PROVIDER))
  const apizKey = provider === 'apiz'
    ? resolveApizApiKey(config.imageApiKey, { allowCliAuth: config.imageUseApizCliAuth === true })
    : { key: str(config.imageApiKey), source: str(config.imageApiKey) ? 'config' : 'none' }
  const imageConfig = {
    provider,
    apiBaseUrl: str(config.imageApiUrl, ''),
    apiKey: apizKey.key,
    model: str(config.imageModel, ''),
    quality: str(config.imageQuality, DEFAULT_APIZ_QUALITY),
    transparency: config.imageTransparency === true,
    timeoutMs: (config.timeoutSeconds ?? 600) * 1000,
    pollIntervalMs: (config.imagePollSeconds ?? 2) * 1000,
    apizBin: str(config.apizBin, ''),
    uploader: typeof config.imageUploader === 'function' ? config.imageUploader : undefined,
    responseFormatB64Json: config.responseFormatB64Json === true,
  }
  if (provider === 'apiz' && !imageConfig.apiBaseUrl) imageConfig.apiBaseUrl = DEFAULT_APIZ_BASE_URL
  if (provider === 'volces' && !imageConfig.apiBaseUrl) imageConfig.apiBaseUrl = DEFAULT_VOLCENGINE_BASE_URL
  if (provider === 'openai' && !imageConfig.apiBaseUrl) imageConfig.apiBaseUrl = 'https://api.openai.com/v1'
  if (provider === 'aliyun' && !imageConfig.apiBaseUrl) imageConfig.apiBaseUrl = DEFAULT_ALIYUN_QWEN_BASE_URL
  if (provider === 'apiz' && !imageConfig.model) imageConfig.model = DEFAULT_APIZ_MODEL
  if (provider === 'volces' && !imageConfig.model) imageConfig.model = DEFAULT_VOLCENGINE_MODEL
  if (provider === 'openai' && !imageConfig.model) imageConfig.model = DEFAULT_IMAGES_MODEL
  if (provider === 'aliyun' && !imageConfig.model) imageConfig.model = DEFAULT_ALIYUN_QWEN_MODEL

  const result = await generateImage({
    prompt,
    size: generationSize || '2048x2048',
    outputFormat: 'png',
    n: 1,
    quality: str(args.quality, ''),
    inputImageDataUrls,
  }, imageConfig)

  const dataUrl = result.images[0]
  const buffer = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  if (!buffer.length) throw new Error('生图接口返回的图片数据是空的')
  const warnings = [...(result.warnings ?? [])]
  if (provider === 'apiz' && apizKey.source === 'apiz-cli') {
    warnings.push('本次用的是本机 apiz CLI 登录态的额度（插件设置里没填 imageApiKey）：要固定用某个 Key 请在设置里填')
  }

  // outputPath 给了就真写到那儿（以前只把路径塞进历史，文件根本没落盘）
  let outputPath = str(args.outputPath, '')
  if (outputPath) {
    outputPath = isAbsolute(outputPath) ? outputPath : resolvePath(outputPath)
    if (!/\.png$/i.test(outputPath)) {
      const previous = extname(outputPath)
      outputPath = `${previous ? outputPath.slice(0, -previous.length) : outputPath}.png`
      warnings.push(`生图统一输出 PNG：${previous ? `已把 ${previous} 改成 .png（` : '已补 .png（'}${outputPath}）`)
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, buffer)
  } else {
    outputPath = saveImage(buffer, 'png')
  }
  const actualSize = result.actualParams?.size || generationSize

  const record = {
    id: `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: 'generate',
    planId: planId || null,
    slot: slot || null,
    marketplaceId: str(args.marketplaceId) || null,
    prompt: prompt.slice(0, 4000),
    generationSize,
    actualSize,
    quality: result.actualParams?.quality || imageConfig.quality || null,
    provider: imageConfig.provider,
    keySource: apizKey.source,
    model: imageConfig.model,
    taskId: result.providerTaskId || null,
    price: typeof result.price === 'number' ? result.price : null,
    referenceCount: inputImageDataUrls.length,
    file: outputPath,
    createdAt: new Date().toISOString(),
  }
  addHistoryRecord(record)

  return {
    record,
    file: outputPath,
    generationSize,
    actualSize,
    prompt,
    warnings: warnings.length ? warnings : undefined,
    note: result.revisedPrompts?.[0] || undefined,
  }
}

// ---------------------------------------------------------------- 打标引擎（amz_tag_performer + /api/tag）

export function runTagFiles(args = {}) {
  const paths = Array.isArray(args.files) ? args.files : []
  if (!paths.length) throw new Error('files 不能为空：给 JPG/PNG/WebP/MP4/MOV 文件的绝对路径数组')

  const outDir = str(args.outDir)
  let outputDir = null
  if (outDir) {
    if (!isAbsolute(outDir)) throw new Error('outDir 必须是绝对路径')
    if (!existsSync(outDir)) throw new Error(`输出目录不存在：${outDir}`)
    outputDir = outDir
  }

  let batchBytes = 0
  const results = []
  let tagged = 0
  let skipped = 0
  let failed = 0

  for (const raw of paths) {
    const path = String(raw ?? '').trim()
    try {
      if (!fileExists(path)) throw new Error('文件不存在')
      const validationError = getSyntheticPerformerMediaValidationError(basename(path), statSync(path).size)
      if (validationError) throw new Error(validationError)
      batchBytes += statSync(path).size
      if (batchBytes > MAX_SYNTHETIC_PERFORMER_BATCH_BYTES) throw new Error('超过单批 1 GB 限制，请分批处理')

      const bytes = readFileSync(path)
      const already = checkSyntheticPerformerBytes(bytes, basename(path))
      if (already && args.action !== 'force') {
        skipped += 1
        results.push({ file: path, status: 'already-tagged' })
        continue
      }

      const taggedResult = tagSyntheticPerformerBytes(bytes, basename(path))
      const target = outputDir ? resolvePath(outputDir, basename(path)) : path
      writeFileSync(target, taggedResult.bytes)
      tagged += 1
      results.push({
        file: path,
        output: target,
        status: 'tagged',
        format: taggedResult.format,
        bytes: taggedResult.bytes.length,
      })
    } catch (err) {
      failed += 1
      results.push({ file: path, status: 'failed', error: String(err?.message ?? err) })
    }
  }

  return { tagged, skipped, failed, results }
}

// ---------------------------------------------------------------- 工具注册

function strArg(description, extra = {}) {
  return { type: 'string', description, ...extra }
}

function numArg(description) {
  return { type: 'number', description }
}

function check(args, parameters) {
  for (const [key, schema] of Object.entries(parameters.properties ?? {})) {
    const value = args?.[key]
    if (value === undefined || value === null || value === '') {
      if (parameters.required?.includes(key)) throw new Error(`缺少必填参数：${key}`)
      continue
    }
    if (schema.type === 'string' && typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
    if (schema.type === 'number' && typeof value !== 'number') throw new Error(`参数 ${key} 必须是数字`)
    if (schema.type === 'array' && !Array.isArray(value)) throw new Error(`参数 ${key} 必须是数组`)
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`参数 ${key} 必须是：${schema.enum.join(' / ')}`)
  }
}

const MARKETPLACE_ENUM = ['us', 'jp', 'de', 'fr', 'it', 'es']
const APLUS_TYPE_ENUM = A_PLUS_CONTENT_TYPES

export const amzSlotsTool = {
  name: 'amz_slots',
  description: '查询亚马逊图片工作台的槽位与尺寸规格（确定性，无网络）：Listing 图位（MAIN + PT01-N，7-12 张）、四套 A+ 模块编排（标准/普通/高级/手机）的槽位、模块类型、官方上传尺寸与生图换算尺寸、模块增删。策划前用它确认槽位表。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: strArg('listing=Listing 图槽位表；aplus=A+ 模块规格表；all=两者都要', { enum: ['listing', 'aplus', 'all'] }),
      count: numArg('Listing 图张数（7-12，默认 7）'),
      aplusType: strArg('A+ 类型：standard / standard-large / premium / mobile', { enum: APLUS_TYPE_ENUM }),
      moduleSpecs: { type: 'array', description: '可选：自定义 A+ 模块清单（[{moduleType, uploadWidth?, uploadHeight?, objective?}]）' },
      insertAfter: numArg('可选：在该索引行后插入同尺寸模块（0 起）'),
      removeAt: numArg('可选：删除该索引的模块（0 起）'),
    },
  },
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const mode = args.mode ?? 'all'
    const tier = normalizeSizeTier(getConfig().outputTier)
    const result = { tier }

    if (mode === 'listing' || mode === 'all') {
      const count = normalizeListingImageCount(args.count)
      result.listing = {
        count,
        slots: getAmazonListingImageSlots(count),
        range: formatAmazonListingSlotRange(count),
        note: 'MAIN 主图不挂风格参考图（白底合规）；附图自动挂当前风格板。',
      }
    }
    if (mode === 'aplus' || mode === 'all') {
      const type = normalizeAPlusContentType(args.aplusType)
      let specs = normalizeAPlusModuleSpecs(type, args.moduleSpecs)
      if (typeof args.insertAfter === 'number') specs = insertAPlusModuleSpecAfter(type, specs, args.insertAfter)
      if (typeof args.removeAt === 'number') specs = removeAPlusModuleSpecAt(type, specs, args.removeAt)
      result.aplus = {
        type,
        typeLabel: getAPlusContentTypeLabel(type),
        moduleCount: specs.length,
        maxModuleCount: MAX_A_PLUS_MODULE_COUNT,
        modules: specs.map((spec) => ({
          slot: spec.slot,
          label: spec.label,
          displayLabel: spec.displayLabel,
          moduleType: spec.moduleType,
          uploadSize: getAPlusModuleUploadSize(spec),
          generationSize: getAPlusModuleGenerationSize(spec, tier),
          objective: spec.objective,
        })),
      }
    }
    const summaryParts = []
    if (result.listing) summaryParts.push(`Listing ${result.listing.range}（${result.listing.count} 张）`)
    if (result.aplus) summaryParts.push(`${result.aplus.typeLabel} ${result.aplus.moduleCount} 个模块`)
    return output(true, summaryParts.join('；') || '槽位表', result)
  },
}

export const amzPlanTool = {
  name: 'amz_plan',
  description: 'AI 策划：把粘贴的 Listing 文案（+可选参考图）策划成逐张图片方案 JSON（Listing：MAIN+PT01-N，每张含中文策划说明/英文 Prompt/负面词；A+：按模块编排）。配置了策划 API Key 时直接调用策划模型；未配置时返回完整自策划指引（槽位表+指令+合规知识），由你自行策划后交 amz_validate_plan 校验存档。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['listingText'],
    properties: {
      listingText: strArg('粘贴的 Listing 文案：产品标题、五点描述、产品说明、品牌说明等'),
      mode: strArg('listing（默认）或 aplus', { enum: ['listing', 'aplus'] }),
      marketplaceId: strArg('目标站点：us/jp/de/fr/it/es，默认 us', { enum: MARKETPLACE_ENUM }),
      listingImageCount: numArg('Listing 图张数（7-12，默认 7）'),
      aplusType: strArg('A+ 类型（mode=aplus 时）', { enum: APLUS_TYPE_ENUM }),
      aPlusModuleSpecs: { type: 'array', description: '可选：自定义 A+ 模块清单' },
      referenceImages: { type: 'array', description: '可选：产品参考图绝对路径数组（实拍/包装/结构图，总负载 ≤8MiB）' },
      productTitle: strArg('可选：已知商品名'),
      category: strArg('可选：类目'),
      brand: strArg('可选：品牌/型号'),
      color: strArg('可选：颜色'),
      material: strArg('可选：材质'),
      audience: strArg('可选：目标人群'),
      packageIncludes: strArg('可选：包装清单'),
      sellingPoints: strArg('可选：卖点（每行一条）'),
      forbidden: strArg('可选：不要出现的元素（每行一条）'),
      tier: strArg('生图档位：2K（默认）/ 4K', { enum: ['1K', '2K', '4K'] }),
    },
  },
  timeoutMs: 660_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const draft = {
      productTitle: args.productTitle, category: args.category, brand: args.brand,
      color: args.color, material: args.material, audience: args.audience,
      packageIncludes: args.packageIncludes, sellingPoints: args.sellingPoints, forbidden: args.forbidden,
    }

    if (!plannerConfigured()) {
      const guide = buildAgentPlanningGuide(args)
      return output(true, '未配置策划 API Key——已生成自策划指引，按指引完成策划后调 amz_validate_plan', {
        agentPlanning: guide,
        draft: normalizeAmazonPromptDraft(draft),
      })
    }

    try {
      const archive = await runPlan({ ...args, draft })
      const slots = archive.mode === 'aplus' ? archive.aPlusPlans.map((p) => p.slot) : archive.plans.map((p) => p.slot)
      return output(true, `AI 策划完成：${archive.parsed.title} → ${slots.length} 张（${slots.join(', ')}），档案 ${archive.id}`, {
        planId: archive.id,
        title: archive.parsed.title,
        sellingPoints: archive.parsed.bullets,
        seriesStyleGuide: archive.seriesStyleGuide,
        slots,
        plans: archive.mode === 'aplus' ? archive.aPlusPlans : archive.plans,
        nextStep: '逐槽位调 amz_prompt 组装最终 Prompt，或直接 amz_generate 生图（一次一张）。',
      })
    } catch (err) {
      // 策划 API 失败（Key 错/模型不支持 JSON/网络）：降级到自策划指引
      const guide = buildAgentPlanningGuide(args)
      return output(true, `策划 API 调用失败（${String(err?.message ?? err).slice(0, 300)}）——已生成自策划指引，按指引完成策划后调 amz_validate_plan`, {
        agentPlanning: guide,
        draft: normalizeAmazonPromptDraft(draft),
      })
    }
  },
}

export const amzValidatePlanTool = {
  name: 'amz_validate_plan',
  description: '校验并存档一份策划 JSON（agent 自策划或外部策划的结果）。严格校验：槽位数量与顺序、字段语言规则（label/planMarkdown 中文，prompt/negativePrompt 英文）、A+ 模块类型与尺寸。校验通过返回 planId，后续用 amz_prompt / amz_generate。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['payload'],
    properties: {
      payload: strArg('策划 JSON（对象或 JSON 字符串）：listing 模式含 product/sellingPoints/seriesStyleGuide/imagePlans；aplus 模式含 aPlusPlans'),
      mode: strArg('listing（默认）或 aplus', { enum: ['listing', 'aplus'] }),
      marketplaceId: strArg('目标站点，默认 us', { enum: MARKETPLACE_ENUM }),
      listingImageCount: numArg('Listing 图张数（7-12，默认 7）'),
      aplusType: strArg('A+ 类型', { enum: APLUS_TYPE_ENUM }),
      aPlusModuleSpecs: { type: 'array', description: '自定义 A+ 模块清单（与 amz_plan 传入一致）' },
      listingText: strArg('可选：原始 Listing 文案（存档用）'),
      tier: strArg('生图档位：2K（默认）/ 4K', { enum: ['1K', '2K', '4K'] }),
    },
  },
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const archive = runValidatePlan(args)
    const slots = archive.mode === 'aplus' ? archive.aPlusPlans.map((p) => p.slot) : archive.plans.map((p) => p.slot)
    return output(true, `策划 JSON 校验通过并存档：${archive.parsed.title} → ${slots.length} 张（档案 ${archive.id}）`, {
      planId: archive.id,
      title: archive.parsed.title,
      slots,
      seriesStyleGuide: archive.seriesStyleGuide,
      nextStep: '逐槽位 amz_prompt 组装最终 Prompt，或直接 amz_generate 生图（一次一张）。',
    })
  },
}

export const amzPromptTool = {
  name: 'amz_prompt',
  description: '组装某槽位的最终生图 Prompt：图片任务 prompt + 选中视觉风格块（附图/A+ 挂风格板，MAIN 主图白底不挂）+ seriesStyleGuide + 版面密度指令 + 负面词 + 风格参考防复制守卫 + 期望输出分辨率。返回最终 Prompt 与应附的参考图说明。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['planId', 'slot'],
    properties: {
      planId: strArg('策划档案 id（amz_plan / amz_validate_plan 返回）'),
      slot: strArg('槽位：MAIN / PT01 / A+S01 / A+L01 / A+P01 / A+M01 …'),
      stylePresetId: strArg(`风格预设：${STYLE_PRESETS.map((p) => p.id).join(' / ')} 或 none（默认 clean-tech；MAIN 自动不挂）`),
      templateImagePath: strArg('可选：用户模板图绝对路径（替代风格预设，作为隐藏风格参考图）'),
      styleDensityMode: strArg('版面密度：rich（默认）/ minimal', { enum: ['rich', 'minimal'] }),
      tier: strArg('生图档位：2K（默认）/ 4K', { enum: ['1K', '2K', '4K'] }),
    },
  },
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const archive = loadPlan(str(args.planId))
    if (!archive) throw new Error(`策划档案不存在：${args.planId}`)
    const composed = composeSlotPrompt(archive, str(args.slot), args)
    return output(true, `${args.slot} 最终 Prompt 已组装（输出 ${composed.generationSize}${composed.styleReferenceAttached ? '，挂风格参考图' : '，主图白底不挂风格图'}）`, {
      slot: composed.slot,
      prompt: composed.prompt,
      generationSize: composed.generationSize,
      styleReferenceAttached: composed.styleReferenceAttached,
      styleNote: composed.styleReferenceAttached
        ? '生成时把风格预设板/模板图作为最后一张输入图一起传（amz_generate 会自动带）'
        : 'MAIN 主图：纯白背景，不附加任何风格图',
      textTitle: composed.textTitle,
      textBody: composed.textBody,
    })
  },
}

export const amzGenerateTool = {
  name: 'amz_generate',
  description: '生成一张亚马逊图片（一次一张）。优先用 planId+slot（自动组装 Prompt、按槽位挂风格板、按模块比例定尺寸）；也可以直接传自拟 prompt。默认走 apiz 的 GPT Image 2.5 Flare（异步任务：创建→轮询→下载；参考图先传 apiz CDN 换公网 URL；尺寸吸附到 10 比例 × 1K/2K/4K 或离散 width/height），也支持 volces / openai / aliyun 三个同步服务商。结果落盘并入历史（含实际尺寸 / 质量档位 / task_id / 预扣积分）。未配 Key 时按 skill 指引改用 dreamina-canvas / apiz CLI。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      planId: strArg('策划档案 id（与 slot 配合；不传则必须给 prompt）'),
      slot: strArg('槽位：MAIN / PT01 / A+S01 …'),
      prompt: strArg('直接生图的完整 Prompt（不用 planId 时必填）'),
      negativePrompt: strArg('可选：负面词（prompt 直传模式）'),
      size: strArg('可选：输出尺寸如 2048x2048（默认按档位/模块比例）'),
      quality: strArg('可选：质量档位（apiz：low/medium/high/xhigh/max；默认取插件配置，未配为 high）', { enum: ['low', 'medium', 'high', 'xhigh', 'max'] }),
      stylePresetId: strArg('风格预设 id 或 none'),
      templateImagePath: strArg('可选：用户模板图绝对路径'),
      styleDensityMode: strArg('rich / minimal'),
      referenceImages: { type: 'array', description: '可选：产品参考图绝对路径数组（apiz 通道会自动上传换公网 URL）' },
      tier: strArg('生图档位：2K（默认）/ 4K', { enum: ['1K', '2K', '4K'] }),
      outputPath: strArg('可选：输出文件绝对路径（默认落 DATA_DIR/images）'),
      marketplaceId: strArg('可选：站点（历史记录用）', { enum: MARKETPLACE_ENUM }),
    },
  },
  timeoutMs: 660_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const result = await runGenerate(args)
    const extra = result.actualSize && result.actualSize !== result.generationSize ? `，实际输出 ${result.actualSize}` : ''
    const warn = result.warnings?.length ? `｜注意：${result.warnings.join('；')}` : ''
    return output(true, `图片已生成：${result.file}（${result.generationSize}${extra}）${warn}`, result)
  },
}

export const amzTagPerformerTool = {
  name: 'amz_tag_performer',
  description: 'AI 人物媒体打标：给 JPG/JPEG/PNG/WebP/MP4/MOV 写入 Amazon 要求的 contains-synthetic-performer XMP 标记（只改元数据，不重编码像素/音视频流）。已正确打标的文件自动跳过；单文件 ≤500MB、单批 ≤1GB；视频写入 Adobe XMP uuid atom，图片写入 APP1 XMP/iTXt。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['files'],
    properties: {
      files: { type: 'array', description: '媒体文件绝对路径数组' },
      action: strArg('tag（默认）：写入；check：只校验不写入；force：已打标也重写', { enum: ['tag', 'check', 'force'] }),
      outDir: strArg('可选：输出目录（默认原地覆写前先校验，安全失败不会写坏原文件；建议给 outDir 保留原件）'),
    },
  },
  timeoutMs: 300_000,
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const files = Array.isArray(args.files) ? args.files : []
    if (args.action === 'check') {
      const results = files.map((path) => {
        const file = String(path ?? '').trim()
        try {
          if (!fileExists(file)) throw new Error('文件不存在')
          const bytes = readFileSync(file)
          const verification = checkSyntheticPerformerBytes(bytes, basename(file))
          return verification
            ? { file, status: 'tagged' }
            : { file, status: 'untagged' }
        } catch (err) {
          return { file, status: 'failed', error: String(err?.message ?? err) }
        }
      })
      const tagged = results.filter((r) => r.status === 'tagged').length
      return output(true, `校验完成：${tagged}/${results.length} 个文件已含标记`, { results })
    }

    const result = runTagFiles({ ...args, action: args.action })
    return output(
      result.failed === 0,
      `打标完成：写入 ${result.tagged}，已标记跳过 ${result.skipped}，失败 ${result.failed}`,
      result,
      (r) => renderText(r),
    )
  },
}

export const amzHistoryTool = {
  name: 'amz_history',
  description: '策划档案与生图历史：list 列策划档案（planId/槽位/标题）；get 看某档案详情或生图记录；generate-list 列生图历史；remove / clear 删除。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: strArg('list / get / generate-list / generate-get / remove / clear / generate-clear', { enum: ['list', 'get', 'generate-list', 'generate-get', 'remove', 'clear', 'generate-clear'] }),
      planId: strArg('action=get/remove 时的策划档案 id'),
      id: strArg('action=generate-get/remove 时的生图记录 id'),
      limit: numArg('action=list / generate-list 的条数上限（默认 20）'),
    },
  },
  output: OUTPUT,
  async execute(args) {
    check(args, this.parameters)
    const action = args.action
    if (action === 'list') {
      const plans = listPlans()
      return output(true, `策划档案 ${plans.length} 个`, { plans: plans.slice(0, args.limit ?? 20) })
    }
    if (action === 'get') {
      const archive = loadPlan(str(args.planId))
      if (!archive) throw new Error(`策划档案不存在：${args.planId}`)
      return output(true, `档案 ${archive.id}：${archive.parsed?.title ?? ''}（${archive.mode}）`, { plan: archive })
    }
    if (action === 'generate-list') {
      const list = readHistory()
      return output(true, `生图历史 ${list.length} 条`, { records: list.slice(0, args.limit ?? 20) })
    }
    if (action === 'generate-get') {
      const record = readHistory().find((item) => item.id === str(args.id))
      if (!record) throw new Error(`生图记录不存在：${args.id}`)
      return output(true, `生图记录 ${record.id}`, { record })
    }
    if (action === 'remove') {
      const removed = removePlan(str(args.planId))
      return output(removed, removed ? `已删除档案 ${args.planId}` : '没有这个档案', { removed })
    }
    if (action === 'clear') {
      const plans = listPlans()
      for (const plan of plans) removePlan(plan.id)
      return output(true, `已清空 ${plans.length} 个策划档案`, { removed: plans.length })
    }
    if (action === 'generate-clear') {
      const count = readHistory().length
      clearHistory()
      return output(true, `已清空 ${count} 条生图历史`, { removed: count })
    }
    throw new Error(`未知 action：${action}`)
  },
}

// 生图历史删除（面板用）
export function removeGenerateRecord(id) {
  return removeHistoryRecord(id)
}

export const TOOLS = [
  amzSlotsTool,
  amzPlanTool,
  amzValidatePlanTool,
  amzPromptTool,
  amzGenerateTool,
  amzTagPerformerTool,
  amzHistoryTool,
]

export { buildAmazonPrompt, DEFAULT_AMAZON_PROMPT_DRAFT, getAmazonMarketplace }
