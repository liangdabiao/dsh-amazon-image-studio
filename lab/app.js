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
    styleDensityMode: 'rich',
  },
  history: [],
  plans: [],
  tagFiles: [],
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
    <div>${dot(s.planner.configured, true)}策划 API：${s.planner.configured ? esc(s.planner.model || '已配置') : '未配置（对话内策划）'}</div>
    <div>${dot(s.image.configured, true)}生图 API：${s.image.configured ? esc(s.image.provider) : '未配置（CLI 兜底）'}</div>
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
  f.referenceImages = formValue('f-refs')
  f.stylePresetId = formValue('f-style') || 'clean-tech'
  f.tier = formValue('f-tier') || '2K'
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
  set('f-refs', f.referenceImages); set('f-style', f.stylePresetId); set('f-tier', f.tier); set('f-density', f.styleDensityMode)
  syncModeVisibility()
}

function syncModeVisibility() {
  const mode = state.form.mode
  document.querySelectorAll('[data-mode-only]').forEach((el) => {
    el.hidden = el.dataset.modeOnly !== mode
  })
}

function planRequestBody(f) {
  return {
    mode: f.mode,
    marketplaceId: f.marketplaceId,
    listingImageCount: f.listingImageCount,
    aplusType: f.aplusType,
    listingText: f.listingText,
    productTitle: f.productTitle, brand: f.brand, category: f.category,
    color: f.color, material: f.material, audience: f.audience,
    packageIncludes: f.packageIncludes, sellingPoints: f.sellingPoints, forbidden: f.forbidden,
    referenceImages: f.referenceImages ? f.referenceImages.split(/\r?\n|[,;，；]/).map((s) => s.trim()).filter(Boolean) : undefined,
    tier: f.tier,
  }
}

// ---------------------------------------------------------------- 视图：策划台

