// HTTP 半边验收：不启动真宿主，把 registerApi 的 handler 挂到一个本地 http 服务上，
// 用真实 fetch 打每个接口（页面 / 状态 / meta / 策划档案 / 校验 / 组装 / 生图 / 打标 / media / 越界）。
// 用法：node scripts/api-test.mjs
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../.tmp/api-test/', import.meta.url))
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
process.env.DSH_HOME = join(ROOT, 'home')
// ！验收脚本不许打真接口：apiz 适配器会复用「环境变量 / 本机 apiz CLI 登录态」的 Key，先把两条路堵死
process.env.APIZ_API_KEY = ''
process.env.APIZ_CONFIG = join(ROOT, 'no-such-apiz-config.toml')
process.env.APIZ_BIN = join(ROOT, 'no-such-apiz-bin')

const { registerApi } = await import('../lib/api.js')
const { getAmazonListingImageSlots } = await import('../lib/planner/slots.js')
const { DATA_DIR, readHistory, listPlans, listReferences, addHistoryRecord, clearHistory, saveImage } = await import('../lib/data.js')
const { configRef } = await import('../lib/tools.js')

// 未配置 Key：策划走 agentNeeded、生图报错，正好覆盖兜底分支
configRef.config = {}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let handler = null
const ctx = { webServer: { register(cfg) { handler = cfg.handler; return () => {} } } }
registerApi(ctx)
if (!handler) throw new Error('registerApi 没注册 handler')

