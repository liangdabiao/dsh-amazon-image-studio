// dsh-amazon-image-studio 单测：node test/lib.test.mjs 直接跑（Windows 下不用 node --test）。
// 数据目录指向工作区 .tmp/，不碰系统 Temp；mock 策划/生图 API 用本地 node:http 随机端口。
process.env.DSH_HOME = new URL('../.tmp/test-home/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
// ！单测必须断网外的一切兜底：apiz 适配器会复用「环境变量 / 本机 apiz CLI 登录态」的 Key，
// 不隔离的话「未配置 Key」用例会真的打到 apiz 生产接口（曾因此触发一次真实计费校验）。
process.env.APIZ_API_KEY = ''
process.env.APIZ_CONFIG = new URL('../.tmp/no-such-apiz-config.toml', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
process.env.APIZ_BIN = new URL('../.tmp/no-such-apiz-bin', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------- 手写 test 循环
let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n    ${err?.stack ?? err}`)
  }
}

const {
  getAmazonListingImageSlots, formatAmazonListingSlotRange, isAmazonListingMainSlot,
  normalizeListingImageCount, normalizeOnImageCopy, normalizeAPlusModuleSpecs,
  insertAPlusModuleSpecAfter, removeAPlusModuleSpecAt, getAPlusModuleSpecs,
  getAPlusModuleGenerationSize, getAPlusContentTypeLabel, normalizeAPlusContentType,
  formatPromptBlock, buildAmazonPrompt, withExpectedResolution,
} = await import('../lib/planner/slots.js')
const { calculateImageSize, normalizeSizeTier } = await import('../lib/planner/size.js')
const { getAmazonMarketplace, formatAmazonListingReferenceMaterial } = await import('../lib/planner/knowledge.js')
const {
  createListingPlannerSchema, parsePlannerPayload, isOfficialDeepSeekBaseUrl,
  normalizeListingPlannerPayload, normalizeAPlusPlannerPayload, extractTextFromSseTextInternal,
} = await import('../lib/planner/plannerApi.js')
const { STYLE_PRESETS, loadStylePresetDataUrl, getStylePaletteEntries, buildSelectedVisualStyle, getStylePresetById } = await import('../lib/style.js')
const {
  configRef, TOOLS, buildAgentPlanningGuide, runValidatePlan, composeSlotPrompt, amzPlanTool,
  amzSlotsTool, amzValidatePlanTool, amzHistoryTool, plannerConfigured, imageConfigured, imageKeySource,
  referenceImagesRequired, runGenerate,
} = await import('../lib/tools.js')
const {
  savePlan, loadPlan, listPlans, removePlan, addHistoryRecord, readHistory,
  removeHistoryRecord, clearHistory, saveImage, fileExists, DATA_DIR,
} = await import('../lib/data.js')
const {
  verifySyntheticPerformerTag, tagSyntheticPerformerBytes, checkSyntheticPerformerBytes,
} = await import('../lib/tagger.js')
const { generateImage } = await import('../lib/image/index.js')
const { getApiErrorMessage } = await import('../lib/image/index.js')
const {
  resolveApizSize, snapToEnum, nearestAspectRatio, tierFromPixels,
  normalizeApizQuality, clampApizPrompt, resolveApizReferenceUrls,
  APIZ_ASPECT_RATIOS, APIZ_SIZE_TIERS, APIZ_WIDTHS, APIZ_HEIGHTS,
} = await import('../lib/image/apiz.js')
const { resolveApizApiKey, readApizCliApiKey } = await import('../lib/image/apizUpload.js')
const { isOpenRouterBaseUrl, DEFAULT_IMAGES_MODEL } = await import('../lib/image/openai.js')
const { normalizeAliyunQwenImageSize, createAliyunQwenImageEndpoint, isAliyunApiBaseUrl } = await import('../lib/image/aliyun.js')
const { buildApiUrl, getDataUrlEncodedByteSize } = await import('../lib/image/shared.js')

console.log('lib.test.mjs · DSH_HOME =', DATA_DIR)

// ---------------------------------------------------------------- helpers

function makeListingPayload(count = 7) {
  const slots = getAmazonListingImageSlots(count)
  return {
    product: { title: '测试保温杯 500ml', category: 'Home & Kitchen', brand: 'TestBrand', color: '白色', material: '不锈钢', audience: '通勤人群', packageIncludes: '杯子, 杯刷' },
    sellingPoints: ['12 小时保温', '食品级不锈钢', '一键开盖'],
    seriesStyleGuide: 'Consistent clean product photography across the series.',
    imagePlans: slots.map((slot, index) => ({
      slot,
      label: `方案${index + 1}`,
      planMarkdown: `第 ${index + 1} 张的策划说明，中文内容。`,
      prompt: `Professional Amazon product image for slot ${slot}, pure white background product photography.`,
      negativePrompt: 'no amazon logo, no price, no review stars',
    })),
  }
}

function makeAPlusPayload(type = 'standard-large') {
  const specs = normalizeAPlusModuleSpecs(type)
  return {
    product: { title: '测试保温杯 500ml', category: 'Home & Kitchen', brand: 'TestBrand', color: '白色', material: '不锈钢', audience: '通勤人群', packageIncludes: '杯子' },
    sellingPoints: ['12 小时保温'],
    seriesStyleGuide: 'Coherent A+ module set.',
    aPlusPlans: specs.map((spec) => ({
      slot: spec.slot,
      label: spec.label,
      moduleType: spec.moduleType,
      planMarkdown: `${spec.slot} 的中文策划说明。`,
      textTitle: spec.moduleType === 'highlight-tile' ? 'Keeps drinks hot for 12 hours' : '',
      textBody: spec.moduleType === 'highlight-tile' ? 'Double-wall stainless steel.' : '',
      prompt: `Professional Amazon A+ image for ${spec.slot}.`,
      negativePrompt: 'no price',
    })),
  }
}

/** 最小合法 JPEG：SOI + APP0(JFIF) + EOI */
function makeJpeg() {
  const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const out = new Uint8Array(2 + app0.length + 2)
  out[0] = 0xff; out[1] = 0xd8
  out.set(app0, 2)
  out[out.length - 2] = 0xff; out[out.length - 1] = 0xd9
  return out
}

/** 最小合法 PNG：签名 + IHDR(13字节) + IEND（CRC 由 tagger 写入时计算，读取不校验 CRC） */
function makePng() {
  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    crcTable[n] = c >>> 0
  }
  const crc32 = (bytes) => {
    let crc = 0xffffffff
    for (const v of bytes) crc = crcTable[(crc ^ v) & 0xff] ^ (crc >>> 8)
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)))
    return out
  }
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = chunk('IHDR', new Uint8Array(13))
  const iend = chunk('IEND', new Uint8Array(0))
  const out = new Uint8Array(signature.length + ihdr.length + iend.length)
  out.set(signature); out.set(ihdr, signature.length); out.set(iend, signature.length + ihdr.length)
  return out
}

const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// 参考图夹具：插件现在强制要有产品参考图，很多用例都需要一个真实存在的文件
const REF_DIR = new URL('../.tmp/test-home/fixtures/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
mkdirSync(REF_DIR, { recursive: true })
const REF_PNG_PATH = join(REF_DIR, 'ref-fixture.png')
writeFileSync(REF_PNG_PATH, Buffer.from(ONE_PX_PNG_BASE64, 'base64'))

/** 本地 mock JSON API 服务器 */
async function withMockServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// ---------------------------------------------------------------- 槽位与规格

await test('Listing 槽位：默认 7 张 MAIN+PT01-06', () => {
  assert.deepEqual(getAmazonListingImageSlots(), ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06'])
  assert.equal(formatAmazonListingSlotRange(), 'MAIN + PT01-PT06')
})

await test('Listing 张数：钳制 7-12', () => {
  assert.equal(normalizeListingImageCount(5), 7)
  assert.equal(normalizeListingImageCount(20), 12)
  assert.equal(normalizeListingImageCount('9'), 9)
  assert.equal(getAmazonListingImageSlots(12).length, 12)
  assert.equal(getAmazonListingImageSlots(12).at(-1), 'PT11')
})

await test('MAIN 槽位判断', () => {
  assert.equal(isAmazonListingMainSlot('MAIN'), true)
  assert.equal(isAmazonListingMainSlot('main '), true)
  assert.equal(isAmazonListingMainSlot('PT01'), false)
  assert.equal(isAmazonListingMainSlot(null), false)
})

await test('图上文案 CJK 过滤：非日本站删 CJK，日本站保留', () => {
  const copy = 'Hot & Cold\n保温杯\n12-Hour Keep Warm'
  assert.equal(normalizeOnImageCopy(copy, 'us'), 'Hot & Cold\n12-Hour Keep Warm')
  assert.equal(normalizeOnImageCopy(copy, 'jp'), 'Hot & Cold\n保温杯\n12-Hour Keep Warm')
})

await test('A+ 模块规格：四套默认编排 + 类型标签', () => {
  assert.equal(getAPlusModuleSpecs('standard-large').length, 5)
  assert.equal(getAPlusModuleSpecs('standard').length, 8)
  assert.equal(getAPlusModuleSpecs('premium').length, 6)
  assert.equal(getAPlusModuleSpecs('mobile').length, 5)
  assert.equal(getAPlusContentTypeLabel('premium'), '高级A+')
  assert.equal(getAPlusContentTypeLabel('standard-large'), '普通A+')
  assert.equal(normalizeAPlusContentType('nope'), 'standard-large')
})

await test('A+ 模块 normalize：重排槽位 + 尺寸 fallback + 非法模块过滤', () => {
  const specs = normalizeAPlusModuleSpecs('standard', [
    { moduleType: 'single-image' },
    { moduleType: 'bad-type' },
    { moduleType: 'highlight-tile' },
  ])
  assert.equal(specs.length, 2)
  assert.equal(specs[0].slot, 'A+S01')
  assert.equal(specs[0].uploadWidth, 970)
  assert.equal(specs[1].slot, 'A+S02')
  assert.equal(specs[1].moduleType, 'highlight-tile')
  assert.equal(specs[1].uploadHeight, 220)
})

await test('A+ 模块增删：insertAfter / removeAt', () => {
  let specs = normalizeAPlusModuleSpecs('standard')
  assert.equal(specs.length, 8)
  specs = removeAPlusModuleSpecAt('standard', specs, 2)
  assert.equal(specs.length, 7)
  assert.equal(specs[2].slot, 'A+S03')
  specs = insertAPlusModuleSpecAfter('standard', specs, 0)
  assert.equal(specs.length, 8)
  assert.equal(specs[1].moduleType, specs[0].moduleType)
})

await test('A+ 生图尺寸：比例换算在档位预算内', () => {
  const size = getAPlusModuleGenerationSize({ uploadWidth: 1464, uploadHeight: 600 }, '2K')
  const [w, h] = size.split('x').map(Number)
  assert.ok(w % 16 === 0 && h % 16 === 0, `16 倍数：${size}`)
  assert.ok(w * h <= 4_194_304, `2K 预算内：${size}`)
  const ratio = (1464 / 600) / (w / h)
  assert.ok(Math.abs(ratio - 1) <= 0.01, `比例误差 ≤1%：${size}`)
})

await test('calculateImageSize：1:1 2K=2048x2048、4K=2880x2880', () => {
  assert.equal(calculateImageSize('2K', '1:1'), '2048x2048')
  assert.equal(calculateImageSize('4K', '1:1'), '2880x2880')
  assert.equal(calculateImageSize('2K', 'bad'), null)
})

await test('normalizeSizeTier：非法回落 2K', () => {
  assert.equal(normalizeSizeTier('4K'), '4K')
  assert.equal(normalizeSizeTier('nope'), '2K')
})

// ---------------------------------------------------------------- Prompt 组装

await test('buildAmazonPrompt：含图型预设与合规守卫', () => {
  const prompt = buildAmazonPrompt({ kind: 'main', productTitle: '保温杯' })
  assert.ok(prompt.includes('Pure white background RGB 255,255,255'))
  assert.ok(prompt.includes('Amazon compliance guard'))
  assert.ok(prompt.includes('- Product title: 保温杯'))
})

await test('formatPromptBlock：不挂风格图时无风格块', () => {
  const out = formatPromptBlock({ prompt: 'task', negativePrompt: 'no logo' })
  assert.ok(!out.includes('Selected visual style'))
  assert.ok(!out.includes('Style reference rule'))
  assert.ok(out.startsWith('task'))
  assert.ok(out.includes('Negative prompt:\nno logo'))
})

await test('formatPromptBlock：挂风格图时含最高优先级风格块+密度+守卫', () => {
  const out = formatPromptBlock({
    prompt: 'task',
    negativePrompt: 'no logo',
    seriesStyleGuide: 'Consistent look.',
    styleReferenceAttached: true,
    styleDensityMode: 'minimal',
    marketplaceId: 'jp',
    selectedVisualStyle: { label: '清爽科技', description: '冷色光感', palette: ['#38BDF8', '#0F172A'] },
  })
  assert.ok(out.includes('Selected visual style (highest priority)'))
  assert.ok(out.includes('- Palette anchors: #38BDF8, #0F172A'))
  assert.ok(out.includes('lower priority than the selected visual style'))
  assert.ok(out.includes('minimal Amazon layout'))
  assert.ok(out.includes('US-English') === false)
  assert.ok(out.includes('Japanese for Amazon.co.jp'))
  assert.ok(out.includes('Style reference rule'))
})

await test('withExpectedResolution 追加分辨率行', () => {
  assert.equal(withExpectedResolution('abc', '2048x2048'), 'abc\n\nExpected output resolution: 2048x2048.')
  assert.equal(withExpectedResolution('abc', 'auto'), 'abc')
})

// ---------------------------------------------------------------- 站点与知识

await test('站点配置：6 站、日本站允许 CJK、参考材料注入', () => {
  assert.equal(getAmazonMarketplace('de').domain, 'Amazon.de')
  assert.equal(getAmazonMarketplace('xx').id, 'us')
  const material = formatAmazonListingReferenceMaterial('fr')
  assert.ok(material.includes('mobile-readable French'))
  assert.ok(material.includes('Amazon.fr'))
  assert.ok(material.includes('pure white background RGB 255,255,255'))
})

// ---------------------------------------------------------------- 策划 API 解析

await test('parsePlannerPayload：裸 JSON 与 ```json 围栏', () => {
  const payload = { a: 1 }
  assert.deepEqual(parsePlannerPayload(JSON.stringify(payload)), payload)
  assert.deepEqual(parsePlannerPayload('```json\n{"a":1}\n```'), payload)
  assert.throws(() => parsePlannerPayload('not json'))
})

await test('isOfficialDeepSeekBaseUrl：官方地址识别', () => {
  assert.equal(isOfficialDeepSeekBaseUrl('https://api.deepseek.com'), true)
  assert.equal(isOfficialDeepSeekBaseUrl('https://api.deepseek.com/v1'), true)
  assert.equal(isOfficialDeepSeekBaseUrl('https://api.openai.com/v1'), false)
  assert.equal(isOfficialDeepSeekBaseUrl(''), false)
})

await test('Listing 策划结果规范化：数量校验 + 字段补全', () => {
  const result = normalizeListingPlannerPayload(makeListingPayload(7), 7, 'us')
  assert.equal(result.plans.length, 7)
  assert.equal(result.plans[0].slot, 'MAIN')
  assert.equal(result.parsed.title, '测试保温杯 500ml')
  const short = makeListingPayload(7)
  short.imagePlans.pop()
  assert.throws(() => normalizeListingPlannerPayload(short, 7, 'us'), /不是 7 张图/)
  const bad = makeListingPayload(7)
  delete bad.product.title
  assert.throws(() => normalizeListingPlannerPayload(bad, 7, 'us'), /缺少商品标题/)
})

await test('A+ 策划结果规范化：槽位对齐 + 外部文案 + 尺寸换算', () => {
  const result = normalizeAPlusPlannerPayload(makeAPlusPayload('standard-large'), 'standard-large', '2K', normalizeAPlusModuleSpecs('standard-large'), 'us')
  assert.equal(result.aPlusPlans.length, 5)
  assert.equal(result.aPlusPlans[0].uploadSize, '970x300')
  assert.ok(/^\d+x\d+$/.test(result.aPlusPlans[0].generationSize))
  assert.equal(result.aPlusType, 'standard-large')
  const broken = makeAPlusPayload('standard-large')
  broken.aPlusPlans.pop()
  assert.throws(() => normalizeAPlusPlannerPayload(broken, 'standard-large', '2K', normalizeAPlusModuleSpecs('standard-large'), 'us'), /不是 5 个模块/)
})

await test('SSE 兜底解析：delta 累积与 completed 优先', () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"{\\"a\\":"}',
    'data: {"type":"response.output_text.delta","delta":"1}"}',
    '',
  ].join('\n')
  assert.equal(extractTextFromSseTextInternal(sse), '{"a":1}')
  const done = 'data: {"type":"response.completed","response":{"output_text":"final"}}'
  assert.equal(extractTextFromSseTextInternal(done), 'final')
})

