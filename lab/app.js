// 亚马逊图片工作台 · 页面逻辑（无框架，hash 路由 + fetch /api/*）
// 策划台：Listing / A+ 双模式策划 → 逐槽位 Prompt 卡片 → 复制 / 生成 / 填进对话。
// 点「填进对话」时 postMessage 给宿主开新对话并填好指令（amazon-image-studio:start）。
const app = document.getElementById('app')
const navPlans = document.getElementById('nav-plans')
const navHistory = document.getElementById('nav-history')
const railFoot = document.getElementById('rail-foot')
const viewer = document.getElementById('viewer')
const viewerTitle = document.getElementById('viewer-title')
const viewerBody = document.getElementById('viewer-body')
const viewerCopy = document.getElementById('viewer-copy')
const toastEl = document.getElementById('toast')

// 页面挂在 /amazon-image-studio/ 下，接口也在同一前缀下。
// 不能用 '/api/...' 这种根绝对路径——那会打到宿主自己的 API 上。
const BASE = location.pathname.replace(/\/+$/, '') || '/amazon-image-studio'

const state = {
  status: null,
  meta: null,
  plan: null,           // 当前策划档案
  composing: {},        // slot -> compose 结果
  generated: {},        // slot -> { file }
  form: {
    mode: 'listing',
    marketplaceId: 'us',
    listingImageCount: 7,
    aplusType: 'standard-large',
    listingText: '',
    productTitle: '', brand: '', category: '', color: '', material: '',
    audience: '', packageIncludes: '', sellingPoints: '', forbidden: '',
    referenceImages: '',
    stylePresetId: 'clean-tech',
    tier: '2K',
    quality: 'low',
    styleDensityMode: 'rich',
  },
  history: [],
  plans: [],
  tagFiles: [],
  refs: [],             // 已上传的产品参考图 [{ name, path, size }]
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const shortTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const mediaUrl = (abs) => `${BASE}/media?path=${encodeURIComponent(abs)}`

async function api(path, opts) {
  const res = await fetch(BASE + path, opts)
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) throw new Error(body.error || `请求失败（${res.status}）`)
  return body
}

function post(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {})
  })
}

let toastTimer
function toast(msg) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600)
}

function copyText(text) {
  return navigator.clipboard?.writeText(text).then(
    () => toast('已复制'),
    () => fallbackCopy(text)
  ) ?? fallbackCopy(text)
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea')
  ta.value = text
  document.body.appendChild(ta)
  ta.select()
  try { document.execCommand('copy'); toast('已复制') } catch { toast('复制失败，请手动选择') }
  ta.remove()
}

function startInChat(prompt) {
  parent.postMessage({ type: 'amazon-image-studio:start', prompt }, location.origin)
}

function openViewer(title, bodyHtml, copyValue) {
  viewerTitle.textContent = title
  viewerBody.innerHTML = bodyHtml
  viewerCopy.hidden = !copyValue
  if (copyValue) viewerCopy.onclick = () => copyText(copyValue)
  viewer.hidden = false
}
function closeViewer() { viewer.hidden = true }
document.getElementById('viewer-close').onclick = closeViewer
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer() })

// ---------------------------------------------------------------- 数据加载

async function loadStatus() {
  state.status = await api('/api/status')
  renderRailFoot()
}
async function loadMeta() { state.meta = await api('/api/meta').then((r) => r.meta) }
async function loadPlans() {
  state.plans = (await api('/api/plans')).plans
  navPlans.textContent = state.plans.length || ''
}
async function loadHistory() {
  const r = await api('/api/history?limit=60')
  state.history = r.list
  navHistory.textContent = r.total || ''
}

function renderRailFoot() {
  const s = state.status
  if (!s) { railFoot.innerHTML = ''; return }
  const dot = (ok, warnWhen) => `<span class="dot ${ok ? 'ok' : warnWhen ? 'warn' : 'bad'}"></span>`
  railFoot.innerHTML = `
    <div>${dot(true, true)}策划：对话内完成（AI 策划 = 填进对话）</div>
    <div>${dot(s.image.configured, false)}生图：apiz · ${s.image.configured ? `${esc(s.image.quality || 'low')} / ${esc(s.image.outputTier || '2K')}` : '未配置（去「设置」填 Key）'}</div>
    <div>${dot(s.image.requireReferenceImages !== false, true)}参考图：${s.image.requireReferenceImages !== false ? '必须上传' : '可不传'}</div>
    <div style="margin-top:6px">v${esc(s.version)} · ${esc(s.dataDir)}</div>`
}

// ---------------------------------------------------------------- 表单

function formValue(id) {
  const el = document.getElementById(id)
  return el ? el.value.trim() : ''
}

function readForm() {
  const f = state.form
  f.mode = document.querySelector('input[name="mode"]:checked')?.value || 'listing'
  f.marketplaceId = formValue('f-market') || 'us'
  f.listingImageCount = Number(formValue('f-count')) || 7
  f.aplusType = formValue('f-aplus') || 'standard-large'
  f.listingText = document.getElementById('f-listing')?.value ?? ''
  for (const key of ['productTitle', 'brand', 'category', 'color', 'material', 'audience', 'packageIncludes', 'sellingPoints', 'forbidden']) {
    f[key] = formValue(`f-${key}`)
  }
  f.referenceImages = refPaths()
  f.stylePresetId = formValue('f-style') || 'clean-tech'
  f.tier = formValue('f-tier') || '2K'
  f.quality = formValue('f-quality') || 'low'
  f.styleDensityMode = formValue('f-density') || 'rich'
  return f
}

function writeForm() {
  const f = state.form
  const modeEl = document.querySelector(`input[name="mode"][value="${f.mode}"]`)
  if (modeEl) modeEl.checked = true
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v }
  set('f-market', f.marketplaceId); set('f-count', f.listingImageCount); set('f-aplus', f.aplusType)
  if (document.getElementById('f-listing')) document.getElementById('f-listing').value = f.listingText
  for (const key of ['productTitle', 'brand', 'category', 'color', 'material', 'audience', 'packageIncludes', 'sellingPoints', 'forbidden']) set(`f-${key}`, f[key])
  set('f-style', f.stylePresetId); set('f-tier', f.tier); set('f-density', f.styleDensityMode); set('f-quality', f.quality)
  syncModeVisibility()
}

function syncModeVisibility() {
  const mode = state.form.mode
  document.querySelectorAll('[data-mode-only]').forEach((el) => {
    el.hidden = el.dataset.modeOnly !== mode
  })
}

// ---------------------------------------------------------------- 视图：策划台

