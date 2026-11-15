// 插件的 HTTP 半边：给侧栏「亚马逊图片」工作台页面用（/amazon-image-studio/ 下）。
//   GET  /                    工作台页面（lab/ 静态资源）
//   GET  /api/status          配置状态（Key 脱敏）+ 版本
//   GET  /api/meta            槽位表 / 站点 / 风格预设 / 合规清单（页面渲染用）
//   GET  /api/plans           策划档案列表；GET /api/plan?id= 详情
//   POST /api/plan            AI 策划（调策划 API；未配置返回 400 + agentNeeded）
//   POST /api/validate        校验并存档策划 JSON（与 amz_validate_plan 同一路径）
//   POST /api/generate        生成一张图（与 amz_generate 同一路径，一次一张）
//   POST /api/tag             XMP 打标（base64 文件，单文件 ≤50MB）
//   POST /api/plans/remove    删策划档案；POST /api/history/remove|clear 生图历史
//   GET  /media?path=         只允许 DATA_DIR 内文件与 assets/style-presets 预设板
import { createReadStream, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, IMAGES_DIR, listPlans, listReferences, loadPlan, readHistory, removeHistoryRecord, removePlan, removeReference, clearHistory, saveReference } from './data.js'
import {
  DEFAULT_IMAGE_PROVIDER, buildAgentPlanningGuide, composeSlotPrompt, getConfig, imageConfigured, imageKeySource,
  referenceImagesRequired, removeGenerateRecord, runGenerate, runValidatePlan,
} from './tools.js'
import { normalizeImageProvider } from './image/index.js'
import { readSettings, saveSettings } from './settings.js'
import { APLUS_COMPLIANCE_ZH, AMAZON_MARKETPLACES, LISTING_COMPLIANCE_ZH } from './planner/knowledge.js'
import { MAX_A_PLUS_MODULE_COUNT, getAmazonListingImageSlots, formatAmazonListingSlotRange, normalizeAPlusContentType, normalizeAPlusModuleSpecs } from './planner/slots.js'
import { STYLE_PRESETS, getStylePaletteEntries } from './style.js'

const BASE = '/amazon-image-studio'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))
const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url))

// 参考图上传限额（面板直接拖文件时用；超过就让用户先压缩）
const MAX_REFERENCE_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_UPLOAD_COUNT = 16

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// 统一的错误出口：readJson 抛的 405/415/403 要原样出去，不能一律压成 400，
// 否则前端（和验收脚本）分不清「参数不对」和「请求不合规」。
function failJson(res, err, fallback = 400, extra = {}) {
  const status = Number.isInteger(err?.status) ? err.status : fallback
  return json(res, status, { ok: false, error: String((err && err.message) || err), ...extra })
}

function version() {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return null }
}