await test('createListingPlannerSchema：槽位 enum 与必填', () => {
  const schema = createListingPlannerSchema(7, 'us')
  assert.deepEqual(schema.properties.imagePlans.items.properties.slot.enum, getAmazonListingImageSlots(7))
  assert.ok(schema.properties.imagePlans.minItems === 7 && schema.properties.imagePlans.maxItems === 7)
})

// ---------------------------------------------------------------- 风格系统

await test('风格预设：4 套 + 预设板 PNG 可读 + C1-C6 图例', () => {
  assert.equal(STYLE_PRESETS.length, 4)
  const { preset, dataUrl } = loadStylePresetDataUrl('clean-tech')
  assert.equal(preset.id, 'clean-tech')
  assert.ok(dataUrl.startsWith('data:image/png;base64,'))
  assert.ok(dataUrl.length > 10_000, '预设板 PNG 有实际内容')
  assert.equal(getStylePresetById('nope'), null)
  const entries = getStylePaletteEntries(preset.palette)
  assert.equal(entries[0].code, 'C1')
  assert.equal(entries[0].roleLabel, '背景底色')
  assert.equal(entries[2].colorName, '天蓝')
})

await test('buildSelectedVisualStyle：空输入返回 null', () => {
  assert.equal(buildSelectedVisualStyle(null), null)
  const style = buildSelectedVisualStyle({ label: '用户模板', description: '', palette: ['#ABCDEF', 'bad'] })
  assert.equal(style.label, '用户模板')
  assert.deepEqual(style.palette, ['#ABCDEF'])
})

