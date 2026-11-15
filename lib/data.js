// 数据层：策划档案 / 生图历史 / 图片落盘（$DSH_HOME/amazon-image-studio/）
// 不用宿主 assets/storage，自管文件（与 dsh-ecom-image 同款）。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'amazon-image-studio')
export const PLANS_DIR = join(DATA_DIR, 'plans')
export const IMAGES_DIR = join(DATA_DIR, 'images')
const HISTORY_FILE = join(DATA_DIR, 'history.json')

export function ensureDirs() {
  for (const dir of [DATA_DIR, PLANS_DIR, IMAGES_DIR]) {
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

export function listPlans() {
  ensureDirs()
  const list = []
  for (const name of readdirSync(PLANS_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const plan = JSON.parse(readFileSync(join(PLANS_DIR, name), 'utf8'))
      list.push({
        id: plan.id,
        mode: plan.mode,
        marketplaceId: plan.marketplaceId,
        title: plan.parsed?.title || '',
        slotCount: plan.mode === 'aplus' ? (plan.aPlusPlans?.length ?? 0) : (plan.plans?.length ?? 0),
        slots: plan.mode === 'aplus'
          ? (plan.aPlusPlans ?? []).map((p) => p.slot)
          : (plan.plans ?? []).map((p) => p.slot),
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