// 只放行 lab/ 里的文件：拒绝 ..、点开头的路径和指到目录外的符号链接
function safeLabFile(rel) {
  if (!rel || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(LAB) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serve(req, res, file) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': statSync(file).size, 'cache-control': 'no-cache' })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

// /media 白名单：DATA_DIR 下的文件（图片/策划产物）与 assets/style-presets 预设板
function safeMediaFile(target) {
  if (!isAbsolute(target) || !existsSync(target)) return null
  const file = realpathSync(target)
  for (const base of [DATA_DIR, ASSETS]) {
    let root
    try { root = realpathSync(base) } catch { continue }
    if (file.startsWith(root + sep) && statSync(file).isFile()) return file
  }
  return null
}

// 只接受同源页面发来的 JSON
function readJson(req, max = 96 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('只接受 POST 请求'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('请求体必须是 application/json'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('跨源请求被拒绝'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

function maskKey(key) {
  const value = String(key ?? '')
  if (!value) return ''
  if (value.length <= 8) return '*'.repeat(value.length)
  return `${value.slice(0, 4)}****${value.slice(-4)}`
}

function meta() {
  const countOptions = Array.from({ length: 6 }, (_, index) => 7 + index)
  return {
    listing: {
      defaultCount: 7,
      countOptions,
      slots: getAmazonListingImageSlots(7),
      range: formatAmazonListingSlotRange(7),
    },
    aplusTypes: ['standard-large', 'standard', 'premium', 'mobile'].map((type) => ({
      type,
      label: type === 'standard-large' ? '普通A+' : type === 'standard' ? '标准A+' : type === 'premium' ? '高级A+' : '手机A+',
      modules: normalizeAPlusModuleSpecs(type).map((spec) => ({
        slot: spec.slot, label: spec.label, displayLabel: spec.displayLabel,
        moduleType: spec.moduleType, uploadSize: `${spec.uploadWidth}x${spec.uploadHeight}`,
      })),
    })),
    maxAPlusModuleCount: MAX_A_PLUS_MODULE_COUNT,
    marketplaces: AMAZON_MARKETPLACES.map((m) => ({ id: m.id, label: m.label, shortLabel: m.shortLabel })),
    stylePresets: STYLE_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      palette: preset.palette,
      paletteEntries: getStylePaletteEntries(preset.palette),
      image: `${BASE}/media?path=${encodeURIComponent(join(ASSETS, 'style-presets', preset.fileName))}`,
    })),
    compliance: { listing: LISTING_COMPLIANCE_ZH, aplus: APLUS_COMPLIANCE_ZH },
  }
}

export function registerApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { ok: false, error: '未授权' })

        const url = new URL(req.url || '/', 'http://x')
        const rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        if (rest === '/api/ping') return json(res, 200, { ok: true, version: version() })

        if (rest === '/api/status') {
          const config = getConfig()
          return json(res, 200, {
            ok: true,
            version: version(),
            // 策划不再有独立 API：一律由对话里的模型完成
            planner: { mode: 'chat' },
            image: {
              configured: imageConfigured(),
              provider: normalizeImageProvider(String(config.imageProvider ?? DEFAULT_IMAGE_PROVIDER)),
              keySource: imageKeySource(),
              requireReferenceImages: referenceImagesRequired(),
              apiUrl: String(config.imageApiUrl ?? ''),
              model: String(config.imageModel ?? ''),
              apiKey: maskKey(config.imageApiKey),
              quality: String(config.imageQuality ?? 'low'),
              transparency: config.imageTransparency === true,
              outputTier: String(config.outputTier ?? '2K'),
            },
            dataDir: DATA_DIR,
          })
        }

        if (rest === '/api/meta') return json(res, 200, { ok: true, meta: meta() })

        if (rest === '/api/plans') return json(res, 200, { ok: true, plans: listPlans() })

        if (rest === '/api/plan') {
          const plan = url.searchParams.get('id')
          const found = plan && loadPlan(plan)
          return found ? json(res, 200, { ok: true, plan: found }) : json(res, 404, { ok: false, error: '没有这个策划档案' })
        }

        // 策划只走「填进对话」：面板不直连策划模型，这里只保留自策划指引接口（给页面兜底用）
        if (rest === '/api/plan/guide' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            return json(res, 200, { ok: true, agentPlanning: buildAgentPlanningGuide(body) })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/validate' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const archive = runValidatePlan(body)
            return json(res, 200, { ok: true, plan: archive })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/compose' && req.method === 'POST') {
          try {
            const body = await readJson(req, 1024 * 1024)
            const archive = loadPlan(String(body.planId ?? ''))
            if (!archive) return json(res, 404, { ok: false, error: '策划档案不存在' })
            const composed = composeSlotPrompt(archive, String(body.slot ?? ''), {
              stylePresetId: body.stylePresetId,
              templateImagePath: body.templateImagePath,
              styleDensityMode: body.styleDensityMode,
              tier: body.tier,
            })
            return json(res, 200, {
              ok: true,
              slot: composed.slot,
              prompt: composed.prompt,
              generationSize: composed.generationSize,
              styleReferenceAttached: composed.styleReferenceAttached,
              textTitle: composed.textTitle,
              textBody: composed.textBody,
              planMarkdown: composed.entry.planMarkdown,
              label: composed.entry.label,
              moduleType: composed.entry.moduleType,
              uploadSize: composed.entry.uploadSize,
            })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/generate' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const result = await runGenerate(body)
            return json(res, 200, { ok: true, ...result })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/settings' && req.method === 'GET') {
          return json(res, 200, { ok: true, settings: readSettings(ctx) })
        }

        if (rest === '/api/settings' && req.method === 'POST') {
          try {
            const body = await readJson(req, 1024 * 1024)
            const settings = await saveSettings(ctx, body)
            return json(res, 200, { ok: true, settings })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/references' && req.method === 'GET') {
          return json(res, 200, {
            ok: true,
            files: listReferences().map((item) => ({
              ...item,
              url: `${BASE}/media?path=${encodeURIComponent(item.path)}`,
            })),
          })
        }

        if (rest === '/api/upload' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const files = Array.isArray(body.files) ? body.files : []
            if (!files.length) return json(res, 400, { ok: false, error: 'files 必须是数组且至少一张' })
            if (files.length > MAX_REFERENCE_UPLOAD_COUNT) {
              return json(res, 400, { ok: false, error: `一次最多上传 ${MAX_REFERENCE_UPLOAD_COUNT} 张参考图` })
            }
            const saved = []
            const failed = []
            for (const item of files) {
              const name = String(item?.name ?? `reference-${saved.length + 1}`)
              try {
                const raw = String(item?.data ?? '')
                const match = raw.match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/i)
                if (!match) throw new Error('参考图必须是 PNG / JPG / WebP 的 data URL')
                const bytes = Buffer.from(match[2], 'base64')
                if (!bytes.length) throw new Error('参考图内容为空')
                if (bytes.length > MAX_REFERENCE_UPLOAD_BYTES) {
                  throw new Error(`单张参考图上限 ${Math.round(MAX_REFERENCE_UPLOAD_BYTES / 1024 / 1024)}MB，请先压缩`)
                }
                const file = saveReference(bytes, match[1])
                saved.push({
                  name,
                  path: file,
                  size: bytes.length,
                  url: `${BASE}/media?path=${encodeURIComponent(file)}`,
                })
              } catch (err) {
                failed.push({ name, error: String(err?.message ?? err) })
              }
            }
            if (!saved.length) return json(res, 400, { ok: false, error: failed[0]?.error ?? '上传失败', failed })
            return json(res, 200, { ok: true, files: saved, failed })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/references/remove' && req.method === 'POST') {
          try {
            const body = await readJson(req, 1024 * 1024)
            const removed = removeReference(String(body.path ?? ''))
            return json(res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : '参考图不存在或不在参考图目录里' })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/tag' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            if (!Array.isArray(body.files)) return json(res, 400, { ok: false, error: 'files 必须是数组' })
            const outDir = typeof body.outDir === 'string' && body.outDir ? body.outDir : IMAGES_DIR
            const results = []
            let tagged = 0
            let failed = 0
            const { tagSyntheticPerformerBytes, checkSyntheticPerformerBytes, getSyntheticPerformerMediaMimeType } = await import('./tagger.js')
            for (const item of body.files) {
              try {
                const bytes = Buffer.from(String(item.data ?? ''), 'base64')
                const name = String(item.name ?? `file-${results.length + 1}`)
                const mime = getSyntheticPerformerMediaMimeType(name)
                if (!mime) throw new Error('仅支持 JPG、PNG、WebP、MP4、MOV')
                if (bytes.length > 50 * 1024 * 1024) throw new Error('面板打标单文件上限 50MB，更大的文件请在对话里让 agent 用 amz_tag_performer 处理')
                const already = checkSyntheticPerformerBytes(bytes, name)
                if (already && body.action !== 'force') {
                  results.push({ name, status: 'already-tagged' })
                  continue
                }
                const taggedResult = tagSyntheticPerformerBytes(bytes, name)
                const target = join(outDir, `tagged-${Date.now().toString(36)}-${name.replace(/[^\w.-]/g, '_')}`)
                writeFileSync(target, taggedResult.bytes)
                tagged += 1
                results.push({
                  name,
                  status: 'tagged',
                  download: `${BASE}/media?path=${encodeURIComponent(target)}&download=1`,
                })
              } catch (err) {
                failed += 1
                results.push({ name: String(item?.name ?? ''), status: 'failed', error: String(err?.message ?? err) })
              }
            }
            return json(res, 200, { ok: failed === 0, tagged, failed, results })
          } catch (err) {
            return failJson(res, err, 400)
          }
        }

        if (rest === '/api/plans/remove' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return failJson(res, body, 400)
          const removed = removePlan(String(body.id || ''))
          return json(res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : '没有这个档案' })
        }

        if (rest === '/api/history/remove' && req.method === 'POST') {
          const body = await readJson(req).catch((err) => err)
          if (body instanceof Error) return failJson(res, body, 400)
          const removed = removeGenerateRecord(String(body.id || ''))
          return json(res, removed ? 200 : 404, { ok: removed, error: removed ? undefined : '没有这条记录' })
        }

        if (rest === '/api/history/clear' && req.method === 'POST') {
          await readJson(req).catch(() => ({}))
          clearHistory()
          return json(res, 200, { ok: true })
        }

        if (rest === '/api/history' && req.method === 'GET') {
          const list = readHistory().filter((record) => record.kind === 'generate')
          return json(res, 200, { ok: true, list: list.slice(0, Number(url.searchParams.get('limit')) || 60), total: list.length })
        }

        if (rest === '/media') {
          const target = url.searchParams.get('path')
          const file = target && safeMediaFile(target)
          if (!file) return json(res, 404, { ok: false, error: 'not found' })
          serve(req, res, file)
          return
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: '只读接口' })

        if (rest.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' })

        // 静态页面：/ → index.html
        const rel = rest === '/' ? 'index.html' : rest.replace(/^\/+/, '')
        const file = safeLabFile(rel)
        return file ? serve(req, res, file) : json(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        return json(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    }
  })
}

// dsh 0.2.x 宿主自带 token 鉴权；connection 服务缺席时放行（与其他插件一致，不 fail-closed）。
function requestRejection(ctx, req) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : null
  if (typeof connection?.requestRejection !== 'function') return false
  return connection.requestRejection({ headers: req.headers })
}