// ---------------------------------------------------------------- XMP 打标

await test('JPEG 打标 roundtrip：写入→验证→重复跳过', () => {
  const jpeg = makeJpeg()
  assert.equal(checkSyntheticPerformerBytes(jpeg, 'a.jpg'), null, '未打标前验证为空')
  const tagged = tagSyntheticPerformerBytes(jpeg, 'a.jpg')
  assert.equal(tagged.format, 'jpeg')
  const verification = verifySyntheticPerformerTag(tagged.bytes, 'a.jpg')
  assert.equal(verification.valid, true)
  assert.equal(verification.keywordCount, 1)
  assert.ok(tagged.bytes.length > jpeg.length)
})

await test('PNG 打标 roundtrip + 已打标检测', () => {
  const png = makePng()
  const tagged = tagSyntheticPerformerBytes(png, 'b.png')
  assert.equal(tagged.format, 'png')
  const verification = verifySyntheticPerformerTag(tagged.bytes, 'b.png')
  assert.equal(verification.valid, true)
  const again = checkSyntheticPerformerBytes(tagged.bytes, 'b.png')
  assert.ok(again, '二次验证应识别已打标')
  assert.throws(() => tagSyntheticPerformerBytes(new Uint8Array([1, 2, 3]), 'c.txt'), /不支持的媒体格式/)
})

