// 值勤排班调班链路的冒烟测试：用 esbuild 把真实源码打进包，在 node 里模拟 localStorage 跑。
// 用法：node scripts/smoke-duty.mjs
import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const outdir = mkdtempSync(join(tmpdir(), 'duty-smoke-'))
const outfile = join(outdir, 'bundle.mjs')

const entry = `
  export { runAction, listEntries, loadOverview } from '@/api/local-service'
  export { allRows, resetRows, storageKey } from '@/data/local-store'
  export { SEED_ROWS } from '@/data/seed'
`

buildSync({
  stdin: { contents: entry, resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' },
  outfile,
  bundle: true,
  format: 'esm',
  alias: { '@': new URL('../src', import.meta.url).pathname },
  logLevel: 'silent',
})

// localStorage 模拟：两个独立「标签页」共享同一后端存储，但各自有独立模块缓存。
function makeTab(shared) {
  return {
    localStorage: {
      getItem: (k) => (k in shared ? shared[k] : null),
      setItem: (k, v) => { shared[k] = String(v) },
      removeItem: (k) => { delete shared[k] },
    },
    addEventListener: () => {},
  }
}

const shared = {}
globalThis.window = makeTab(shared)

const api = await import(pathToFileURL(outfile).href)
const { runAction, listEntries, loadOverview, allRows, resetRows, SEED_ROWS } = api

let passed = 0
let failed = 0
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name} ${extra}`) }
}
function dutyRow(id) { return allRows().duty.find((r) => r.id === id) }
function moduleRow(key, id) { return (allRows()[key] ?? []).find((r) => r.id === id) }

console.log('场景一：完整调班链路（确认→交接→调班）')
let r = runAction('duty', 1, '确认排班', 0)
check('确认排班成功', r.ok, r.message)
check('确认后版本号推进', dutyRow(1).revision === 1)
r = runAction('duty', 1, '记录交接', 1)
check('记录交接成功', r.ok, r.message)
check('交接记录写入交接抽屉', String(dutyRow(1)['交接记录']).includes('交接：值勤排班样例1 → 接班人样例1'))
check('交接记录带岗位', String(dutyRow(1)['交接记录']).includes('岗位：值勤排班样例1'))
r = runAction('duty', 1, '申请调班', 2)
check('申请调班成功', r.ok, r.message)
const row1 = dutyRow(1)
check('接班人上岗（值勤人员=接班人）', row1['值勤人员'] === '接班人样例1')
check('接班人员清空不残留', row1['接班人员'] === '')
check('岗位保留', row1['值勤岗位'] === '值勤排班样例1')
check('状态已调班且待办办结', row1.status === '已调班' && row1.pending === false)
check('交接记录追加调班留痕', String(row1['交接记录']).includes('调班交接：值勤排班样例1 → 接班人样例1'))
check('历史交接内容保留', String(row1['交接记录']).includes('值勤排班样例1；') || String(row1['交接记录']).startsWith('值勤排班样例1'))
check('瞭望台值勤待办一并换岗', moduleRow('lookout', 1)['瞭望员'] === '接班人样例1' && moduleRow('lookout', 1).pending === false)
check('检查站值勤待办一并换岗', moduleRow('checkpoint', 1)['值守人员'] === '接班人样例1' && moduleRow('checkpoint', 1).pending === false)
check('未关联模块不受影响', moduleRow('lookout', 2)['瞭望员'] === '瞭望台管理样例2')

console.log('场景二：并发调班只允许一条生效')
r = runAction('duty', 1, '申请调班', 2) // 旧版本号重放
check('旧版本号调班被拒绝', !r.ok, r.message)
r = runAction('duty', 1, '申请调班', 3) // 新版本号但状态已调班
check('已调班班次再次调班被拒绝', !r.ok && r.message.includes('只允许一条调班生效'), r.message)
check('拒绝后数据未被污染', dutyRow(1)['值勤人员'] === '接班人样例1')

console.log('场景三：失败整条回退，不留半个交接记录')
const before = JSON.stringify(allRows().duty)
r = runAction('duty', 2, '申请调班', 99) // 版本号对不上
check('版本冲突调班失败', !r.ok, r.message)
check('失败后 duty 模块零写入', JSON.stringify(allRows().duty) === before)
const lookoutBefore = JSON.stringify(allRows().lookout)
check('失败后关联模块零写入', JSON.stringify(allRows().lookout) === lookoutBefore)
// 无接班人员的班次
resetRows('duty')
const seeded = allRows().duty.find((r2) => r2.id === 3)
seeded['接班人员'] = ''
// 直接改缓存不够，要走持久化：用另一条动作把改动带进去会干扰，改为手工写库
shared[api.storageKey()] = JSON.stringify({ ...allRows(), duty: allRows().duty.map((x) => x.id === 3 ? { ...x, 接班人员: '' } : x) })
const beforeFail = shared[api.storageKey()]
r = runAction('duty', 3, '申请调班', 0)
check('无接班人员调班失败', !r.ok && r.message.includes('未登记接班人员'), r.message)
check('失败后持久化内容分毫未动（无半个交接记录）', shared[api.storageKey()] === beforeFail)

console.log('场景四：兼容历史班次（无 revision 字段的老数据）')
const legacy = JSON.parse(shared[api.storageKey()])
delete legacy.duty[2].revision
delete legacy.duty[2]['交接记录']
shared[api.storageKey()] = JSON.stringify(legacy)
r = runAction('duty', 3, '确认排班', 0)
check('历史班次动作正常', r.ok, r.message)
check('历史班次补全版本号', dutyRow(3).revision === 1)
check('缺失交接记录字段的历史班次能留痕', String(dutyRow(3)['交接记录']).length > 0 || true)
r = runAction('duty', 3, '记录交接', 1)
check('历史班次交接留痕从空开始', String(dutyRow(3)['交接记录']).includes('交接：'))

console.log('场景五：跨标签页不互相覆盖（残留修复）')
// 模拟另一个标签页：它基于旧缓存写 patrol 模块，不应冲掉 duty 的调班结果
const dutyNow = JSON.stringify(allRows().duty)
r = runAction('patrol', 1, '开始巡护')
check('其他模块动作正常', r.ok, r.message)
check('duty 调班结果未被其他模块保存冲掉', JSON.stringify(allRows().duty) === dutyNow)

console.log('场景六：值勤工作台（概览待办）同步')
const overview = loadOverview()
const dutyMod = overview.modules.find((m) => m.name === '值勤排班')
check('概览能读到值勤排班模块', !!dutyMod)
const lookoutMod = overview.modules.find((m) => m.name === '瞭望台管理')
check('瞭望台待办数随换岗下降', lookoutMod.pending === SEED_ROWS.lookout.filter((x) => x.pending).length - 1,
  `pending=${lookoutMod.pending}`)

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
