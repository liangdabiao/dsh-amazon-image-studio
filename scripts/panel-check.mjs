// 面板 UI 验收（离线、可重复）：起一个本地 http 服务挂上真实的 registerApi，
// 用 Playwright 无头浏览器打开面板，逐页断言「策划档案 / 档案详情 / 生成历史」的内容、
// 图片是否真的加载、点击是否真的生效，并截图到 .tmp/panel-shots/。
//
//   node scripts/panel-check.mjs
//
// 依赖：playwright（本机 profile 里有就直接用；找不到就打印跳过，不影响 npm run verify）。
// 数据：全部写在 .tmp/panel-check/home，不碰真实 DSH_HOME。
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../.tmp/panel-check/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../.tmp/panel-shots/', import.meta.url))
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })
process.env.DSH_HOME = join(ROOT, 'home')
process.env.APIZ_API_KEY = ''
process.env.APIZ_CONFIG = join(ROOT, 'no-apiz-config.toml')
process.env.APIZ_BIN = join(ROOT, 'no-apiz-bin')

const { registerApi } = await import('../lib/api.js')
const { addHistoryRecord, clearHistory, ensureDirs, listPlans, saveImage } = await import('../lib/data.js')
const { runValidatePlan } = await import('../lib/tools.js')
const { getAmazonListingImageSlots } = await import('../lib/planner/slots.js')

// ---------------------------------------------------------------- 造一套可断言的档案 + 成品图
ensureDirs()
clearHistory()
const BULLETS = ['12 小时保温', '食品级不锈钢内胆', '一键开盖单手可操作', '500ml 通勤容量', '杯刷随包附赠']
const archive = runValidatePlan({
  mode: 'listing',
  marketplaceId: 'us',
  listingImageCount: 7,
  listingText: '测试保温杯 500ml，12 小时保温，食品级不锈钢',
  payload: {
    product: { title: 'UI 验收保温杯 500ml', category: 'Home & Kitchen', brand: 'TestBrand', color: '白色', material: '不锈钢' },
    sellingPoints: BULLETS,
    seriesStyleGuide: 'Consistent clean product photography across the series.',
    imagePlans: getAmazonListingImageSlots(7).map((slot, index) => ({
      slot,
      label: `方案${index + 1}`,
      planMarkdown: `${slot} 的中文策划说明：这张图要证明什么。`,
      prompt: `Professional Amazon product image for slot ${slot}, pure white background.`,
      negativePrompt: 'no price, no logo',
    })),
  },
})
const generatedFiles = []
for (const slot of ['MAIN', 'PT01']) {
  const file = saveImage(copyOfFixture(), 'png')
  generatedFiles.push(file)
  addHistoryRecord({
    id: `gen-panel-${slot}`,
    kind: 'generate',
    planId: archive.id,
    slot,
    file,
    generationSize: '2048x2048',
    actualSize: '2048x2048',
    quality: 'low',
    provider: 'apiz',
    model: 'apiz/gpt-image-2.5-flare',
    price: 21,
    referenceCount: 1,
    referenceSource: 'panel',
    createdAt: new Date().toISOString(),
  })
}

function copyOfFixture() {
  // 用随包风格板当"成品图"：真 PNG 字节，浏览器能真的解码出来
  return readFileSync(fileURLToPath(new URL('../assets/style-presets/clean-tech.png', import.meta.url)))
}

// ---------------------------------------------------------------- 起服务 + 打开浏览器
let handler = null
registerApi({ webServer: { register(cfg) { handler = cfg.handler; return () => {} } } })
const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/amazon-image-studio/`

const playwright = await loadPlaywright()
if (!playwright) {
  console.log('跳过面板 UI 验收：本机没有可用的 playwright（npm i -D playwright 或设 PLAYWRIGHT_MODULE 指向它）')
  server.close()
  process.exit(0)
}

const browser = await playwright.chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })

const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`) }

await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForTimeout(300)