// ---------------------------------------------------------------- 数据层

await test('数据层：策划档案存取/列表/删除 + 原子历史', () => {
  const payload = makeListingPayload(7)
  const archive = runValidatePlan({ payload, mode: 'listing', marketplaceId: 'us' })
  assert.ok(archive.id.startsWith('plan-'))
  assert.equal(loadPlan(archive.id).parsed.title, '测试保温杯 500ml')
  assert.ok(listPlans().some((p) => p.id === archive.id))
  assert.equal(removePlan(archive.id), true)
  assert.equal(removePlan(archive.id), false)

  const record = addHistoryRecord({ id: 'gen-x', kind: 'generate', file: 'a.png' })
  assert.equal(record.id, 'gen-x')
  assert.ok(readHistory().some((r) => r.id === 'gen-x'))
  assert.equal(removeHistoryRecord('gen-x'), true)
  addHistoryRecord({ id: 'gen-y', kind: 'generate' })
  clearHistory()
  assert.equal(readHistory().length, 0)
})

await test('saveImage 落盘 + fileExists', () => {
  const file = saveImage(Buffer.from([1, 2, 3]), 'png')
  assert.ok(fileExists(file))
})

// ---------------------------------------------------------------- 面板/工具共享引擎

await test('runValidatePlan：agent 自策划 JSON → 档案 → composeSlotPrompt（MAIN 不挂风格板）', () => {
  const archive = runValidatePlan({ payload: makeListingPayload(7), mode: 'listing', listingImageCount: 7, marketplaceId: 'us' })
  const main = composeSlotPrompt(archive, 'MAIN')
  assert.equal(main.styleReferenceAttached, false, 'MAIN 主图不挂风格板')
  assert.ok(main.prompt.includes('MAIN, pure white background') || main.prompt.includes('MAIN'))
  assert.ok(main.prompt.includes('Expected output resolution: 2048x2048'))
  const pt01 = composeSlotPrompt(archive, 'PT01')
  assert.equal(pt01.styleReferenceAttached, true)
  assert.ok(pt01.styleImage.startsWith('data:image/png;base64,'))
  assert.ok(pt01.prompt.includes('Selected visual style'))
  assert.ok(pt01.prompt.includes('Negative prompt:'))
  assert.throws(() => composeSlotPrompt(archive, 'PT99'), /没有槽位/)
})

await test('amz_validate_plan 工具：A+ 校验 + 输出结构', async () => {
  const result = await amzValidatePlanTool.execute({
    payload: JSON.stringify(makeAPlusPayload('premium')),
    mode: 'aplus',
    aplusType: 'premium',
    marketplaceId: 'jp',
  })
  assert.equal(result.ok, true)
  const data = JSON.parse(result.data)
  assert.equal(data.slots.length, 6)
  assert.equal(data.slots[0], 'A+P01')
})

