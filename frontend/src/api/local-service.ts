import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, updateRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

// 值勤排班里仍算「待办」的状态：已交接、已调班是终态，概览页的待处理数按这个口径统计。
const DUTY_OPEN_STATUSES = ['待确认', '已确认', '值勤中']

// 历史班次兼容：老数据里 pending、排班状态 可能和 status 对不上，读出来时按 status 归一，
// 不改存储里的原始记录；下次有动作落盘时会写回规范值。
function normalizeDutyRow(row: EntryRow): EntryRow {
  const status = String(row.status)
  return { ...row, pending: DUTY_OPEN_STATUSES.includes(status), 排班状态: status }
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const rows = key === 'duty' ? listRows(key).map(normalizeDutyRow) : listRows(key)
  const matched = filterRows(rows, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (key === 'duty') {
    return runDutyAction(meta, id, action)
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
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
  try {
    saveRows(key, next)
  } catch {
    return { ok: false, message: `${meta.entity}${action}失败：本机存储写入被拒绝，未做任何改动` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function dutyToday(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function dutyText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function appendHandover(row: EntryRow, entry: string): string {
  const existing = dutyText(row, '交接记录')
  return existing ? `${existing}；${entry}` : entry
}

// 值勤排班的动作牵动排班台账、交接记录和岗位关联，走专门的事务式处理：
// 在 updateRows 里基于最新持久化数据校验、一次性落盘，校验不过就整笔回退。
function runDutyAction(meta: ModuleMeta, id: number, action: string): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  let result: ActionResult = { ok: false, message: `${meta.entity}${action}没有执行` }
  try {
    updateRows(meta.key, (rows) => {
      const index = rows.findIndex((row) => Number(row.id) === id)
      if (index < 0) {
        result = { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
        return null
      }
      const row = rows[index]
      const current = String(row.status)
      if (current === target) {
        result = { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
        return null
      }
      // 已交接、已调班是终态：同一班次只允许一条调班/交接生效，并发的后来请求在这里被挡下。
      if (!DUTY_OPEN_STATUSES.includes(current)) {
        result = { ok: false, message: `该班次已是「${current}」，不能再${action}` }
        return null
      }
      const next = [...rows]
      if (action === '申请调班') {
        const successor = dutyText(row, '接班人员')
        if (!successor) {
          result = { ok: false, message: '该班次未登记接班人员，不能调班' }
          return null
        }
        // 原班次保留为历史，另开一条接班班次：岗位、日期、时段跟着走，关联写进交接记录。
        const baseCode = dutyText(row, '排班编号') || `DUTY-${id}`
        const rootCode = baseCode.replace(/-T\d+$/, '')
        const transferCount = rows.filter((item) =>
          String(item['排班编号'] ?? '').startsWith(`${rootCode}-T`),
        ).length
        const newCode = `${rootCode}-T${transferCount + 1}`
        const newId = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
        const handover = `${dutyToday()} 调班：${dutyText(row, '值勤人员')} → ${successor}`
        next[index] = {
          ...row,
          status: target,
          pending: false,
          abnormal: false,
          排班状态: target,
          交接记录: appendHandover(row, `${handover}，转入 ${newCode}`),
        }
        next.push({
          id: newId,
          status: '待确认',
          pending: true,
          abnormal: false,
          排班编号: newCode,
          值勤日期: row['值勤日期'] ?? '',
          值勤时段: row['值勤时段'] ?? '',
          值勤岗位: row['值勤岗位'] ?? '',
          值勤人员: successor,
          接班人员: '',
          交接记录: `${dutyToday()} 由 ${baseCode} 调班转入（${handover}）`,
          排班状态: '待确认',
        })
        result = { ok: true, message: `${meta.entity}已调班，新班次 ${newCode} 待确认` }
        return next
      }
      const updated: EntryRow = {
        ...row,
        status: target,
        pending: DUTY_OPEN_STATUSES.includes(target),
        abnormal: false,
        排班状态: target,
      }
      if (action === '记录交接') {
        const successor = dutyText(row, '接班人员')
        if (successor) {
          updated['值勤人员'] = successor
          updated['接班人员'] = ''
          updated['交接记录'] = appendHandover(
            row,
            `${dutyToday()} 交接：${dutyText(row, '值勤人员')} → ${successor}`,
          )
        } else {
          updated['交接记录'] = appendHandover(row, `${dutyToday()} 交接：未指定接班人员`)
        }
      }
      next[index] = updated
      result = { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
      return next
    })
  } catch {
    return { ok: false, message: `${meta.entity}${action}失败：本机存储写入被拒绝，已整体回退` }
  }
  return result
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
    const stored = rows[meta.key] ?? []
    const entries = meta.key === 'duty' ? stored.map(normalizeDutyRow) : stored
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