function renderHome() {
  const m = state.meta
  const f = state.form
  app.innerHTML = `
  <h2>策划台</h2>
  <div class="sub">粘贴 Listing 文案 → AI 策划逐张方案 → 逐槽位检查 Prompt → 生成（一次一张）。主图白底不挂风格板，附图/A+ 自动挂。</div>
  ${state.status && !state.status.image.configured ? `<div class="alert warn">还没配置 apiz Key：「生成」会被拒绝。去侧栏「设置」页填 Key 并保存（也可以打开「复用本机 apiz CLI 登录态」）。</div>` : ''}

  <div class="card">
    <div class="row" style="margin-bottom:12px">
      <label class="row" style="gap:4px"><input type="radio" name="mode" value="listing" ${f.mode === 'listing' ? 'checked' : ''}> Listing 图</label>
      <label class="row" style="gap:4px"><input type="radio" name="mode" value="aplus" ${f.mode === 'aplus' ? 'checked' : ''}> A+ 图</label>
      <span class="grow"></span>
      <label class="field" data-mode-only="listing" style="width:110px">目标站点
        <select id="f-market">${m.marketplaces.map((mk) => `<option value="${mk.id}">${mk.label}</option>`).join('')}</select>
      </label>
      <label class="field" data-mode-only="listing" style="width:96px">张数
        <select id="f-count">${m.listing.countOptions.map((n) => `<option value="${n}">${n} 张</option>`).join('')}</select>
      </label>
      <label class="field" data-mode-only="aplus" style="width:120px">A+ 类型
        <select id="f-aplus">${m.aplusTypes.map((t) => `<option value="${t.type}">${t.label}</option>`).join('')}</select>
      </label>
    </div>
    <div data-mode-only="aplus" id="aplus-modules" style="margin-bottom:10px"></div>
    <label class="field">Listing 文案（产品标题、五点描述、产品说明、品牌说明，直接粘贴）
      <textarea id="f-listing" class="tall" placeholder="Paste product title, 5 bullet points, description…"></textarea>
    </label>
    <div class="grid4" style="margin-top:10px">
      <label class="field">商品名<input id="f-productTitle" placeholder="可选"></label>
      <label class="field">品牌/型号<input id="f-brand" placeholder="可选"></label>
      <label class="field">类目<input id="f-category" placeholder="可选"></label>
      <label class="field">颜色<input id="f-color" placeholder="可选"></label>
      <label class="field">材质<input id="f-material" placeholder="可选"></label>
      <label class="field">目标人群<input id="f-audience" placeholder="可选"></label>
      <label class="field">包装清单<input id="f-packageIncludes" placeholder="可选"></label>
    </div>
    <div class="field" style="margin-top:10px">
      <div class="row" style="justify-content:space-between">
        <span>产品参考图（实拍 / 包装 / 结构图；生成时一起传给模型，主图也会带）</span>
        <span class="hint" id="ref-summary"></span>
      </div>
      <div class="dropzone" id="ref-dropzone" style="margin-top:8px;padding:16px">
        点击选择或拖入 JPG / PNG / WebP（可多选，最多 16 张）
        <input type="file" id="ref-input" multiple accept=".png,.jpg,.jpeg,.webp" hidden>
      </div>
      <div class="ref-grid" id="ref-list"></div>
    </div>
    <div class="grid2" style="margin-top:10px">
      <label class="field">卖点（每行一条）<textarea id="f-sellingPoints" rows="3" placeholder="可选"></textarea></label>
      <label class="field">不要出现的元素（每行一条）<textarea id="f-forbidden" rows="3" placeholder="可选"></textarea></label>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="btn-plan">✨ AI 策划</button>
      <span class="grow"></span>
      <label class="field" style="width:170px">风格板
        <select id="f-style">
          <option value="none">不挂风格板</option>
          ${m.stylePresets.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
        </select>
      </label>
      <label class="field" style="width:80px">档位
        <select id="f-tier"><option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option></select>
      </label>
      <label class="field" style="width:112px">质量
        <select id="f-quality">
          <option value="low">低（最省）</option>
          <option value="medium">中</option>
          <option value="high">高</option>
          <option value="xhigh">更高</option>
          <option value="max">最高</option>
        </select>
      </label>
      <label class="field" style="width:100px">版面密度
        <select id="f-density"><option value="rich">信息丰富</option><option value="minimal">简洁留白</option></select>
      </label>
    </div>
  </div>

  <div class="card" id="styles-card">
    <h3>风格预设（附图 / A+ 生图时的隐藏风格参考板；MAIN 主图不挂）</h3>
    <div class="style-grid">${m.stylePresets.map((p) => `
      <div class="style-card ${f.stylePresetId === p.id ? 'selected' : ''}" data-style="${p.id}">
        <img src="${p.image}" alt="${esc(p.label)}" loading="lazy">
        <div class="info">
          <b>${esc(p.label)}</b>
          <p>${esc(p.description)}</p>
          <div class="swatches">${p.paletteEntries.map((e) => `<span class="swatch" style="background:${e.color}" data-tip="${e.code} ${e.roleLabel}·${e.colorName} ${e.color}"></span>`).join('')}</div>
        </div>
      </div>`).join('')}
    </div>
  </div>

  <div id="plan-result"></div>`

  document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener('change', () => { state.form.mode = el.value; syncModeVisibility() }))
  document.getElementById('btn-plan').onclick = planViaChat
  bindRefUpload()
  document.querySelectorAll('.style-card').forEach((el) => {
    el.addEventListener('click', () => {
      state.form.stylePresetId = el.dataset.style
      document.querySelectorAll('.style-card').forEach((x) => x.classList.toggle('selected', x === el))
      const sel = document.getElementById('f-style')
      if (sel) sel.value = el.dataset.style
    })
  })
  renderAplusModules()
  writeForm()
  syncModeVisibility()
  if (state.plan) renderPlanResult(state.plan)
}

// ---------------------------------------------------------------- 产品参考图（上传 → 落盘 → 随生图一起传）

const REF_ACCEPT = /\.(png|jpe?g|webp)$/i
const REF_MAX_BYTES = 20 * 1024 * 1024
const REF_MAX_COUNT = 16

function refPaths() {
  return state.refs.map((item) => item.path)
}

function bindRefUpload() {
  bindRefUploadZone()
  renderRefList()
  // 恢复上次上传但没删的图（同机刷新不丢）
  if (!state.refs.length) loadExistingRefs()
}

// 用属性赋值而不是 addEventListener：上传完会重建 dropzone 的内容，
// 重复绑定会让一次拖拽触发多次上传。
function bindRefUploadZone() {
  const zone = document.getElementById('ref-dropzone')
  const input = document.getElementById('ref-input')
  if (!zone || !input) return
  zone.onclick = () => input.click()
  input.onchange = () => { addRefFiles([...input.files]); input.value = '' }
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('drag') }
  zone.ondragleave = () => zone.classList.remove('drag')
  zone.ondrop = (e) => {
    e.preventDefault()
    zone.classList.remove('drag')
    addRefFiles([...e.dataTransfer.files])
  }
}

async function loadExistingRefs() {
  try {
    const result = await api('/api/references')
    if (!result.files?.length) return
    state.refs = result.files.slice(0, REF_MAX_COUNT)
    renderRefList()
  } catch { /* 老宿主没有这个接口就静默跳过 */ }
}

