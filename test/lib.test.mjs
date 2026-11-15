// dsh-amazon-image-studio 单测：node test/lib.test.mjs 直接跑（Windows 下不用 node --test）。
// 数据目录指向工作区 .tmp/，不碰系统 Temp；mock 策划/生图 API 用本地 node:http 随机端口。
process.env.DSH_HOME = new URL('../.tmp/test-home/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

import assert from 'node:assert/strict'
import { createServer } from 'node:http'

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
  amzSlotsTool, amzValidatePlanTool, amzHistoryTool, plannerConfigured, imageConfigured, runGenerate,
} = await import('../lib/tools.js')
const {
  savePlan, loadPlan, listPlans, removePlan, addHistoryRecord, readHistory,
  removeHistoryRecord, clearHistory, saveImage, fileExists, DATA_DIR,
} = await import('../lib/data.js')
const {
  verifySyntheticPerformerTag, tagSyntheticPerformerBytes, checkSyntheticPerformerBytes,
} = await import('../lib/tagger.js')
const { generateImage } = await import('../lib/image/index.js')
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
  await assert.rejects(() => runGenerate({ prompt: 'x' }), /未配置生图 API Key/)
  assert.equal(normalizeAliyunQwenImageSize('4096x4096'), '2048*2048')
  assert.equal(normalizeAliyunQwenImageSize('512x512'), '512*512')
  assert.ok(createAliyunQwenImageEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1').includes('/services/aigc/multimodal-generation/generation'))
  assert.equal(isAliyunApiBaseUrl('https://dashscope.aliyuncs.com/api/v1'), true)
  assert.equal(isAliyunApiBaseUrl('https://api.openai.com/v1'), false)
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
