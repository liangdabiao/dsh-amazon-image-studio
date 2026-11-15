// 数据层：策划档案 / 生图历史 / 图片落盘（$DSH_HOME/amazon-image-studio/）
// 不用宿主 assets/storage，自管文件（与 dsh-ecom-image 同款）。
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'amazon-image-studio')
export const PLANS_DIR = join(DATA_DIR, 'plans')
export const IMAGES_DIR = join(DATA_DIR, 'images')
/** 面板上传的产品参考图（生图时作为 referenceImages 传给适配器）。 */
export const REFERENCES_DIR = join(DATA_DIR, 'references')
const HISTORY_FILE = join(DATA_DIR, 'history.json')

export function ensureDirs() {
  for (const dir of [DATA_DIR, PLANS_DIR, IMAGES_DIR, REFERENCES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

// 原子写：先写 .tmp 再 rename，避免并发读写截断。
export function atomicWrite(file, value) {
  writeFileSync(`${file}.tmp`, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
  renameSync(`${file}.tmp`, file)
}

// ---------------------------------------------------------------- 生图历史

export function readHistory() {
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeHistory(list) {
  ensureDirs()
  atomicWrite(HISTORY_FILE, list)
}

export function addHistoryRecord(record) {
  const list = readHistory()
  list.unshift(record)
  if (list.length > 500) list.length = 500
  writeHistory(list)
  return record
}

export function removeHistoryRecord(id) {
  const list = readHistory()
  const next = list.filter((item) => item.id !== id)
  if (next.length === list.length) return false
  writeHistory(next)
  return true
}

export function clearHistory() {
  writeHistory([])
}

// ---------------------------------------------------------------- 策划档案

export function planFile(id) {
  return join(PLANS_DIR, `${String(id).replace(/[^\w.-]/g, '_')}.json`)
}

export function savePlan(plan) {
  ensureDirs()
  const file = planFile(plan.id)
  atomicWrite(file, plan)
  return plan
}

export function loadPlan(id) {
  const file = planFile(id)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 某套策划已生成的图（按生成时间倒序）。面板「策划档案」用它显示封面与逐槽位成品。 */
export function planImages(planId) {
  if (!planId) return []
  return readHistory()
    .filter((record) => record.kind === 'generate' && record.planId === planId)
    .map((record) => ({
      id: record.id,
      slot: record.slot || null,
      file: record.file,
      exists: fileExists(record.file),
      generationSize: record.generationSize,
      actualSize: record.actualSize,
      quality: record.quality,
      price: record.price ?? null,
      createdAt: record.createdAt,
    }))
}

export function listPlans() {
  ensureDirs()
  const list = []
  for (const name of readdirSync(PLANS_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const plan = JSON.parse(readFileSync(join(PLANS_DIR, name), 'utf8'))
      const images = planImages(plan.id)
      list.push({
        id: plan.id,
        mode: plan.mode,
        marketplaceId: plan.marketplaceId,
        title: plan.parsed?.title || '',
        // 面板要展示「五点描述」和封面，档案列表必须带上，否则前端只能拿到空数组
        bullets: Array.isArray(plan.parsed?.bullets) ? plan.parsed.bullets : [],
        aPlusType: plan.aPlusType ?? null,
        tier: plan.tier ?? null,
        source: plan.source ?? null,
        stylePresetId: plan.stylePresetId ?? null,
        slotCount: plan.mode === 'aplus' ? (plan.aPlusPlans?.length ?? 0) : (plan.plans?.length ?? 0),
        slots: plan.mode === 'aplus'
          ? (plan.aPlusPlans ?? []).map((p) => p.slot)
          : (plan.plans ?? []).map((p) => p.slot),
        generatedCount: images.length,
        cover: images.find((item) => item.exists)?.file ?? null,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      })
    } catch { /* 损坏档案跳过 */ }
  }
  return list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function removePlan(id) {
  const file = planFile(id)
  if (!existsSync(file)) return false
  unlinkSync(file)
  return true
}

// ---------------------------------------------------------------- 图片落盘

export function saveImage(bytes, extension) {
  ensureDirs()
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  const file = join(IMAGES_DIR, `amz-${stamp}-${rand}.${extension.replace(/^\./, '')}`)
  writeFileSync(file, bytes)
  return file
}

export function fileExists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 参考图（面板上传）

const REFERENCE_EXT = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp' }

export function normalizeReferenceExtension(value) {
  return REFERENCE_EXT[String(value ?? '').trim().toLowerCase()] ?? null
}

/** 落盘一张面板上传的参考图，返回绝对路径。 */
export function saveReference(bytes, extension) {
  ensureDirs()
  const ext = normalizeReferenceExtension(extension)
  if (!ext) throw new Error('参考图只支持 PNG / JPG / WebP')
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const rand = Math.random().toString(36).slice(2, 8)
  const file = join(REFERENCES_DIR, `ref-${stamp}-${rand}.${ext}`)
  writeFileSync(file, bytes)
  return file
}

/** 只允许删除 REFERENCES_DIR 里的文件（防止面板接口被当成任意文件删除器）。 */
export function removeReference(target) {
  if (!target) return false
  let real
  try {
    real = realpathSync(target)
  } catch {
    return false
  }
  let root
  try {
    root = realpathSync(REFERENCES_DIR)
  } catch {
    return false
  }
  if (!real.startsWith(`${root}${sep}`) || !statSync(real).isFile()) return false
  unlinkSync(real)
  return true
}

/** 列出已上传的参考图（新的在前），面板刷新时用来恢复缩略图。 */
export function listReferences() {
  ensureDirs()
  return readdirSync(REFERENCES_DIR)
    .filter((name) => /^ref-.*\.(png|jpe?g|webp)$/i.test(name))
    .map((name) => {
      const file = join(REFERENCES_DIR, name)
      let size = 0
      try { size = statSync(file).size } catch { /* 并发删除 */ }
      return { name, path: file, size }
    })
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 64)
}