function addRefFiles(files) {
  const usable = []
  for (const file of files) {
    if (!REF_ACCEPT.test(file.name)) { toast(`跳过不支持的格式：${file.name}`); continue }
    if (file.size > REF_MAX_BYTES) { toast(`${file.name} 超过 20MB，请先压缩`); continue }
    usable.push(file)
  }
  if (!usable.length) return
  const room = REF_MAX_COUNT - state.refs.length
  if (room <= 0) return toast(`最多 ${REF_MAX_COUNT} 张参考图`)
  void uploadRefs(usable.slice(0, room))
}

async function uploadRefs(files) {
  const zone = document.getElementById('ref-dropzone')
  if (zone) zone.textContent = `上传中…（${files.length} 张）`
  try {
    const payload = []
    for (const file of files) payload.push({ name: file.name, data: await readAsDataUrl(file) })
    const result = await post('/api/upload', { files: payload })
    state.refs = [...result.files, ...state.refs].slice(0, REF_MAX_COUNT)
    if (result.failed?.length) toast(`${result.failed.length} 张上传失败：${result.failed[0].error}`)
    else toast(`已上传 ${result.files.length} 张参考图`)
  } catch (err) {
    toast(`上传失败：${String(err.message || err)}`)
  } finally {
    const zone2 = document.getElementById('ref-dropzone')
    if (zone2) zone2.innerHTML = `点击选择或拖入 JPG / PNG / WebP（可多选，最多 ${REF_MAX_COUNT} 张）<input type="file" id="ref-input" multiple accept=".png,.jpg,.jpeg,.webp" hidden>`
    bindRefUploadZone()
    renderRefList()
  }
}

/** 用户点「生成」却被拦时，把上传区闪一下并滚到视野里，别让他到处找。 */
function highlightRefDropzone() {
  const zone = document.getElementById('ref-dropzone')
  if (!zone) return
  zone.scrollIntoView({ behavior: 'smooth', block: 'center' })
  zone.classList.add('need')
  setTimeout(() => zone.classList.remove('need'), 1600)
}

function renderRefList() {  const list = document.getElementById('ref-list')
  const summary = document.getElementById('ref-summary')
  if (summary) summary.textContent = state.refs.length ? `${state.refs.length} 张（生成时会一起传给模型）` : '未上传'
  if (!list) return
  list.innerHTML = state.refs.map((item) => `
    <div class="ref-card" data-path="${esc(item.path)}">
      <img src="${mediaUrl(item.path)}" alt="${esc(item.name)}" loading="lazy">
      <button class="ref-del" data-path="${esc(item.path)}" title="移除">×</button>
      <span class="ref-name" title="${esc(item.name)}">${esc(item.name)}</span>
    </div>`).join('')
  list.querySelectorAll('.ref-del').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation()
      const target = btn.dataset.path
      state.refs = state.refs.filter((item) => item.path !== target)
      renderRefList()
      try { await post('/api/references/remove', { path: target }) } catch { /* 文件已不在也不算错 */ }
    }
  })
  list.querySelectorAll('.ref-card img').forEach((img) => {
    img.onclick = () => {
      const card = img.closest('.ref-card')
      const item = state.refs.find((r) => r.path === card?.dataset.path)
      if (!item) return
      openViewer(item.name || '参考图', `<img src="${mediaUrl(item.path)}">`, mediaUrl(item.path))
    }
  })
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function renderAplusModules() {
  const holder = document.getElementById('aplus-modules')
  if (!holder) return
  const type = state.form.aplusType
  const info = state.meta.aplusTypes.find((t) => t.type === type)
  holder.innerHTML = info ? `<div class="row">${info.modules.map((mod) => `<span class="tag" title="${esc(mod.displayLabel)}">${esc(mod.slot)} ${esc(mod.label)} · ${esc(mod.uploadSize)}</span>`).join('')} <span class="hint">默认编排（策划前可在对话里让 agent 用 amz_slots 增删模块，1-${state.meta.maxAPlusModuleCount} 个）</span></div>` : ''
  const sel = document.getElementById('f-aplus')
  if (sel) sel.onchange = () => { state.form.aplusType = sel.value; renderAplusModules() }
}

function planViaChat() {
  const f = readForm()
  if (!f.listingText.trim()) return toast('先粘贴 Listing 文案')
  const m = state.meta
  const slots = f.mode === 'listing'
    ? `${f.listingImageCount} 张（MAIN + PT01-${String(f.listingImageCount - 1).padStart(2, '0')}）`
    : (m.aplusTypes.find((t) => t.type === f.aplusType)?.modules.map((s) => s.slot).join(', ') ?? f.aplusType)
  const instruction = [
    '请使用「亚马逊图片工作台」插件为我策划亚马逊商品图片：',
    `- 类型：${f.mode === 'listing' ? 'Listing 图' : 'A+ 图'}；站点：${m.marketplaces.find((x) => x.id === f.marketplaceId)?.label ?? ''}`,
    `- 槽位：${slots}`,
    '',
    'Listing 文案：',
    f.listingText,
    '',
    f.mode === 'listing'
      ? `策划完成后（amz_plan 或按指引自策划 + amz_validate_plan），逐槽位 amz_prompt 给我确认英文 Prompt，然后 amz_generate 一次一张生成（MAIN 白底不挂风格板）。`
      : `按 ${f.aplusType} 模块编排策划（amz_plan 或按指引自策划 + amz_validate_plan），逐槽位 amz_prompt 确认后 amz_generate 一次一张生成；Highlight Tile 的标题/正文文案单独输出。`,
  ].join('\n')
  startInChat(instruction)
  toast('已把策划指令填进新对话')
}

// ---------------------------------------------------------------- 策划结果渲染

function slotList(plan) {
  return plan.mode === 'aplus' ? plan.aPlusPlans : plan.plans
}

async function composeSlot(slot) {
  if (state.composing[slot]) return state.composing[slot]
  const f = state.form
  const result = await post('/api/compose', {
    planId: state.plan.id,
    slot,
    stylePresetId: f.mode === 'listing' ? f.stylePresetId : f.stylePresetId,
    tier: f.tier,
    styleDensityMode: f.styleDensityMode,
  })
  state.composing[slot] = result
  return result
}