await test('amz_slots 工具：全量输出', async () => {
  const result = await amzSlotsTool.execute({ mode: 'all', count: 9, aplusType: 'mobile' })
  assert.equal(result.ok, true)
  const data = JSON.parse(result.data)
  assert.equal(data.listing.slots.length, 9)
  assert.equal(data.aplus.modules.length, 5)
  assert.equal(data.aplus.modules[0].uploadSize, '600x450')
})

await test('buildAgentPlanningGuide：未配置时给完整自策划指引', () => {
  configRef.config = {}
  assert.equal(plannerConfigured(), false)
  const guide = buildAgentPlanningGuide({ mode: 'listing', listingImageCount: 7, marketplaceId: 'us' })
  assert.deepEqual(guide.slots, getAmazonListingImageSlots(7))
  assert.ok(guide.instructions.includes('Amazon image-planning agent'))
  assert.ok(guide.schemaGuide.includes('imagePlans must contain exactly 7'))
  assert.ok(guide.compliance.length >= 4)
})

await test('amz_plan 未配置：返回 agentPlanning 指引而不是报错', async () => {
  configRef.config = {}
  const result = await amzPlanTool.execute({ listingText: 'Stainless steel water bottle, 500ml, 12-hour keep warm…' })
  assert.equal(result.ok, true)
  const data = JSON.parse(result.data)
  assert.ok(data.agentPlanning, '应含自策划指引')
  assert.ok(!result.data.planId)
})

await test('amz_history 工具：list / remove', async () => {
  configRef.config = {}
  const result = await amzHistoryTool.execute({ action: 'list', limit: 5 })
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(JSON.parse(result.data).plans))
})

// ---------------------------------------------------------------- mock 策划 API 全链路

await test('amz_plan + mock Chat Completions：全链路策划存档', async () => {
  let requestBody = null
  await withMockServer((req, res) => {
    let chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(makeListingPayload(7)) } }],
      }))
    })
  }, async (url) => {
    configRef.config = {
      plannerApiUrl: url,
      plannerApiKey: 'sk-test',
      plannerModel: 'test-planner',
      plannerApiMode: 'chat',
      imageApiKey: '',
      outputTier: '2K',
    }
    assert.equal(plannerConfigured(), true)
    const result = await amzPlanTool.execute({ listingText: '500ml stainless steel bottle…', marketplaceId: 'us' })
    assert.equal(result.ok, true)
    const data = JSON.parse(result.data)
    assert.ok(data.planId)
    assert.equal(data.slots.length, 7)
    assert.equal(requestBody.model, 'test-planner')
    assert.deepEqual(requestBody.response_format, { type: 'json_object' })
    assert.equal(requestBody.messages[0].role, 'system')
    assert.ok(requestBody.messages[1].content.includes('500ml stainless steel bottle'))
    assert.equal(imageConfigured(), false)
  })
})

await test('amz_plan 策划 API 失败：降级到自策划指引', async () => {
  await withMockServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
  }, async (url) => {
    configRef.config = { plannerApiUrl: url, plannerApiKey: 'sk-bad', plannerModel: 'm', plannerApiMode: 'chat', outputTier: '2K' }
    const result = await amzPlanTool.execute({ listingText: 'bottle' })
    assert.equal(result.ok, true)
    assert.ok(JSON.parse(result.data).agentPlanning, '失败应降级到指引')
    assert.ok(result.summary.includes('401'))
  })
})

// ---------------------------------------------------------------- mock 生图 API 全链路

await test('runGenerate + mock OpenAI 兼容 images/generations：落盘 + 历史', async () => {
  let requestBody = null
  await withMockServer((req, res) => {
    let chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG_BASE64 }] }))
    })
  }, async (url) => {
    configRef.config = {
      plannerApiKey: '',
      imageProvider: 'openai',
      imageApiUrl: url,
      imageApiKey: 'sk-img',
      imageModel: 'gpt-image-2',
      outputTier: '2K',
      timeoutSeconds: 60,
      requireReferenceImages: false, // 这条用例验的是 OpenAI 适配器，不是参考图门槛
    }
    assert.equal(imageConfigured(), true)
    const archive = runValidatePlan({ payload: makeListingPayload(7), mode: 'listing', listingImageCount: 7 })
    const result = await runGenerate({ planId: archive.id, slot: 'MAIN' })
    assert.ok(fileExists(result.file))
    assert.equal(result.generationSize, '2048x2048')
    assert.ok(requestBody.prompt.includes('MAIN, pure white background'))
    assert.equal(requestBody.size, '2048x2048')
    assert.equal(requestBody.n, 1)
    assert.ok(!('image' in requestBody), '无参考图时不应带图字段')
    // 附图带风格参考图 → 走 edits
    const editsBodies = []
    await withMockServer((req2, res2) => {
      const chunks = []
      req2.on('data', (c) => chunks.push(c))
      req2.on('end', () => {
        editsBodies.push(Buffer.concat(chunks).toString('latin1'))
        res2.writeHead(200, { 'content-type': 'application/json' })
        res2.end(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG_BASE64 }] }))
      })
    }, async (url2) => {
      configRef.config.imageApiUrl = url2
      const result2 = await runGenerate({ planId: archive.id, slot: 'PT01' })
      assert.ok(fileExists(result2.file))
      assert.ok(editsBodies[0].includes('name="image[]"'), '有参考图走 multipart edits')
      const history = readHistory()
      assert.ok(history.some((r) => r.planId === archive.id && r.slot === 'MAIN'))
      clearHistory()
    })
  })
})