function renderHome() {
  const m = state.meta
  const f = state.form
  app.innerHTML = `
  <h2>策划台</h2>
  <div class="sub">粘贴 Listing 文案 → AI 策划逐张方案 → 逐槽位检查 Prompt → 生成（一次一张）。主图白底不挂风格板，附图/A+ 自动挂。</div>
  ${state.status && !state.status.planner.configured ? `<div class="alert warn">策划 API 未配置：「AI 策划」会把策划指引填进对话，由当前对话的模型完成策划并自动校验存档。也可以在插件设置里配置 plannerApiKey 走独立策划模型。</div>` : ''}
  ${state.status && !state.status.image.configured ? `<div class="alert warn">生图 API 未配置：「生成」会失败；可点「填进对话生图」改走即梦 / apiz CLI 通道。</div>` : ''}

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
      <label class="field">参考图路径<textarea id="f-refs" rows="2" placeholder="绝对路径，每行一张（实拍/包装/结构图）"></textarea></label>
    </div>
    <div class="grid2" style="margin-top:10px">
      <label class="field">卖点（每行一条）<textarea id="f-sellingPoints" rows="3" placeholder="可选"></textarea></label>
      <label class="field">不要出现的元素（每行一条）<textarea id="f-forbidden" rows="3" placeholder="可选"></textarea></label>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" id="btn-plan">✨ AI 策划</button>
      <button class="btn" id="btn-plan-chat">填进对话策划</button>
      <span class="grow"></span>
      <label class="field" style="width:170px">风格板
        <select id="f-style">
          <option value="none">不挂风格板</option>
          ${m.stylePresets.map((p) => `<option value="${p.id}">${p.label}</option>`).join('')}
        </select>
      </label>
      <label class="field" style="width:80px">档位
        <select id="f-tier"><option value="2K">2K</option><option value="4K">4K</option></select>
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
  document.getElementById('btn-plan').onclick = runPlanFlow
  document.getElementById('btn-plan-chat').onclick = planViaChat
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

function renderAplusModules() {
  const holder = document.getElementById('aplus-modules')
  if (!holder) return
  const type = state.form.aplusType
  const info = state.meta.aplusTypes.find((t) => t.type === type)
  holder.innerHTML = info ? `<div class="row">${info.modules.map((mod) => `<span class="tag" title="${esc(mod.displayLabel)}">${esc(mod.slot)} ${esc(mod.label)} · ${esc(mod.uploadSize)}</span>`).join('')} <span class="hint">默认编排（策划前可在对话里让 agent 用 amz_slots 增删模块，1-${state.meta.maxAPlusModuleCount} 个）</span></div>` : ''
  const sel = document.getElementById('f-aplus')
  if (sel) sel.onchange = () => { state.form.aplusType = sel.value; renderAplusModules() }
}

async function runPlanFlow() {
  const f = readForm()
  if (!f.listingText.trim()) return toast('先粘贴 Listing 文案')
  const btn = document.getElementById('btn-plan')
  btn.disabled = true
  btn.textContent = '策划中…'
  try {
    // 不走 post() 的抛错路径：策划接口未配置 Key 时会返回 400 + agentNeeded + agentGuide
    const raw = await fetch(BASE + '/api/plan/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(planRequestBody(f))
    })
    const body = await raw.json()
    if (!raw.ok || body.ok === false) {
      if (body.agentNeeded) return handleAgentGuide(body)
      throw new Error(body.error || `请求失败（${raw.status}）`)
    }
    state.plan = body.plan
    state.composing = {}
    state.generated = {}
    renderPlanResult(state.plan)
    toast('策划完成，逐槽位检查后生成')
  } catch (err) {
    toast(String(err.message || err))
  } finally {
    btn.disabled = false
    btn.textContent = '✨ AI 策划'
  }
}

function handleAgentGuide(body) {
  const guide = body.agentGuide ?? {}
  const slots = guide.slots ?? []
  const slotsText = Array.isArray(slots) && slots.length && typeof slots[0] === 'object'
    ? slots.map((s) => `${s.slot}(${s.uploadSize || ''})`).join(', ')
    : slots.join(', ')
  const instruction = [
    '请使用「亚马逊图片工作台」插件为我策划亚马逊商品图片：',
    `- 工作流：${guide.mode === 'aplus' ? 'A+ 图（' + (guide.aPlusType || '') + '）' : 'Listing 图（' + (guide.listingImageCount || 7) + ' 张）'}`,
    `- 站点：${guide.marketplace?.label || ''}`,
    `- 槽位：${slotsText}`,
    '',
    'Listing 文案：',
    readForm().listingText,
    '',
    `请按 amz_plan 返回的自策划指引完成逐槽位策划（label/planMarkdown 中文，prompt/negativePrompt 英文，图上文案用${guide.marketplace?.copyLanguage || '站点'}语言），然后用 amz_validate_plan 校验存档，再逐槽位 amz_prompt + amz_generate 生成。`,
  ].join('\n')

  const holder = document.getElementById('plan-result')
  if (holder) {
    holder.innerHTML = `
    <div class="card">
      <h3>未配置策划 API —— 改由对话内策划</h3>
      <div class="hint" style="margin-bottom:8px">点下方按钮把策划指令（含 Listing 文案与槽位表）填进新对话；模型会按插件指引完成策划、校验存档，回到本页在「策划档案」里查看结果。</div>
      <div class="row"><button class="btn primary" id="btn-fill-chat">开新对话策划 →</button></div>
    </div>`
    document.getElementById('btn-fill-chat').onclick = () => startInChat(instruction)
  }
  toast('未配置策划 API，可填进对话策划')
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
      genBtn.disabled = true
      genBtn.textContent = '生成中…'
      try {
        const composed = await composeSlot(slot)
        const result = await post('/api/generate', { planId: plan.id, slot, tier: state.form.tier, stylePresetId: state.form.stylePresetId, styleDensityMode: state.form.styleDensityMode })
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
  <div class="sub">AI 策划与对话内策划的存档；点开可恢复到策划台继续逐张生成。</div>
  <div id="plans-list"></div>`
  const holder = document.getElementById('plans-list')
  if (!state.plans.length) { holder.innerHTML = '<div class="hint">还没有策划档案，去「策划台」发起 AI 策划。</div>'; return }
  holder.innerHTML = state.plans.map((p) => `
    <div class="list-item">
      <div style="min-width:0">
        <div class="title">${esc(p.title || '未命名商品')}</div>
        <div class="meta">${p.mode === 'aplus' ? 'A+' : 'Listing'} · ${p.slotCount} 个槽位 · ${esc(p.marketplaceId)} · ${shortTime(p.updatedAt)} · ${esc(p.id)}</div>
      </div>
      <span class="grow"></span>
      <button class="btn small" data-act="open" data-id="${esc(p.id)}">打开</button>
      <button class="btn small ghost" data-act="del" data-id="${esc(p.id)}">删除</button>
    </div>`).join('')
  holder.querySelectorAll('[data-act="open"]').forEach((btn) => {
    btn.onclick = async () => {
      const r = await api(`/api/plan?id=${encodeURIComponent(btn.dataset.id)}`)
      state.plan = r.plan
      state.composing = {}
      state.generated = {}
      state.form.mode = r.plan.mode
      if (r.plan.marketplaceId) state.form.marketplaceId = r.plan.marketplaceId
      if (r.plan.listingImageCount) state.form.listingImageCount = r.plan.listingImageCount
      if (r.plan.aPlusType) state.form.aplusType = r.plan.aPlusType
      if (r.plan.stylePresetId) state.form.stylePresetId = r.plan.stylePresetId
      location.hash = '#/'
      renderHome()
      writeForm()
      renderPlanResult(r.plan)
    }
  })
  holder.querySelectorAll('[data-act="del"]').forEach((btn) => {
    btn.onclick = async () => {
      await post('/api/plans/remove', { id: btn.dataset.id })
      await loadPlans()
      renderPlans()
      toast('已删除')
    }
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
        <div class="title">${esc(r.slot ?? '自由生成')} <span class="tag">${esc(r.provider)}/${esc(r.model ?? '')}</span></div>
        <div class="meta">${esc(r.generationSize ?? '')} · ${esc(r.planId ?? '')} · ${shortTime(r.createdAt)}</div>
        <div class="meta" style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((r.prompt ?? '').slice(0, 160))}</div>
      </div>
      <span class="grow"></span>
      <button class="btn small" data-act="copy" data-id="${esc(r.id)}">复制 Prompt</button>
      <button class="btn small" data-act="regen" data-id="${esc(r.id)}">填进对话重生成</button>
      <button class="btn small ghost" data-act="del" data-id="${esc(r.id)}">删除</button>
    </div>`).join('')
  holder.querySelectorAll('img.thumb').forEach((img) => {
    img.onclick = (e) => openViewer('生成结果', `<img src="${mediaUrl(e.currentTarget.dataset.file)}">`, mediaUrl(e.currentTarget.dataset.file))
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
      <li><b>② AI 策划</b>：<code>amz_plan</code>（配置了策划 Key 直接调模型；未配置返回指引由对话模型策划）→ <code>amz_validate_plan</code> 校验存档拿 planId。</li>
      <li><b>③ 逐张确认</b>：<code>amz_prompt</code> 组装最终 Prompt（风格块/密度/负面词/守卫/分辨率自动带上），用户过目。</li>
      <li><b>④ 一次一张生成</b>：<code>amz_generate</code>（planId + slot）；未配生图 Key 时走即梦 / apiz CLI 兜底。</li>
      <li><b>⑤ 打标</b>：需要披露的 AI 人物媒体用 <code>amz_tag_performer</code> 写 XMP。</li>
    </ul>
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

const routes = { home: renderHome, plans: renderPlans, gallery: renderGallery, tagging: renderTagging, guide: renderGuide }

function route() {
  const view = (location.hash.replace(/^#\//, '') || 'home').split('?')[0]
  for (const el of document.querySelectorAll('.nav a')) {
    el.classList.toggle('active', el.dataset.view === view)
  }
  ;(routes[view] ?? renderHome)()
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