// ---- 策划档案
await page.goto(`${base}#/plans`, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
check('策划档案：卡片渲染', await page.locator('.plan-card').count() === listPlans().length, `${await page.locator('.plan-card').count()}`)
check('策划档案：显示五点卖点', await page.locator('.plan-card .plan-bullets li').count() === 5)
check('策划档案：封面图加载', await page.evaluate(() => [...document.querySelectorAll('.plan-cover:not(.plan-cover-empty)')].every((i) => i.complete && i.naturalWidth > 0)))
check('策划档案：显示已生成张数', (await page.locator('.plan-card .meta').last().textContent()).includes('已生成 2 张'))
await page.screenshot({ path: join(SHOTS, 'plans.png'), fullPage: true })

// ---- 档案详情
await page.locator('.plan-card').first().locator('[data-act="detail"]').click()
await page.waitForTimeout(500)
check('档案详情：路由进入 #/plans/<id>', page.url().includes(`#/plans/${archive.id}`), page.url().split('#')[1])
check('档案详情：五点卖点', await page.locator('.card').first().locator('.plan-bullets li').count() === 5)
check('档案详情：成品图 2 张', await page.locator('.gen-cell img').count() === 2)
check('档案详情：成品图加载', await page.evaluate(() => [...document.querySelectorAll('.gen-cell img')].every((i) => i.complete && i.naturalWidth > 0)))
check('档案详情：每张成品图都有下载链接', await page.locator('.gen-cell figcaption a[download]').count() === 2)
check('档案详情：逐槽位策划 7 行', await page.locator('.plan-slot').count() === 7)
const imgBtn = page.locator('[data-img]').first()
const wantName = (await imgBtn.getAttribute('data-img')).split(/[\\/]/).pop()
await imgBtn.click()
await page.waitForTimeout(250)
const viewerSrc = decodeURIComponent(await page.locator('#viewer-body img').getAttribute('src'))
check('档案详情：点「看这张图」打开同一张', viewerSrc.includes(wantName), wantName)
await page.locator('#viewer-close').click()
await page.waitForTimeout(150)
await page.screenshot({ path: join(SHOTS, 'plan-detail.png'), fullPage: true })

// ---- 「在策划台打开」要把档案带回策划台
await page.locator('#open-in-studio').click()
await page.waitForTimeout(500)
check('在策划台打开：回到策划台', await page.locator('#btn-plan').count() === 1)
check('在策划台打开：槽位卡片已渲染', await page.locator('.slot-card').count() === 7, `${await page.locator('.slot-card').count()}`)
await page.screenshot({ path: join(SHOTS, 'home-opened.png'), fullPage: true })

// ---- 生成历史
await page.goto(`${base}#/gallery`, { waitUntil: 'networkidle' })
await page.waitForTimeout(400)
check('生成历史：两条记录', await page.locator('#history-list .list-item').count() === 2)
check('生成历史：缩略图加载', await page.evaluate(() => [...document.querySelectorAll('#history-list img.thumb')].every((i) => i.complete && i.naturalWidth > 0)))
check('生成历史：显示积分与实际尺寸', (await page.locator('#history-list .list-item').first().textContent()).includes('21 积分'))
check('生成历史：有下载按钮', await page.locator('#history-list a[download]').count() === 2)
// 真点一次下载，标题要落在图片文件名上（说明服务端回了 attachment）
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }),
  page.locator('#history-list a[download]').first().click(),
])
check('生成历史：点下载真的触发下载', /\.png$/.test(download.suggestedFilename()), download.suggestedFilename())
await page.screenshot({ path: join(SHOTS, 'gallery.png'), fullPage: true })

check('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
server.close()

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过（截图：${SHOTS}）`)
if (failed.length) {
  console.log('失败：\n' + failed.map((f) => `  - ${f.name} (${f.detail})`).join('\n'))
  process.exit(1)
}

async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    join(process.env.DSH_PROFILE_DIR ?? '', 'node_modules/playwright/index.js'),
    'C:/Users/' + (process.env.USERNAME ?? '') + '/.dsh/profiles/desktop/node_modules/playwright/index.js',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate.startsWith('.') || /^[A-Za-z]:/.test(candidate) || candidate.startsWith('file:')
        ? (candidate.startsWith('file:') ? candidate : `file:///${candidate.replace(/\\/g, '/')}`)
        : candidate)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium) return { chromium }
    } catch { /* 试下一个 */ }
  }
  return null
}