function renderPlanResult(plan) {
  const holder = document.getElementById('plan-result')
  if (!holder) return
  const slots = slotList(plan)
  holder.innerHTML = `
  <div class="card">
    <div class="row" style="margin-bottom:8px">
      <span class="chip">${plan.mode === 'aplus' ? 'A+ 策划' : 'Listing 策划'}</span>
      <b>${esc(plan.parsed?.title ?? '')}</b>
      <span class="hint">${slots.length} 个槽位 · 档案 ${esc(plan.id)}</span>
      <span class="grow"></span>
      <button class="btn small ghost" id="btn-open-plan-json">查看策划 JSON</button>
    </div>
    ${plan.parsed?.bullets?.length ? `<div class="hint">卖点：${plan.parsed.bullets.map(esc).join(' · ')}</div>` : ''}
    ${plan.seriesStyleGuide ? `<details style="margin-top:6px"><summary class="hint">系列一致性指引（seriesStyleGuide，英文）</summary><div class="slot-prompt">${esc(plan.seriesStyleGuide)}</div></details>` : ''}
    ${plan.mode === 'aplus' && plan.aPlusType ? `<div class="hint">A+ 类型：${esc(plan.aPlusType)}</div>` : ''}
    <div id="slot-cards" style="margin-top:10px">
      ${slots.map((entry, index) => slotCardHtml(entry, index)).join('')}
    </div>
  </div>`

  document.getElementById('btn-open-plan-json').onclick = () => {
    openViewer(`策划 JSON · ${plan.id}`, `<pre>${esc(JSON.stringify(plan, null, 2))}</pre>`, JSON.stringify(plan, null, 2))
  }
  document.querySelectorAll('.slot-card').forEach((card) => {
    const slot = card.dataset.slot
    // 这里必须按槽位取回条目：以前直接用了外层 map 的变量，整个渲染会抛 ReferenceError
    const entry = slots.find((item) => item.slot === slot) ?? {}
    card.querySelector('.slot-head').onclick = () => card.classList.toggle('open')
    card.querySelector('[data-act="copy"]').onclick = async () => {
      const composed = await composeSlot(slot)
      copyText(composed.prompt)
    }
    card.querySelector('[data-act="preview"]').onclick = async () => {
      const composed = await composeSlot(slot)
      card.querySelector('.slot-prompt').textContent = composed.prompt
      card.querySelector('[data-size]').textContent = `输出 ${composed.generationSize}${composed.styleReferenceAttached ? ' · 挂风格板' : ' · 白底'}`
    }
    const genBtn = card.querySelector('[data-act="generate"]')
    genBtn.onclick = async () => {
      // 点下去才查：先查 Key，再查产品参考图（与宿主侧同一套规则）
      if (state.status && state.status.image && state.status.image.configured === false) {
        toast('还没配置 apiz Key：去侧栏「设置」填 Key 或打开「复用本机 apiz CLI 登录态」')
        location.hash = '#/settings'
        return
      }
      if (!refPaths().length && state.status?.image?.requireReferenceImages !== false) {
        toast('这张图需要产品参考图：在策划台的「产品参考图」区拖入实拍/包装/结构图（1-4 张即可）')
        highlightRefDropzone()
        return
      }
      genBtn.disabled = true
      genBtn.textContent = '生成中…'
      try {
        const composed = await composeSlot(slot)
        const result = await post('/api/generate', {
          planId: plan.id,
          slot,
          tier: state.form.tier,
          quality: state.form.quality,
          stylePresetId: state.form.stylePresetId,
          styleDensityMode: state.form.styleDensityMode,
          referenceImages: refPaths().length ? refPaths() : undefined,
        })
        state.generated[slot] = result
        const status = card.querySelector('[data-act-status]')
        status.innerHTML = `<img src="${mediaUrl(result.file)}" alt="生成结果" data-file="${esc(result.file)}">`
        status.querySelector('img').onclick = (e) => openViewer(`${slot} 生成结果`, `<img src="${mediaUrl(e.currentTarget.dataset.file)}">`, mediaUrl(e.currentTarget.dataset.file))
        genBtn.textContent = '重新生成'
      } catch (err) {
        toast(String(err.message || err))
        genBtn.textContent = '生成'
        genBtn.disabled = false
        return
      }
      genBtn.disabled = false
    }
    card.querySelector('[data-act="chat"]').onclick = async () => {
      const composed = await composeSlot(slot)
      startInChat([
        `请用「亚马逊图片工作台」插件生成亚马逊图片 ${slot}：`,
        `- 策划档案 planId：${plan.id}`,
        `- 直接执行 amz_generate（planId + slot），一次一张；`,
        composed.styleReferenceAttached ? '- 会自动挂风格板（最后一张参考图）。' : '- 该槽位是主图/无风格板：保持纯白底。',
        `- 输出尺寸 ${composed.generationSize}。`,
      ].join('\n'))
      toast('已把生成指令填进新对话')
    }
    if (entry.textTitle || entry.textBody) {
      const textBtn = card.querySelector('[data-act="copy-text"]')
      if (textBtn) textBtn.onclick = () => copyText([entry.textTitle, entry.textBody].filter(Boolean).join('\n\n'))
    }
  })
}

function slotCardHtml(entry, index) {
  const isAplus = entry.moduleType != null
  const sizeText = isAplus ? `${entry.uploadSize} → ${entry.generationSize}` : ''
  const hasText = entry.textTitle || entry.textBody
  return `
  <div class="slot-card" data-slot="${esc(entry.slot)}">
    <div class="slot-head">
      <span class="slot-id">${esc(entry.slot)}</span>
      <span class="slot-label">${esc(entry.label ?? entry.displayLabel ?? '')}</span>
      ${sizeText ? `<span class="slot-size tag">${esc(sizeText)}</span>` : ''}
    </div>
    <div class="slot-body">
      <div class="slot-plan">${esc(entry.planMarkdown)}</div>
      <div class="slot-prompt">点「预览 Prompt」组装最终生图提示词</div>
      <div class="slot-gen">
        <button class="btn small" data-act="preview">预览 Prompt</button>
        <button class="btn small" data-act="copy">复制 Prompt</button>
        <button class="btn small primary" data-act="generate">生成</button>
        <button class="btn small" data-act="chat">填进对话生图</button>
        ${hasText ? `<button class="btn small" data-act="copy-text">复制 A+ 外部文案</button>` : ''}
        <span data-size class="hint"></span>
        <span class="grow"></span>
        <span class="status" data-act-status></span>
      </div>
      ${hasText ? `<div class="hint" style="margin-top:8px"><b>A+ 外部文案</b>（不画进图）：${esc(entry.textTitle)}${entry.textBody ? ' — ' + esc(entry.textBody) : ''}</div>` : ''}
    </div>
  </div>`
}

// ---------------------------------------------------------------- 视图：策划档案

