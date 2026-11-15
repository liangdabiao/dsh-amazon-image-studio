// 离线自检：不开宿主、零网络零 Key。检查随包资产完整性、skill provider、
// 策划引擎关键路径、面板静态资源、API 路由表可构造。
process.env.DSH_HOME = new URL('../.tmp/selftest-home/', import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:')

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
let failed = 0

function check(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

console.log('dsh-amazon-image-studio selftest ·', ROOT)

// ---------------------------------------------------------------- 随包资产

check('骨架文件齐全', () => {
  for (const file of ['package.json', 'cordis.patch.yml', 'index.js', 'client.js', 'icon.svg', 'locale/zh.json', 'locale/en.json', 'LICENSE', 'README.md']) {
    assert.ok(existsSync(join(ROOT, file)), `缺 ${file}`)
  }
})

check('cordis id 与 host name 一致', async () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const host = await import('../index.js')
  assert.ok(patch.includes('id: amazon-image-studio'))
  assert.equal(host.name, 'amazon-image-studio')
})

check('风格预设板 4 张 PNG 在位', () => {
  const dir = join(ROOT, 'assets', 'style-presets')
  const files = readdirSync(dir)
  for (const name of ['clean-tech.png', 'natural-warm.png', 'premium-contrast.png', 'bright-retail.png']) {
    assert.ok(files.includes(name), `缺 ${name}`)
    assert.ok(statSync(join(dir, name)).size > 30_000, `${name} 尺寸异常`)
  }
})

check('lab 三件套在位', () => {
  for (const file of ['lab/index.html', 'lab/app.css', 'lab/app.js']) {
    assert.ok(existsSync(join(ROOT, file)), `缺 ${file}`)
    assert.ok(statSync(join(ROOT, file)).size > 500, `${file} 尺寸异常`)
  }
})

check('lab 静态资源不发根绝对请求（api()/post() 统一带 BASE 前缀）', () => {
  const source = readFileSync(join(ROOT, 'lab', 'app.js'), 'utf8')
  assert.ok(!/fetch\('\/api/.test(source), 'app.js 里直接 fetch("/api/…")（会打到宿主 API）')
  assert.ok(source.includes("const BASE = location.pathname"), '缺 BASE 前缀推导')
  assert.ok(statSync(join(ROOT, 'lab', 'app.js')).size > 500)
})

check('postMessage 消息类型全局一致（amazon-image-studio: 前缀）', () => {
  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  const appjs = readFileSync(join(ROOT, 'lab', 'app.js'), 'utf8')
  assert.ok(client.includes("'amazon-image-studio:start'"))
  assert.ok(client.includes("'amazon-image-studio:scheme'"))
  assert.ok(appjs.includes("'amazon-image-studio:start'"))
  assert.ok(appjs.includes("'amazon-image-studio:scheme'"))
  for (const [label, text] of [['client', client], ['app.js', appjs]]) {
    assert.ok(!text.includes('storyboard-director:'), `${label} 残留 storyboard-director 消息类型`)
  }
})

// ---------------------------------------------------------------- skill provider

check('skill provider：list/get + addendum + 占位符替换', async () => {
  const { createSkillProvider } = await import('../lib/skills.js')
  const provider = createSkillProvider([join(ROOT, 'skills')], ROOT)
  const list = await provider.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'amazon-image-studio')
  const skill = await provider.get(list[0])
  assert.ok(skill.content.includes('Amazon image-planning agent') || skill.content.includes('AI 策划'))
  assert.ok(skill.content.includes('在「亚马逊图片工作台」插件（DSH）里使用'), '缺 addendum')
  assert.ok(!skill.content.includes('<SKILL_ROOT>'), '占位符未替换')
})

// ---------------------------------------------------------------- 引擎关键路径

check('策划引擎：validate → compose（MAIN 不挂风格板，PT01 挂）', async () => {
  const { runValidatePlan, composeSlotPrompt } = await import('../lib/tools.js')
  const { getAmazonListingImageSlots } = await import('../lib/planner/slots.js')
  const slots = getAmazonListingImageSlots(7)
  const payload = {
    product: { title: '自检保温杯', category: '', brand: '', color: '', material: '', audience: '', packageIncludes: '' },
    sellingPoints: ['保温'],
    seriesStyleGuide: 'Consistent.',
    imagePlans: slots.map((slot) => ({ slot, label: '方案', planMarkdown: '中文说明', prompt: `Prompt for ${slot}`, negativePrompt: 'no price' })),
  }
  const archive = runValidatePlan({ payload, mode: 'listing', listingImageCount: 7 })
  const main = composeSlotPrompt(archive, 'MAIN')
  assert.equal(main.styleReferenceAttached, false)
  const pt = composeSlotPrompt(archive, 'PT01')
  assert.equal(pt.styleReferenceAttached, true)
  assert.ok(pt.prompt.includes('Expected output resolution:'))
})

check('打标引擎：最小 JPEG 写入并验证', async () => {
  const { tagSyntheticPerformerBytes, verifySyntheticPerformerTag } = await import('../lib/tagger.js')
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9])
  const tagged = tagSyntheticPerformerBytes(jpeg, 'x.jpg')
  assert.equal(verifySyntheticPerformerTag(tagged.bytes, 'x.jpg').valid, true)
})

check('工具注册表完整（7 个）', async () => {
  const { TOOLS } = await import('../lib/tools.js')
  assert.equal(TOOLS.length, 7)
})

// ---------------------------------------------------------------- 汇总

if (failed) {
  console.error(`\n自检失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n自检通过')