await test('generateImage：未配置 Key 报错 + aliyun 端点/尺寸归一化', async () => {
  configRef.config = {}
  await assert.rejects(() => runGenerate({ prompt: 'x' }), /未配置 apiz API Key/)
  // 没有参考图也必须被拒（先于任何网络请求）
  configRef.config = { imageApiKey: 'sk-x', imageProvider: 'apiz' }
  await assert.rejects(() => runGenerate({ prompt: 'x' }), /必须提供产品参考图/)
  assert.equal(referenceImagesRequired(), true)
  assert.equal(normalizeAliyunQwenImageSize('4096x4096'), '2048*2048')
  assert.equal(normalizeAliyunQwenImageSize('512x512'), '512*512')
  assert.ok(createAliyunQwenImageEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1').includes('/services/aigc/multimodal-generation/generation'))
  assert.equal(isAliyunApiBaseUrl('https://dashscope.aliyuncs.com/api/v1'), true)
  assert.equal(isAliyunApiBaseUrl('https://api.openai.com/v1'), false)
})

// ---------------------------------------------------------------- apiz（GPT Image 2.5 Flare）

await test('apiz 尺寸吸附：插件尺寸 → 离散 width/height 或比例档位', () => {
  // 2K 正方形原样命中；4K 正方形超最大边/像素预算 → 压到 2880×2880（8.29M 上限）
  assert.deepEqual(resolveApizSize('2048x2048'), { width: 2048, height: 2048 })
  assert.deepEqual(resolveApizSize('1024x1024'), { width: 1024, height: 1024 })
  assert.deepEqual(resolveApizSize('4096x4096'), { width: 2880, height: 2880 })

  // A+ 模块尺寸（插件按官方上传比例 ×2.x 算出）：比例误差 ≤2%，像素在官方区间
  const cases = [
    ['3184x1312', 1464, 600],   // 高级 A+ 横幅
    ['2592x1616', 970, 600],    // 标准 A+ 大图
    ['1760x2368', 463, 625],    // 品牌故事竖版
    ['1944x1200', 970, 600],
    ['2592x2400', 970, 900],
  ]
  for (const [input, uploadW, uploadH] of cases) {
    const got = resolveApizSize(input)
    assert.ok(got.width, `${input} 应给出 width/height：${JSON.stringify(got)}`)
    const [, , targetW, targetH] = [0, 0, uploadW, uploadH]
    const [w, h] = input.split('x').map(Number)
    const ratioError = Math.abs((got.width / got.height) - (w / h)) / (w / h)
    assert.ok(ratioError < 0.03, `${input} → ${got.width}x${got.height} 比例误差 ${(ratioError * 100).toFixed(1)}%`)
    const pixels = got.width * got.height
    assert.ok(pixels >= 655_360 && pixels <= 8_294_400, `${input} 像素越界：${pixels}`)
    assert.ok(Math.max(got.width, got.height) <= 3840)
    // 像素数不应被无谓放大（否则白花钱）：最多比目标大 1.6 倍
    assert.ok(pixels <= w * h * 1.6, `${input} 像素被放大太多：${pixels} vs ${w * h}`)
    assert.ok(targetW > 0 && targetH > 0)
  }

  // 超出 3:1 的极端长条 → 退回「比例 + 档位」
  const extreme = resolveApizSize('3840x640')
  assert.ok(extreme.aspect_ratio, `应为比例档位：${JSON.stringify(extreme)}`)
  assert.ok(APIZ_ASPECT_RATIOS.includes(extreme.aspect_ratio))
  assert.ok(APIZ_SIZE_TIERS.includes(extreme.size))
  // 非像素写法：1K / auto
  assert.deepEqual(resolveApizSize('1K'), { aspect_ratio: '1:1', size: '1K' })
  assert.deepEqual(resolveApizSize('auto'), { aspect_ratio: '1:1', size: '2K' })
  // 基础工具函数
  assert.equal(snapToEnum(APIZ_WIDTHS, 3000), 2880)
  assert.equal(snapToEnum(APIZ_HEIGHTS, 1000), 1024)
  assert.equal(nearestAspectRatio(1464, 600), '21:9')
  assert.equal(nearestAspectRatio(1024, 1024), '1:1')
  assert.equal(tierFromPixels(2048 * 2048), '2K')
  assert.equal(tierFromPixels(1024 * 1024), '1K')
  assert.equal(tierFromPixels(2880 * 2880), '4K')
})

await test('apiz 质量/提示词归一化 + 报错体解析', async () => {
  assert.equal(normalizeApizQuality('HIGH'), 'high')
  assert.equal(normalizeApizQuality(' xhigh '), 'xhigh')
  assert.equal(normalizeApizQuality('standard'), 'medium')
  assert.equal(normalizeApizQuality('hd'), 'high')
  assert.equal(normalizeApizQuality('ultra'), 'max')
  assert.equal(normalizeApizQuality('bogus'), 'low')
  assert.equal(normalizeApizQuality('bogus', 'medium'), 'medium')
  assert.equal(normalizeApizQuality(undefined), 'low', '默认低配（省钱）')

  const longPrompt = 'a'.repeat(7100)
  const clamped = clampApizPrompt(longPrompt)
  assert.equal(clamped.prompt.length, 7000)
  assert.equal(clamped.warnings.length, 1)
  assert.equal(clampApizPrompt('  short  ').prompt, 'short')
  assert.throws(() => clampApizPrompt('   '), /非空 prompt/)

  // apiz 的报错体是 { detail: "…" }
  const detailError = await getApiErrorMessage(new Response(JSON.stringify({ detail: 'quality 必须为 low、medium、high、xhigh 或 max' }), { status: 400 }))
  assert.equal(detailError, 'quality 必须为 low、medium、high、xhigh 或 max')
  const listError = await getApiErrorMessage(new Response(JSON.stringify({ detail: [{ msg: 'prompt 必填' }, '长度超限'] }), { status: 422 }))
  assert.equal(listError, 'prompt 必填；长度超限')
  // 其余服务商仍按 error.message 解析
  const openaiError = await getApiErrorMessage(new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 }))
  assert.equal(openaiError, 'invalid api key')
})