function renderPlans() {
  app.innerHTML = `
  <h2>策划档案</h2>
  <div class="sub">AI 策划与对话内策划的存档；点开可看这套方案的卖点、逐槽位策划说明与已生成的成品图。</div>
  <div id="plans-list"></div>`
  const holder = document.getElementById('plans-list')
  if (!state.plans.length) { holder.innerHTML = '<div class="hint">还没有策划档案，去「策划台」发起 AI 策划。</div>'; return }
  holder.innerHTML = state.plans.map((p) => `
    <div class="plan-card">
      ${p.cover
        ? `<img class="plan-cover" src="${mediaUrl(p.cover)}" data-file="${esc(p.cover)}" alt="封面" loading="lazy">`
        : '<div class="plan-cover plan-cover-empty">无图</div>'}
      <div class="plan-main">
        <div class="title">${esc(p.title || '未命名商品')}</div>
        <div class="meta">${p.mode === 'aplus' ? `A+ · ${esc(p.aPlusType ?? '')}` : 'Listing'} · ${p.slotCount} 个槽位 · ${esc(p.marketplaceId)}${p.tier ? ` · ${esc(p.tier)}` : ''} · ${shortTime(p.updatedAt)}</div>
        ${p.bullets?.length ? `<ul class="plan-bullets">${p.bullets.slice(0, 5).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '<div class="hint">这套档案没有记录卖点（五点描述）</div>'}
        <div class="meta">已生成 <b>${p.generatedCount}</b> 张 · ${esc(p.id)}</div>
      </div>
      <div class="plan-actions">
        <button class="btn small" data-act="detail" data-id="${esc(p.id)}">查看详情</button>
        <button class="btn small" data-act="open" data-id="${esc(p.id)}">在策划台打开</button>
        <button class="btn small ghost" data-act="del" data-id="${esc(p.id)}">删除</button>
      </div>
    </div>`).join('')

  holder.querySelectorAll('.plan-cover').forEach((img) => {
    if (img.classList.contains('plan-cover-empty')) return
    img.onclick = () => openViewer('封面', `<img src="${mediaUrl(img.dataset.file)}">`, mediaUrl(img.dataset.file))
    img.onerror = () => { img.outerHTML = '<div class="plan-cover plan-cover-empty">文件已丢失</div>' }
  })
  holder.querySelectorAll('[data-act="detail"]').forEach((btn) => {
    btn.onclick = () => { location.hash = `#/plans/${encodeURIComponent(btn.dataset.id)}` }
  })
  holder.querySelectorAll('[data-act="open"]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        const r = await api(`/api/plan?id=${encodeURIComponent(btn.dataset.id)}`)
        applyPlanToForm(r.plan)
        location.hash = '#/'
      } catch (err) {
        toast(`打开失败：${String(err.message || err)}`)
      }
    }
  })
  holder.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await post('/api/plans/remove', { id: btn.dataset.id })
        if (state.plan?.id === btn.dataset.id) state.plan = null
        await Promise.all([loadPlans(), loadHistory()])
        renderPlans()
        toast('已删除')
      } catch (err) {
        toast(`删除失败：${String(err.message || err)}`)
      }
    }
  })
}

/** 把档案恢复到策划台表单（mode/站点/张数/A+类型/风格/档位/文案）。 */
function applyPlanToForm(plan) {
  state.plan = plan
  state.composing = {}
  state.generated = {}
  state.form.mode = plan.mode
  if (plan.marketplaceId) state.form.marketplaceId = plan.marketplaceId
  if (plan.listingImageCount) state.form.listingImageCount = plan.listingImageCount
  if (plan.plans?.length) state.form.listingImageCount = plan.plans.length
  if (plan.aPlusType) state.form.aPlusType = plan.aPlusType
  if (plan.stylePresetId) state.form.stylePresetId = plan.stylePresetId
  if (plan.tier) state.form.tier = plan.tier
  if (plan.listingText) state.form.listingText = plan.listingText
  for (const key of ['productTitle', 'brand', 'category', 'color', 'material', 'audience', 'packageIncludes', 'sellingPoints']) {
    const value = plan.draft?.[key]
    if (typeof value === 'string' && value) state.form[key] = value
  }
}

// ---------------------------------------------------------------- 视图：策划档案详情

