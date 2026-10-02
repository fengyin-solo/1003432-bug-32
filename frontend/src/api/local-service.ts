import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, transact } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 值勤排班的调班/交接是一条跨模块事务：排班台账、交接记录、岗位关联一起变。
const DUTY_KEY = 'duty'
// 调班生效时，这些模块里的值勤待办（人名字段命中原值勤人员的行）一并换岗办结。
const DUTY_TODO_LINKS: Record<string, string> = {
  lookout: '瞭望员',
  checkpoint: '值守人员',
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedRevision?: number,
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === DUTY_KEY) {
    return runDutyAction(meta, id, action, target, expectedRevision)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 值勤排班动作：确认排班、记录交接、申请调班都走同一个事务。
 * 调班会把接班人转正上岗、补全岗位关联、追加交接记录，并把别的模块里
 * 原值勤人员的值勤待办一并换岗办结；任何一步校验不过就整条回退。
 */
function runDutyAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  target: string,
  expectedRevision?: number,
): ActionResult {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const result = transact<string>((current) => {
    const rows = current[DUTY_KEY] ?? []
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { error: `没有找到编号为 ${id} 的${meta.entity}` }
    }
    const row = rows[index]
    // 并发守卫一：期望版本与持久化版本不一致，说明同一班次刚在别处被改过。
    const revision = Number(row.revision ?? 0)
    if (expectedRevision !== undefined && expectedRevision !== revision) {
      return { error: '该班次刚在其他页面被更新，请刷新后重试，本次未写入任何内容' }
    }
    const currentStatus = String(row.status)
    // 并发守卫二：同一班次并发调班只允许一条生效，已调班的直接拒绝。
    if (action === '申请调班' && currentStatus === '已调班') {
      return { error: '该班次已完成调班，同一班次只允许一条调班生效' }
    }
    if (currentStatus === target) {
      return { error: `${meta.entity}已经是「${target}」，不用重复操作` }
    }

    const updated: EntryRow = {
      ...row,
      status: target,
      pending: target !== lastStatus,
      abnormal: false,
      revision: revision + 1,
    }
    const writes: Record<string, EntryRow[]> = {}
    let message = `${meta.entity}已${action}，当前状态「${target}」`

    if (action === '记录交接') {
      // 交接抽屉留痕：谁交给谁、哪个岗位、什么时间，追加进交接记录。
      updated['交接记录'] = appendHandover(row, handoverLine(row, '交接'))
    }

    if (action === '申请调班') {
      const successor = String(row['接班人员'] ?? '').trim()
      if (!successor) {
        return { error: '该班次未登记接班人员，无法调班，本次未写入任何内容' }
      }
      const predecessor = String(row['值勤人员'] ?? '').trim()
      // 补全新关联：接班人上岗接任值勤岗位，原班信息从台账清掉，交接记录留痕。
      updated['值勤人员'] = successor
      updated['接班人员'] = ''
      updated['交接记录'] = appendHandover(row, handoverLine(row, '调班交接', successor))
      // 别的模块的值勤待办一并更新：命中原值勤人员的值守行换岗并办结。
      for (const [moduleKey, personField] of Object.entries(DUTY_TODO_LINKS)) {
        const linked = current[moduleKey] ?? []
        let touched = false
        const nextLinked = linked.map((item) => {
          if (!predecessor || String(item[personField] ?? '').trim() !== predecessor) {
            return item
          }
          touched = true
          return {
            ...item,
            [personField]: successor,
            pending: false,
            revision: Number(item.revision ?? 0) + 1,
          }
        })
        if (touched) {
          writes[moduleKey] = nextLinked
        }
      }
      message = `${meta.entity}已${action}：${predecessor || '—'} → ${successor}，当前状态「${target}」`
    }

    const nextRows = [...rows]
    nextRows[index] = updated
    writes[DUTY_KEY] = nextRows
    return { writes, value: message }
  })
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  return { ok: true, message: result.value }
}

function nowStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// 交接记录是追加式台账：历史内容原样保留，新记录追加在后。
function appendHandover(row: EntryRow, line: string): string {
  const history = String(row['交接记录'] ?? '').trim()
  return history ? `${history}；${line}` : line
}

function handoverLine(row: EntryRow, verb: string, successor?: string): string {
  const from = String(row['值勤人员'] ?? '').trim() || '—'
  const to = (successor ?? String(row['接班人员'] ?? '').trim()) || '—'
  const post = String(row['值勤岗位'] ?? '').trim() || '—'
  return `${nowStamp()} ${verb}：${from} → ${to}，岗位：${post}`
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