await test('apiz Key 解析：配置 > 环境变量 > 本机 CLI 登录态（CLI 需显式开启）', () => {
  const saved = { config: process.env.APIZ_CONFIG, key: process.env.APIZ_API_KEY }
  try {
    process.env.APIZ_CONFIG = new URL('../.tmp/no-such-apiz-config.toml', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
    process.env.APIZ_API_KEY = ''
    assert.deepEqual(resolveApizApiKey('sk-from-config'), { key: 'sk-from-config', source: 'config' })
    assert.deepEqual(resolveApizApiKey(''), { key: '', source: 'none' })

    process.env.APIZ_API_KEY = 'sk-from-env'
    assert.deepEqual(resolveApizApiKey(''), { key: 'sk-from-env', source: 'env' })
    process.env.APIZ_API_KEY = ''

    const cliConfig = new URL('../.tmp/apiz-cli-config.toml', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
    writeFileSync(cliConfig, '[profile.default]\napi_key = "sk-from-cli"\n')
    process.env.APIZ_CONFIG = cliConfig
    // 默认不自动复用登录态：没显式开启就当没配
    assert.deepEqual(resolveApizApiKey(''), { key: '', source: 'none' })
    assert.deepEqual(resolveApizApiKey('', { allowCliAuth: true }), { key: 'sk-from-cli', source: 'apiz-cli' })
    assert.equal(readApizCliApiKey(), 'sk-from-cli')
  } finally {
    process.env.APIZ_CONFIG = saved.config
    process.env.APIZ_API_KEY = saved.key
  }
})

await test('runGenerate + apiz 异步任务：create → query → 下载 → 落盘（含参考图上传）', async () => {
  const requests = []
  const uploadedRefs = []
  let queryCount = 0
  let mockBase = ''
  await withMockServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      requests.push({ url: req.url, auth: req.headers.authorization, body })
      if (req.url === '/api/v3/tasks/create') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 200, data: { task_id: 'task_abc', price: 12 } }))
        return
      }
      if (req.url === '/api/v3/tasks/query') {
        queryCount += 1
        // 第一次返回处理中，第二次完成 —— 覆盖轮询分支
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(queryCount < 2
          ? { code: 200, data: { status: 'processing' } }
          : { code: 200, data: { status: 'completed', result: { images: [`${mockBase}/cdn/out.png`] } } }))
        return
      }
      if (req.url === '/cdn/out.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from(ONE_PX_PNG_BASE64, 'base64'))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  }, async (url) => {
    mockBase = url
    configRef.config = {
      plannerApiKey: '',
      imageProvider: 'apiz',
      imageApiUrl: url,
      imageApiKey: 'sk-apiz',
      outputTier: '2K',
      timeoutSeconds: 30,
      imagePollSeconds: 0.01,
      imageQuality: 'xhigh',
      // 注入上传器：单测不起真 apiz CLI
      imageUploader: async (dataUrl) => {
        uploadedRefs.push(dataUrl.slice(0, 22))
        return `${url}/cdn/ref-${uploadedRefs.length}.png`
      },
    }
    assert.equal(imageConfigured(), true)
    assert.equal(imageKeySource(), 'config')
    const archive = runValidatePlan({ payload: makeListingPayload(7), mode: 'listing', listingImageCount: 7 })

    // MAIN：带产品参考图、但不挂风格板
    const main = await runGenerate({ planId: archive.id, slot: 'MAIN', referenceImages: [REF_PNG_PATH] })
    assert.ok(fileExists(main.file))
    const createMain = requests.find((r) => r.url === '/api/v3/tasks/create')
    assert.equal(createMain.auth, 'Bearer sk-apiz')
    assert.equal(createMain.body.model, 'apiz/gpt-image-2.5-flare')
    assert.deepEqual(createMain.body.params.width, 2048)
    assert.deepEqual(createMain.body.params.height, 2048)
    assert.equal(createMain.body.params.quality, 'xhigh')
    assert.ok(!('aspect_ratio' in createMain.body.params), '用了 width/height 就不能再带比例')
    assert.equal(createMain.body.params.reference_image_urls.length, 1, 'MAIN 只该带产品参考图')
    // 异步任务元信息进历史
    assert.equal(main.record.taskId, 'task_abc')
    assert.equal(main.record.price, 12)
    assert.equal(main.record.actualSize, '2048x2048')
    assert.equal(main.record.quality, 'xhigh')

    // PT01：产品参考图 + 风格板 → 两张都要先换成公网 URL，风格板在最后
    requests.length = 0
    const pt = await runGenerate({ planId: archive.id, slot: 'PT01', referenceImages: [REF_PNG_PATH] })
    const createPt = requests.find((r) => r.url === '/api/v3/tasks/create')
    assert.equal(createPt.body.params.reference_image_urls.length, 2)
    assert.ok(/^https?:\/\//.test(createPt.body.params.reference_image_urls[0]))
    assert.equal(uploadedRefs.length, 2, '产品图 + 风格板都该上传（内容不同 → 各传一次）')
    assert.ok(!(main.warnings ?? []).some((w) => /参考图|上传/.test(w)), 'MAIN 不该有上传告警')
    assert.ok(fileExists(pt.file))

    // 参考图顺序：产品图在前、风格板必须留最后（Prompt 的风格守卫依赖这个顺序）；
    // 同一张图（同内容哈希）只上传一次，命中缓存
    const onePx = `data:image/png;base64,${ONE_PX_PNG_BASE64}`
    const uploadedBefore = uploadedRefs.length
    let uploadCalls = 0
    const ordered = await resolveApizReferenceUrls([onePx, 'https://example.com/product.png', onePx], {
      uploader: async () => {
        uploadCalls += 1
        return `https://cdn.example.com/ref-${uploadedBefore + uploadCalls}.png`
      },
    })
    assert.equal(ordered.length, 2, '同一张图重复传入只算一张')
    assert.equal(ordered[0], 'https://example.com/product.png', 'http URL 原样保留')
    assert.ok(/^https?:\/\//.test(ordered[1]), `data URL 必须换成公网 URL：${ordered[1]}`)
    assert.ok(uploadCalls <= 1, '同一张图不该重复上传')

    // 同一张图重复传入：只保留最后一次（不重复计费，也不破坏"风格板在最后"）
    const dupe = await resolveApizReferenceUrls(['https://a/x.png', 'https://a/y.png', 'https://a/x.png'])
    assert.deepEqual(dupe, ['https://a/y.png', 'https://a/x.png'])

    // outputPath：必须真的落盘（曾经的 bug：只把路径写进历史，文件不存在）
    requests.length = 0
    const outDir = new URL('../.tmp/apiz-out/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')
    const custom = await runGenerate({ prompt: 'custom path', size: '1024x1024', referenceImages: [REF_PNG_PATH], outputPath: join(outDir, 'nested', 'mine.jpg') })
    assert.ok(fileExists(custom.file), `outputPath 没落盘：${custom.file}`)
    assert.ok(custom.file.endsWith('.png'), `非 png 扩展名应被纠正：${custom.file}`)
    assert.ok(custom.warnings?.some((w) => w.includes('.png')), '扩展名被纠正时应有提醒')
    const createCustom = requests.find((r) => r.url === '/api/v3/tasks/create')
    assert.equal(createCustom.body.params.width, 1024)
    assert.equal(createCustom.body.params.height, 1024)
    clearHistory()
  })
})