async function renderPlanDetail(planId) {
  app.innerHTML = '<div class="loading">读取档案…</div>'
  let data
  try {
    data = await api(`/api/plan?id=${encodeURIComponent(planId)}`)
  } catch (err) {
    app.innerHTML = `<div class="alert bad">读取档案失败：${esc(String(err.message || err))}</div><div class="row"><button class="btn" id="back-plans">返回档案列表</button></div>`
    document.getElementById('back-plans').onclick = () => { location.hash = '#/plans' }
    return
  }
  const plan = data.plan
  const slots = slotList(plan)
  const images = data.images ?? []
  const imageBySlot = new Map()
  for (const item of images) if (item.slot && !imageBySlot.has(item.slot)) imageBySlot.set(item.slot, item)
  const marketplace = state.meta?.marketplaces?.find((x) => x.id === plan.marketplaceId)

  app.innerHTML = `
  <div class="row" style="margin-bottom:6px">
    <button class="btn small ghost" id="back-plans">← 档案列表</button>
    <span class="grow"></span>
    <button class="btn small" id="open-in-studio">在策划台打开</button>
  </div>
  <h2>${esc(plan.parsed?.title || '未命名商品')}</h2>
  <div class="sub">${plan.mode === 'aplus' ? `A+ 图 · ${esc(plan.aPlusType ?? '')}` : 'Listing 图'} · ${esc(marketplace?.label ?? plan.marketplaceId ?? '')} · ${slots.length} 个槽位${plan.tier ? ` · ${esc(plan.tier)} 档` : ''} · 更新于 ${shortTime(plan.updatedAt)}</div>

  <div class="card">
    <h3>五点卖点（策划依据）</h3>
    ${plan.parsed?.bullets?.length
      ? `<ol class="plan-bullets">${plan.parsed.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ol>`
      : '<div class="hint">这套档案没有记录卖点：当时提交策划 JSON 时没给 sellingPoints。</div>'}
    ${plan.listingText ? `<details style="margin-top:8px"><summary class="hint">当时的 Listing 文案</summary><pre class="plain">${esc(plan.listingText)}</pre></details>` : ''}
  </div>

  <div class="card">
    <h3>成品图（${images.length} 张）</h3>
    ${images.length
      ? `<div class="gen-grid">${images.map((item) => `
        <figure class="gen-cell">
          ${item.exists
            ? `<img src="${mediaUrl(item.file)}" data-file="${esc(item.file)}" alt="${esc(item.slot ?? '')}" loading="lazy">`
            : '<div class="gen-missing">文件已丢失</div>'}
          <figcaption>${esc(item.slot ?? '自由生成')} · ${esc(item.actualSize ?? item.generationSize ?? '')}${item.quality ? ` · ${esc(item.quality)}` : ''}</figcaption>
        </figure>`).join('')}</div>`
      : '<div class="hint">这套档案还没有生成过图。</div>'}
  </div>

  <div class="card">
    <h3>逐槽位策划</h3>
    ${slots.map((entry) => {
      const image = imageBySlot.get(entry.slot)
      return `
      <div class="plan-slot">
        <div class="row">
          <b>${esc(entry.slot)}</b>
          <span class="hint">${esc(entry.label ?? '')}</span>
          ${entry.moduleType ? `<span class="tag">${esc(entry.moduleType)} · ${esc(entry.uploadSize ?? '')}</span>` : ''}
          <span class="grow"></span>
          ${image?.exists ? `<button class="btn small ghost" data-img="${esc(image.file)}">看这张图</button>` : ''}
        </div>
        <div class="slot-plan">${esc(entry.planMarkdown ?? '')}</div>
        ${entry.textTitle || entry.textBody ? `<div class="hint">A+ 外部文案：${esc(entry.textTitle ?? '')}${entry.textBody ? ' — ' + esc(entry.textBody) : ''}</div>` : ''}
        <details><summary class="hint">英文生图 Prompt</summary><div class="slot-prompt">${esc(entry.prompt ?? '')}</div></details>
      </div>`
    }).join('')}
  </div>`

  document.getElementById('back-plans').onclick = () => { location.hash = '#/plans' }
  document.getElementById('open-in-studio').onclick = () => { applyPlanToForm(plan); location.hash = '#/' }
  app.querySelectorAll('[data-img]').forEach((btn) => {
    btn.onclick = () => openViewer('成品图', `<img src="${mediaUrl(btn.dataset.img)}">`, mediaUrl(btn.dataset.img))
  })
  app.querySelectorAll('.gen-cell img').forEach((img) => {
    img.onclick = () => openViewer('成品图', `<img src="${mediaUrl(img.dataset.file)}">`, mediaUrl(img.dataset.file))
    img.onerror = () => { img.outerHTML = '<div class="gen-missing">文件已丢失</div>' }
  })
}

// ---------------------------------------------------------------- 视图：生成历史

function renderGallery() {
  app.innerHTML = `
  <h2>生成历史</h2>
  <div class="sub">amz_generate / 面板「生成」的产物（保存在插件数据目录）。点图看大图，可复用 Prompt 或填进对话重生成。</div>
  <div class="row" style="margin-bottom:10px"><span class="grow"></span><button class="btn small ghost" id="btn-clear-history">清空记录</button></div>
  <div id="history-list"></div>`
  const holder = document.getElementById('history-list')
  if (!state.history.length) { holder.innerHTML = '<div class="hint">还没有生成记录。</div>'; return }
  holder.innerHTML = state.history.map((r) => `
    <div class="list-item">
      <img class="thumb" src="${mediaUrl(r.file)}" data-file="${esc(r.file)}" loading="lazy">
      <div style="min-width:0">
        <div class="title">${esc(r.slot ?? '自由生成')} <span class="tag">${esc(r.provider)}/${esc(r.model ?? '')}</span>${r.quality ? `<span class="tag">${esc(r.quality)}</span>` : ''}</div>
        <div class="meta">${esc(r.actualSize ?? r.generationSize ?? '')}${r.generationSize && r.actualSize && r.actualSize !== r.generationSize ? `（要 ${esc(r.generationSize)}）` : ''}${r.price != null ? ` · ${r.price} 积分` : ''} · ${r.referenceCount ? `参考图 ${r.referenceCount} 张` : '无参考图'}${r.planId ? ` · 档案 <a href="#/plans/${encodeURIComponent(r.planId)}">${esc(r.planId)}</a>` : ''} · ${shortTime(r.createdAt)}</div>
        <div class="meta" style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((r.prompt ?? '').slice(0, 160))}</div>
      </div>
      <span class="grow"></span>
      <button class="btn small" data-act="copy" data-id="${esc(r.id)}">复制 Prompt</button>
      <button class="btn small" data-act="regen" data-id="${esc(r.id)}">填进对话重生成</button>
      <button class="btn small ghost" data-act="del" data-id="${esc(r.id)}">删除</button>
    </div>`).join('')
  holder.querySelectorAll('img.thumb').forEach((img) => {
    img.onclick = () => openViewer('生成结果', `<img src="${mediaUrl(img.dataset.file)}">`, mediaUrl(img.dataset.file))
    // 早期版本 outputPath 不落盘的记录会指向不存在的文件：显示占位而不是坏图
    img.onerror = () => { img.outerHTML = '<div class="thumb thumb-missing">文件已丢失</div>' }
  })
  holder.querySelectorAll('[data-act="copy"]').forEach((btn) => {
    btn.onclick = () => {
      const r = state.history.find((x) => x.id === btn.dataset.id)
      if (r) copyText(r.prompt)
    }
  })
  holder.querySelectorAll('[data-act="regen"]').forEach((btn) => {
    btn.onclick = () => {
      const r = state.history.find((x) => x.id === btn.dataset.id)
      if (!r) return
      startInChat([
        r.planId && r.slot
          ? `请用「亚马逊图片工作台」插件重新生成 ${r.slot}：amz_generate（planId: ${r.planId}，slot: ${r.slot}），一次一张。`
          : '请用「亚马逊图片工作台」插件重新生成这张图：先 amz_history generate-get 拿到当时的 Prompt，确认后用 amz_generate（直接传 prompt）重新生成，一次一张。',
      ].join('\n'))
      toast('已把指令填进新对话')
    }
  })
  holder.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.onclick = async () => {
      await post('/api/history/remove', { id: btn.dataset.id })
      await loadHistory()
      renderGallery()
    }
  })
  document.getElementById('btn-clear-history').onclick = async () => {
    await post('/api/history/clear', {})
    await loadHistory()
    renderGallery()
    toast('已清空')
  }
}

// ---------------------------------------------------------------- 视图：打标

function renderTagging() {
  app.innerHTML = `
  <h2>AI 人物打标</h2>
  <div class="sub">给已确认需要披露的 AI 生成人物媒体写入 Amazon 要求的 <code>contains-synthetic-performer</code> XMP 标记。只改元数据，不重编码像素/音视频流；已正确打标的文件自动跳过。面板单文件上限 50MB，更大的视频请在对话里让 agent 用 <code>amz_tag_performer</code> 处理。</div>
  <div class="dropzone" id="dropzone">点击选择或拖入 JPG / PNG / WebP / MP4 / MOV 文件（可多选）<input type="file" id="tag-input" multiple accept=".jpg,.jpeg,.png,.webp,.mp4,.mov" hidden></div>
  <div class="row" style="margin-bottom:12px"><span class="hint" id="tag-summary"></span><span class="grow"></span><button class="btn primary" id="btn-tag" disabled>写入 XMP 标记</button></div>
  <div class="card" id="tag-list"></div>`

  const dropzone = document.getElementById('dropzone')
  const input = document.getElementById('tag-input')
  dropzone.onclick = () => input.click()
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag') })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'))
  dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('drag'); addTagFiles([...e.dataTransfer.files]) })
  input.onchange = () => addTagFiles([...input.files])

  document.getElementById('btn-tag').onclick = runTagging
  renderTagList()
}

function addTagFiles(files) {
  const supported = /\.(jpe?g|png|webp|mp4|mov)$/i
  for (const file of files) {
    if (!supported.test(file.name)) { toast(`跳过不支持的格式：${file.name}`); continue }
    if (file.size > 50 * 1024 * 1024) { toast(`${file.name} 超过 50MB，请在对话里让 agent 处理`); continue }
    if (!state.tagFiles.some((f) => f.name === file.name && f.size === file.size)) state.tagFiles.push(file)
  }
  renderTagList()
}

