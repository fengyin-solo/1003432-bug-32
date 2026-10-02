import { SEED_ROWS } from './seed'
import type { EntryRow, TransactResult } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 兼容历史班次：老数据没有 revision 等后补字段，读出来的时候统一补上默认值，
// 不额外写盘，下次正常保存时自然落进去。
function normalize(rows: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  for (const list of Object.values(rows)) {
    for (const row of list) {
      if (typeof row.revision !== 'number') {
        row.revision = 0
      }
    }
  }
  return rows
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalize(fallback)
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return normalize(fallback)
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return normalize({ ...fallback, ...parsed })
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return normalize(fallback)
  }
}

let cache: Record<string, EntryRow[]> | null = null

// 别的标签页写入后，本标签页的内存缓存直接作废，下次读取以持久化内容为准，
// 避免排班台账、交接抽屉、值勤工作台之间互相看到对方的旧数据。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  // 以持久化里的最新状态为底再覆盖本模块，避免旧的内存缓存把别的模块刚写入的内容冲掉。
  const next = { ...readStorage(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/**
 * 事务化改写：先读出持久化里的最新状态交给 mutator 校验、组装写集，
 * 全部写集一次落盘；校验失败或落盘失败都不写盘、不动缓存，整条回退，
 * 不会留下写了一半的交接记录。
 */
export function transact<T>(
  mutate: (
    current: Record<string, EntryRow[]>,
  ) => { writes: Record<string, EntryRow[]>; value: T } | { error: string },
): TransactResult<T> {
  const current = readStorage()
  const outcome = mutate(clone(current))
  if ('error' in outcome) {
    return { ok: false, message: outcome.error }
  }
  const next = { ...current, ...outcome.writes }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      return { ok: false, message: '本地存储写入失败，本次操作已整体回退' }
    }
  }
  cache = next
  return { ok: true, value: outcome.value }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