const server = createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}/amazon-image-studio`

async function get(path) {
  const res = await fetch(BASE + path)
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }
}
async function post(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, text: await res.text() }
}
const json = (r) => { try { return JSON.parse(r.text) } catch { return null } }

function makeListingPayload(count = 7) {
  const slots = getAmazonListingImageSlots(count)
  return {
    product: { title: '测试保温杯 500ml', category: 'Home & Kitchen', brand: 'TestBrand', color: '白色', material: '不锈钢', audience: '通勤人群', packageIncludes: '杯子, 杯刷' },
    sellingPoints: ['12 小时保温', '食品级不锈钢', '一键开盖'],
    seriesStyleGuide: 'Consistent clean product photography across the series.',
    imagePlans: slots.map((slot, index) => ({
      slot,
      label: `方案${index + 1}`,
      planMarkdown: `第 ${index + 1} 张的策划中文说明。`,
      prompt: `Professional Amazon product image for slot ${slot}, pure white background product photography.`,
      negativePrompt: 'no amazon logo, no price, no review stars',
    })),
  }
}

try {
  // ---- 基础接口
  const ping = await get('/api/ping')
  const pingBody = json(ping)
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  check('ping 200 + 版本号', ping.status === 200 && pingBody?.version === pkgVersion, `${pingBody?.version} / package=${pkgVersion}`)

  const status = await get('/api/status')
  const statusBody = json(status)
  check('status：未配 Key 时 image.configured=false', statusBody?.ok === true && statusBody.image.configured === false, `dataDir=${statusBody?.dataDir}`)
  check('status：策划固定走对话（无 API 字段）', statusBody?.planner?.mode === 'chat' && !('apiKey' in (statusBody?.planner ?? {})), JSON.stringify(statusBody?.planner))
  check('status：Key 脱敏字段存在', typeof statusBody?.image.apiKey === 'string')
  check('status：默认 apiz / 2K / low（低配省钱）', statusBody?.image.provider === 'apiz' && statusBody?.image.outputTier === '2K' && statusBody?.image.quality === 'low', `${statusBody?.image.provider}/${statusBody?.image.outputTier}/${statusBody?.image.quality}`)
  check('status：无 Key 时 keySource=none', statusBody?.image.keySource === 'none', statusBody?.image.keySource)
  check('status：默认强制参考图', statusBody?.image.requireReferenceImages === true)

  const meta = json(await get('/api/meta'))
  check('meta：Listing 7-12 档位', meta?.ok === true && meta.meta.listing.countOptions.length === 6 && meta.meta.listing.defaultCount === 7, JSON.stringify(meta?.meta?.listing?.countOptions))
  check('meta：四套 A+ 类型', meta?.meta?.aplusTypes?.length === 4, meta?.meta?.aplusTypes?.map((t) => t.type).join(','))
  check('meta：6 站点', meta?.meta?.marketplaces?.length === 6, meta?.meta?.marketplaces?.map((m) => m.id).join(','))
  check('meta：4 套风格预设带色卡', meta?.meta?.stylePresets?.length === 4 && meta.meta.stylePresets.every((p) => p.paletteEntries.length === 6), meta?.meta?.stylePresets?.map((p) => p.id).join(','))
  check('meta：合规清单非空', (meta?.meta?.compliance?.listing?.length ?? 0) > 0 && (meta?.meta?.compliance?.aplus?.length ?? 0) > 0)

  // ---- 静态页面
  const page = await get('/')
  check('静态页面：index.html', page.status === 200 && page.type.includes('html') && page.text.includes('亚马逊'), `${page.status} ${page.type}`)
  const css = await get('/app.css')
  check('静态页面：app.css', css.status === 200 && css.type.includes('css'), css.type)
  const js = await get('/app.js')
  check('静态页面：app.js', js.status === 200 && js.text.length > 10000, `${js.text.length} 字节`)
  const traversal = await get('/..%2f..%2fpackage.json')
  check('静态页面：越界被拒', traversal.status === 404, String(traversal.status))
  const dotfile = await get('/.git/config')
  check('静态页面：点文件被拒', dotfile.status === 404, String(dotfile.status))

  // ---- 风格预设板经 media 出去
  const preset = json(await get('/api/meta')).meta.stylePresets[0]
  const presetPath = decodeURIComponent(preset.image.split('path=')[1])
  const presetRes = await fetch(BASE + '/media?path=' + encodeURIComponent(presetPath))
  check('media：风格预设板 PNG 可读', presetRes.status === 200 && (presetRes.headers.get('content-type') || '').includes('png'), `${presetRes.status}`)
  const escaped = await fetch(BASE + '/media?path=' + encodeURIComponent('C:\\Windows\\win.ini'))
  check('media：白名单外路径被拒', escaped.status === 404, String(escaped.status))

  // ---- 策划：只出自策划指引（没有策划 API 了）
  const guideRes = await post('/api/plan/guide', { listingText: '保温杯 500ml 12小时保温', mode: 'listing', listingImageCount: 7 })
  const guideBody = json(guideRes)
  check('plan/guide：返回自策划指引', guideRes.status === 200 && guideBody?.agentPlanning?.slots?.length === 7 && !('plannerApiUrl' in guideBody.agentPlanning), `${guideBody?.agentPlanning?.slots?.length} 槽位`)
  const legacyCreate = await post('/api/plan/create', { listingText: 'x' })
  check('plan/create 已下线', legacyCreate.status === 404 || legacyCreate.status === 405, String(legacyCreate.status))

  // ---- 校验存档
  const validated = await post('/api/validate', { payload: makeListingPayload(7), mode: 'listing', marketplaceId: 'us', listingImageCount: 7 })
  const validatedBody = json(validated)
  check('validate：合法策划存档拿到 planId', validated.status === 200 && typeof validatedBody?.plan?.id === 'string', validatedBody?.plan?.id)
  const planId = validatedBody?.plan?.id

  const badPayload = await post('/api/validate', { payload: (() => { const p = makeListingPayload(7); p.imagePlans = p.imagePlans.slice(0, 5); return p })(), mode: 'listing', listingImageCount: 7 })
  check('validate：槽位数量不符被拒', badPayload.status === 400 && /7 张/.test(json(badPayload)?.error || ''), json(badPayload)?.error)
  const noTitle = await post('/api/validate', { payload: { imagePlans: makeListingPayload(7).imagePlans }, mode: 'listing', listingImageCount: 7 })
  check('validate：缺商品标题被拒', noTitle.status === 400, json(noTitle)?.error)

  // ---- 档案列表 / 详情 / 删除
  const plans = json(await get('/api/plans'))
  check('plans：档案已列出', plans?.ok === true && plans.plans.length >= 1 && plans.plans[0].slotCount === 7, `count=${plans?.plans?.length}`)
  const detail = json(await get('/api/plan?id=' + encodeURIComponent(planId)))
  check('plan 详情：含 7 个槽位', detail?.ok === true && detail.plan.plans.length === 7, `${detail?.plan?.plans?.length}`)
  check('plan 详情：带成品图数组（无图时为空）', Array.isArray(detail?.images) && detail.images.length === 0, `${detail?.images?.length}`)
  check('plans 列表：带五点卖点与已生成数', plans.plans[0].bullets.length === 3 && plans.plans[0].generatedCount === 0 && plans.plans[0].cover === null, `bullets=${plans.plans[0].bullets.length}`)
  // 造一条成品图记录 → 详情与列表都要能带出来（面板「策划档案」靠这个显示封面/成品图）
  const genFile = saveImage(Buffer.from('fake-png-bytes'), 'png')
  addHistoryRecord({ id: 'gen-api-test', kind: 'generate', planId, slot: 'MAIN', file: genFile, createdAt: new Date().toISOString(), actualSize: '2048x2048' })
  const detailWithImage = json(await get('/api/plan?id=' + encodeURIComponent(planId)))
  check('plan 详情：成品图带可预览 URL', detailWithImage?.images?.length === 1 && /^\/amazon-image-studio\/media\?path=/.test(detailWithImage.images[0].url) && detailWithImage.images[0].exists === true, detailWithImage?.images?.[0]?.slot)
  const plansWithImage = json(await get('/api/plans'))
  const row = plansWithImage.plans.find((p) => p.id === planId)
  check('plans 列表：封面与已生成数同步', row.cover === genFile && row.generatedCount === 1, `cover=${row?.cover ? '有' : '无'}`)
  clearHistory()
  const missing = await get('/api/plan?id=nope')
  check('plan 详情：不存在 404', missing.status === 404, String(missing.status))

  // ---- Prompt 组装
  const composed = json(await post('/api/compose', { planId, slot: 'MAIN' }))
  check('compose MAIN：不挂风格板', composed?.ok === true && composed.styleReferenceAttached === false && composed.prompt.length > 40, `attached=${composed?.styleReferenceAttached} size=${composed?.generationSize}`)
  const composedPt = json(await post('/api/compose', { planId, slot: 'PT01', stylePresetId: 'clean-tech' }))
  check('compose PT01：挂风格板 + 密度指令', composedPt?.ok === true && composedPt.styleReferenceAttached === true && /highest priority|STYLE/i.test(composedPt.prompt), `attached=${composedPt?.styleReferenceAttached}`)
  const composedBad = await post('/api/compose', { planId, slot: 'NOPE' })
  check('compose：非法槽位 400', composedBad.status === 400, String(composedBad.status))

  // ---- 生图门槛：没有参考图必须被拒（先把 Key 配上一个假的）
  configRef.config = { imageApiKey: 'sk-fake-for-gate', imageProvider: 'apiz' }
  const noRef = await post('/api/generate', { prompt: 'no reference at all' })
  check('generate：没参考图直接拒绝', noRef.status === 400 && /必须提供产品参考图/.test(json(noRef)?.error || ''), json(noRef)?.error?.slice(0, 40))
  configRef.config = {}

  // ---- 生图：未配 Key 报错（Key 校验先于参考图门槛）
  const gen = await post('/api/generate', { planId, slot: 'MAIN' })
  const genBody = json(gen)
  check('generate 未配 Key：400 + 可读错误', gen.status === 400 && /Key|key/.test(genBody?.error || ''), genBody?.error?.slice(0, 60))

  // ---- 打标
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' + '0d0a2db4' + '0000000049454e44ae426082', 'hex')
  const tagged = await post('/api/tag', { files: [{ name: 'a.png', data: png.toString('base64') }] })
  const taggedBody = json(tagged)
  check('tag：PNG 打标成功并给下载链接', taggedBody?.ok === true && taggedBody.tagged === 1 && /^\/amazon-image-studio\/media\?path=/.test(taggedBody.results[0].download), taggedBody?.results?.[0]?.status)
  const taggedPath = decodeURIComponent(taggedBody.results[0].download.split('path=')[1].split('&')[0])
  const download = await fetch(BASE + '/media?path=' + encodeURIComponent(taggedPath))
  check('tag：产物可下载 + XMP 已写入', download.status === 200 && (await download.arrayBuffer()).byteLength > png.length, String(download.status))
  const retag = json(await post('/api/tag', { files: [{ name: 'a.png', data: png.toString('base64') }] }))
  check('tag：未打标源文件再来一次仍打标', retag?.ok === true && retag.tagged === 1)
  const badTag = await post('/api/tag', { files: [{ name: 'a.gif', data: png.toString('base64') }] })
  check('tag：不支持的格式计入 failed', json(badTag)?.failed === 1)

  // ---- 设置（读 / 写；stub ctx 没有 config-editor，写要给出可读错误）
  const settingsRes = json(await get('/api/settings'))
  check('settings：读出 apiz 默认值（Key 脱敏）', settingsRes?.ok === true && settingsRes.settings.image.quality === 'low' && settingsRes.settings.image.apiKey === '', `${settingsRes?.settings?.image?.quality}`)
  check('settings：无 config-editor 时 available=false', settingsRes?.settings?.available === false)
  const saveWithoutEditor = await post('/api/settings', { imageQuality: 'medium' })
  check('settings：没有 config-editor 时保存报可读错误', saveWithoutEditor.status === 400 && /config-editor/.test(json(saveWithoutEditor)?.error || ''), json(saveWithoutEditor)?.error)
  const badQuality = await post('/api/settings', { imageQuality: 'ultra' })
  check('settings：非法质量档位拒绝', badQuality.status === 400 && /low \/ medium/.test(json(badQuality)?.error || ''), json(badQuality)?.error)
  const unknownField = await post('/api/settings', { evilField: 1 })
  check('settings：白名单外字段拒绝', unknownField.status === 400 && /没有任何可保存的字段/.test(json(unknownField)?.error || ''), json(unknownField)?.error)

  // ---- 参考图上传（面板拖文件 → 落盘 → 生图时当 referenceImages）
  const pngDataUrl = `data:image/png;base64,${png.toString('base64')}`
  const upload = await post('/api/upload', { files: [{ name: 'front.png', data: pngDataUrl }] })
  const uploadBody = json(upload)
  check('upload：PNG data URL 落盘并回预览 URL', uploadBody?.ok === true && uploadBody.files.length === 1 && /^\/amazon-image-studio\/media\?path=/.test(uploadBody.files[0].url), uploadBody?.files?.[0]?.path)
  const refPath = uploadBody?.files?.[0]?.path
  check('upload：落在 references 目录', typeof refPath === 'string' && refPath.includes(`references`), refPath)
  const refFile = await fetch(BASE + '/media?path=' + encodeURIComponent(refPath))
  check('upload：参考图可预览', refFile.status === 200, String(refFile.status))
  const refList = json(await get('/api/references'))
  check('references：列表回显', refList?.ok === true && refList.files.some((f) => f.path === refPath), `${refList?.files?.length} 张`)
  const badUpload = await post('/api/upload', { files: [{ name: 'x.gif', data: 'data:image/gif;base64,R0lGODlh' }] })
  check('upload：非 PNG/JPG/WebP 拒绝', badUpload.status === 400, String(badUpload.status))
  const emptyUpload = await post('/api/upload', { files: [] })
  check('upload：空数组拒绝', emptyUpload.status === 400, String(emptyUpload.status))
  const escapedRef = json(await post('/api/references/remove', { path: join(ROOT, 'nope.png') }))
  check('references/remove：目录外路径拒绝', escapedRef?.ok === false, String(escapedRef?.ok))
  const removedRef = json(await post('/api/references/remove', { path: refPath }))
  check('references/remove：真删掉', removedRef?.ok === true && listReferences().length === 0)
  const goneRef = await fetch(BASE + '/media?path=' + encodeURIComponent(refPath))
  check('references/remove：删除后 media 404', goneRef.status === 404, String(goneRef.status))

  // ---- 历史
  check('history：生图历史为空（未成功生图）', json(await get('/api/history')).list.length === 0)
  const clear = json(await post('/api/history/clear', {}))
  check('history/clear 正常', clear?.ok === true)

  // ---- 删除档案
  const beforeRemove = listPlans().length
  const removed = json(await post('/api/plans/remove', { id: planId }))
  check('plans/remove：真删掉这个档案', removed?.ok === true && !listPlans().some((p) => p.id === planId) && listPlans().length === beforeRemove - 1, `剩余 ${listPlans().length}/${beforeRemove}`)
  const removedAgain = json(await post('/api/plans/remove', { id: planId }))
  check('plans/remove：重复删 404', removedAgain?.ok === false)

  // ---- 方法与来源防护
  const wrongMethod = await fetch(BASE + '/api/validate', { method: 'GET' })
  check('GET 打 POST 接口：405/404', wrongMethod.status === 404 || wrongMethod.status === 405, String(wrongMethod.status))
  const wrongType = await fetch(BASE + '/api/validate', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
  check('非 JSON 请求体：415', wrongType.status === 415, String(wrongType.status))
  const crossOrigin = await fetch(BASE + '/api/validate', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })
  check('跨源 POST：403', crossOrigin.status === 403, String(crossOrigin.status))
  const unknown = await get('/api/nope')
  check('未知 /api 路径：404 json', unknown.status === 404 && json(unknown)?.ok === false)
} finally {
  server.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.log('失败：\n' + failed.map((f) => `  - ${f.name} (${f.detail})`).join('\n'))
  process.exit(1)
}