function renderTagList() {
  const list = document.getElementById('tag-list')
  const btn = document.getElementById('btn-tag')
  const summary = document.getElementById('tag-summary')
  if (!list) return
  summary.textContent = state.tagFiles.length ? `${state.tagFiles.length} 个文件待处理` : ''
  btn.disabled = !state.tagFiles.length
  list.innerHTML = state.tagFiles.map((file, index) => `
    <div class="tag-file">
      <span>${esc(file.name)}</span>
      <span class="hint">${(file.size / 1024 / 1024).toFixed(2)} MB</span>
      <span class="st" data-st="${index}"></span>
      <button class="btn small ghost" data-rm="${index}">移除</button>
    </div>`).join('') || '<div class="hint" style="padding:10px">还没有加入文件。</div>'
  list.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => { state.tagFiles.splice(Number(b.dataset.rm), 1); renderTagList() }
  })
}

async function runTagging() {
  const btn = document.getElementById('btn-tag')
  btn.disabled = true
  btn.textContent = '处理中…'
  const files = state.tagFiles
  const payloadFiles = []
  for (const file of files) {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    payloadFiles.push({ name: file.name, data })
  }
  try {
    const result = await post('/api/tag', { files: payloadFiles })
    for (const item of result.results) {
      const index = files.findIndex((f) => f.name === item.name)
      const el = document.querySelector(`[data-st="${index}"]`)
      if (!el) continue
      if (item.status === 'already-tagged') { el.innerHTML = '<span class="st ok">已含标记，跳过</span>' }
      else if (item.status === 'tagged') { el.innerHTML = `<span class="st ok">已写入</span> <a class="btn small" href="${item.download}" download="${esc(item.name)}">下载</a>` }
      else { el.innerHTML = `<span class="st bad" title="${esc(item.error ?? '')}">失败：${esc((item.error ?? '').slice(0, 60))}</span>` }
    }
    toast(`写入 ${result.tagged}，跳过 ${result.results.filter((r) => r.status === 'already-tagged').length}，失败 ${result.failed}`)
    state.tagFiles = state.tagFiles.filter((f) => !result.results.some((r) => r.name === f.name && r.status !== 'failed'))
    renderTagList()
  } catch (err) {
    toast(String(err.message || err))
  } finally {
    btn.disabled = false
    btn.textContent = '写入 XMP 标记'
  }
}

// ---------------------------------------------------------------- 视图：设置（只配 apiz）

const QUALITY_LABELS = { low: '低（最省）', medium: '中', high: '高', xhigh: '更高', max: '最高' }
const KEY_SOURCE_LABELS = { config: '面板里填的 Key', env: '环境变量 APIZ_API_KEY', 'apiz-cli': '本机 apiz CLI 登录态', none: '未配置' }