await test('apiz 任务失败 / 轮询超时：报错可读且提示不要重投', async () => {
  await withMockServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url === '/api/v3/tasks/create') {
        res.end(JSON.stringify({ code: 200, data: { task_id: 'task_fail', price: 10 } }))
        return
      }
      res.end(JSON.stringify({ code: 200, data: { status: 'failed', error: '上游拒绝：内容违规' } }))
    })
  }, async (url) => {
    configRef.config = { imageProvider: 'apiz', imageApiUrl: url, imageApiKey: 'sk', timeoutSeconds: 5, imagePollSeconds: 0.01 }
    await assert.rejects(() => runGenerate({ prompt: 'x', referenceImages: [REF_PNG_PATH] }), /apiz 任务失败.*内容违规.*task_fail/)
  })

  // 轮询一直 processing → 超时报错里必须包含「不要重新提交」
  await withMockServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url === '/api/v3/tasks/create'
        ? { code: 200, data: { task_id: 'task_slow' } }
        : { code: 200, data: { status: 'processing' } }))
    })
  }, async (url) => {
    configRef.config = { imageProvider: 'apiz', imageApiUrl: url, imageApiKey: 'sk', timeoutSeconds: 1, imagePollSeconds: 0.05 }
    await assert.rejects(() => runGenerate({ prompt: 'x', referenceImages: [REF_PNG_PATH] }), (err) => {
      assert.match(err.message, /轮询超时/)
      assert.match(err.message, /不要重新提交/)
      assert.match(err.message, /task_slow/)
      return true
    })
  })
})

await test('apiz：报错体 detail 直接冒到工具层 + 超过 1 张/遮罩明确拒绝', async () => {
  await withMockServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'prompt 必填且长度为 1–7000 字符' }))
    })
  }, async (url) => {
    configRef.config = { imageProvider: 'apiz', imageApiUrl: url, imageApiKey: 'sk', timeoutSeconds: 5 }
    await assert.rejects(() => runGenerate({ prompt: 'x', referenceImages: [REF_PNG_PATH] }), /prompt 必填且长度为 1–7000 字符/)
  })

  await assert.rejects(
    () => generateImage({ prompt: 'x', size: '2048x2048', n: 2 }, { provider: 'apiz', apiKey: 'sk', model: 'apiz/gpt-image-2.5-flare' }),
    /一次只出一张图/,
  )
})

// ---------------------------------------------------------------- 杂项

await test('OpenRouter 识别 + API URL 拼接 + data URL 字节数', () => {
  assert.equal(isOpenRouterBaseUrl('https://openrouter.ai/api/v1'), true)
  assert.equal(isOpenRouterBaseUrl('https://api.openai.com/v1'), false)
  assert.equal(buildApiUrl('https://api.openai.com/v1', 'images/generations'), 'https://api.openai.com/v1/images/generations')
  assert.equal(buildApiUrl('https://ark.cn-beijing.volces.com/api/v3', 'images/generations', { prefixV1: false }), 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
  assert.equal(buildApiUrl('https://example.com', 'responses'), 'https://example.com/v1/responses')
  assert.equal(getDataUrlEncodedByteSize('data:image/png;base64,aGVsbG8='), 5)
  assert.equal(DEFAULT_IMAGES_MODEL, 'gpt-image-2')
})

await test('工具注册表：7 个工具、命名规范、参数 schema', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    'amz_generate', 'amz_history', 'amz_plan', 'amz_prompt', 'amz_slots', 'amz_tag_performer', 'amz_validate_plan',
  ].sort())
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 40, `${tool.name} 描述要够长`)
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
  }
})

// ---------------------------------------------------------------- 汇总

console.log(`\n通过 ${passed} 个用例`)
if (failures.length) {
  console.error(`失败 ${failures.length} 个`)
  process.exit(1)
}