async function renderSettings() {
  app.innerHTML = '<div class="loading">读取设置…</div>'
  let settings
  try {
    settings = (await api('/api/settings')).settings
  } catch (err) {
    app.innerHTML = `<div class="alert bad">读取设置失败：${esc(String(err.message || err))}</div>`
    return
  }
  const s = settings.image
  app.innerHTML = `
  <h2>设置</h2>
  <div class="sub">生图只走 apiz（GPT Image 2.5 Flare）。这里保存的配置会写进 profile patch 并立即生效。</div>

  ${settings.available ? '' : `<div class="alert bad">宿主没有 config-editor 服务，这个页面的保存会失败：请升级 dsh，或直接改 profile 的 <code>cordis.patch.yml</code>。</div>`}

  <div class="card">
    <h3>apiz 认证</h3>
    <div class="alert info" style="margin-bottom:10px">
      还没有 Key？去 <a href="https://apiz.ai/#/?ref=IP98Q1ZX" target="_blank" rel="noreferrer">apiz.ai</a> 注册 / 登录 → 控制台「API Keys」→ 新建 → 复制 <code>sk-</code> 开头的那串，粘贴到下面保存。
      <div class="hint" style="margin-top:4px">按 token 计费（100 积分 = ¥1），用多少扣多少；质量档位越低越便宜。</div>
    </div>
    <div class="row" style="gap:10px">
      <div class="row" style="gap:6px"><span class="dot ${s.keySource === 'none' ? 'bad' : 'ok'}"></span>当前 Key 来源：<b>${esc(KEY_SOURCE_LABELS[s.keySource] ?? s.keySource)}</b></div>
      <span class="grow"></span>
      <span class="hint">${s.hasApiKey ? `已保存：${esc(s.apiKey)}` : '还没有在面板里保存过 Key'}</span>
    </div>
    <label class="field" style="margin-top:10px">apiz API Key（sk-…）
      <input id="s-key" type="password" placeholder="${s.hasApiKey ? '已保存，留空则不修改' : '粘贴 sk- 开头的 Key'}" autocomplete="off">
    </label>
    <label class="row" style="gap:6px;margin-top:8px">
      <input type="checkbox" id="s-clearkey" ${s.hasApiKey ? '' : 'disabled'}> 清除已保存的 Key
    </label>
    <label class="row" style="gap:6px;margin-top:8px">
      <input type="checkbox" id="s-cliauth" ${s.useCliAuth ? 'checked' : ''}> 复用本机 apiz CLI 登录态
      <span class="hint">（${s.cliKeyAvailable ? '本机检测到 apiz 登录文件' : '本机没有 apiz 登录文件'}；默认关闭——不配置 Key 就不允许生图）</span>
    </label>
    <label class="field" style="margin-top:10px">模型 id（留空用默认 ${esc(settings.defaultModel)}）
      <input id="s-model" placeholder="${esc(settings.defaultModel)}" value="${esc(s.model === settings.defaultModel ? '' : s.model)}">
    </label>
  </div>

  <div class="card">
    <h3>生图默认值</h3>
    <div class="grid2">
      <label class="field">质量档位
        <select id="s-quality">${settings.qualities.map((q) => `<option value="${q}" ${s.quality === q ? 'selected' : ''}>${esc(QUALITY_LABELS[q] ?? q)}</option>`).join('')}</select>
      </label>
      <label class="field">输出档位
        <select id="s-tier">${settings.tiers.map((t) => `<option value="${t}" ${s.outputTier === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
    </div>
    <div class="sub" style="margin-top:6px">质量与档位都影响价格：low + 1K 最便宜；档位越高、质量越高越贵（按 token 计费，与分辨率不是一回事）。</div>
    <label class="row" style="gap:6px;margin-top:10px">
      <input type="checkbox" id="s-transparency" ${s.transparency ? 'checked' : ''}> 透明背景（输出 PNG；开启后 prompt 不要描述背景，亚马逊主图请保持关闭）
    </label>
    <label class="row" style="gap:6px;margin-top:8px">
      <input type="checkbox" id="s-require-ref" ${s.requireReferenceImages ? 'checked' : ''}> 必须上传产品参考图才能生成（建议保持开启）
    </label>
    <label class="row" style="gap:6px;margin-top:8px">
      <input type="checkbox" id="s-reuse-ref" ${s.reusePanelReferences ? 'checked' : ''}> 对话里生图时自动复用面板最近上传的参考图
      <span class="hint">（当前面板里有 ${s.panelReferenceCount} 张；关掉后对话里必须显式给路径）</span>
    </label>
    <label class="field" style="margin-top:10px;width:180px">API 超时（秒）
      <input id="s-timeout" type="number" min="30" max="3600" value="${Number(s.timeoutSeconds)}">
    </label>
  </div>

  <div class="row">
    <button class="btn primary" id="s-save" ${settings.available ? '' : 'disabled'}>保存设置</button>
    <span class="hint">保存后立即生效，无需重启；面板刷新一次即可看到状态变化。</span>
  </div>`

  document.getElementById('s-save').onclick = async () => {
    const btn = document.getElementById('s-save')
    btn.disabled = true
    btn.textContent = '保存中…'
    try {
      const patch = {
        imageQuality: document.getElementById('s-quality').value,
        outputTier: document.getElementById('s-tier').value,
        imageTransparency: document.getElementById('s-transparency').checked,
        imageUseApizCliAuth: document.getElementById('s-cliauth').checked,
        requireReferenceImages: document.getElementById('s-require-ref').checked,
        reusePanelReferences: document.getElementById('s-reuse-ref').checked,
        timeoutSeconds: Number(document.getElementById('s-timeout').value),
        imageModel: document.getElementById('s-model').value.trim(),
      }
      const key = document.getElementById('s-key').value.trim()
      if (document.getElementById('s-clearkey').checked) patch.imageApiKey = ''
      else if (key) patch.imageApiKey = key
      await post('/api/settings', patch)
      await loadStatus()
      toast('设置已保存并生效')
      renderSettings()
    } catch (err) {
      toast(`保存失败：${String(err.message || err)}`)
      btn.disabled = false
      btn.textContent = '保存设置'
    }
  }
}

// ---------------------------------------------------------------- 视图：指南

function renderGuide() {
  const m = state.meta
  app.innerHTML = `
  <h2>工作流与合规</h2>
  <div class="sub">与「策划台」一体的方法论速查；详细方法论由随包 skill 提供，对话里让 agent 执行即可。</div>
  <div class="card guide-section">
    <h3>标准工作流</h3>
    <ul>
      <li><b>① 查槽位</b>：<code>amz_slots</code> 拿 Listing 槽位表或 A+ 模块编排（可增删模块，1-${m.maxAPlusModuleCount} 个）。</li>
      <li><b>② AI 策划</b>：<code>amz_plan</code> 返回自策划指引，对话里的模型按指引完成策划 → <code>amz_validate_plan</code> 校验存档拿 planId（**没有策划 API 要配**）。</li>
      <li><b>③ 逐张确认</b>：<code>amz_prompt</code> 组装最终 Prompt（风格块/密度/负面词/守卫/分辨率自动带上），用户过目。</li>
      <li><b>④ 一次一张生成</b>：<code>amz_generate</code>（planId + slot）。<b>必须带产品参考图</b>（风格板不算），没传会被直接拒绝；生图只走 apiz，没在「设置」里配 Key 也不允许生成。</li>
      <li><b>⑤ 打标</b>：需要披露的 AI 人物媒体用 <code>amz_tag_performer</code> 写 XMP。</li>
    </ul>
  </div>
  <div class="card guide-section">
    <h3>生图是怎么走的</h3>
    <ol>
      <li>你的产品图 → 用 <code>apiz upload</code> 传到 apiz CDN 换公网 URL（免费，同一张只传一次）。</li>
      <li>插件按槽位比例算出目标尺寸，吸附到 apiz 支持的「比例 × 1K/2K/4K 或离散宽高」。</li>
      <li>带上产品图 + 风格板（附图/A+ 才有）提交生成任务，创建时就预扣积分。</li>
      <li>插件每 2 秒轮询（逐步退避到 5 秒）；超时只报错并给 <code>task_id</code>，<b>不要重新提交</b>。</li>
      <li>出图后下载落盘、写入生成历史（实际尺寸 / 质量档位 / 任务号 / 花费）。</li>
    </ol>
    <div class="hint">主图（MAIN）永远纯白底、不挂风格板；附图/A+ 才自动挂，风格板固定是最后一张参考图。</div>
  </div>
  <div class="card guide-section">
    <h3>Listing 合规清单</h3>
    <ul>${m.compliance.listing.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
  </div>
  <div class="card guide-section">
    <h3>A+ 合规清单</h3>
    <ul>${m.compliance.aplus.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
  </div>
  <div class="card guide-section">
    <h3>字段语言规则</h3>
    <ul>
      <li><code>label</code> / <code>planMarkdown</code>：简体中文。</li>
      <li><code>seriesStyleGuide</code> / <code>prompt</code> / <code>negativePrompt</code>：英文。</li>
      <li>图片可见文案：目标站点语言（日本站允许日文，其余站点禁 CJK 图上文案）。</li>
      <li>A+ <code>textTitle</code> / <code>textBody</code>（Highlight Tile 外部文案）：站点语言或空。</li>
    </ul>
  </div>`
}

// ---------------------------------------------------------------- 路由

const routes = { home: renderHome, plans: renderPlans, gallery: renderGallery, tagging: renderTagging, settings: renderSettings, guide: renderGuide }

function route() {
  const raw = location.hash.replace(/^#\//, '') || 'home'
  const [path] = raw.split('?')
  const [view, ...rest] = path.split('/')
  for (const el of document.querySelectorAll('.nav a')) {
    el.classList.toggle('active', el.dataset.view === view)
  }
  void navigate(view, rest)
}

/**
 * 每次切页都重新拉数据：以前只在 boot 时加载一次，导致刚生成的图 / 刚建的档案
 * 不刷新就不出现（看起来像「历史缺失」）。
 */
async function navigate(view, rest = []) {
  try {
    if (view === 'plans' && rest.length) {
      await renderPlanDetail(decodeURIComponent(rest.join('/')))
      return
    }
    if (view === 'plans') { await loadPlans(); renderPlans(); return }
    if (view === 'gallery') { await loadHistory(); renderGallery(); return }
    if (view === 'home') {
      await Promise.all([loadStatus(), loadPlans(), loadHistory()])
      renderHome()
      return
    }
    ;(routes[view] ?? renderHome)()
  } catch (err) {
    app.innerHTML = `<div class="alert bad">加载失败：${esc(String(err.message || err))}</div>`
  }
}

addEventListener('hashchange', route)
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return
  if (e.data?.type === 'amazon-image-studio:scheme' && e.data.scheme) {
    document.documentElement.dataset.scheme = e.data.scheme
  }
})

async function boot() {
  try {
    await Promise.all([loadStatus(), loadMeta(), loadPlans(), loadHistory()])
  } catch (err) {
    app.innerHTML = `<div class="alert bad">加载失败：${esc(String(err.message || err))}</div>`
    return
  }
  route()
}

boot()
