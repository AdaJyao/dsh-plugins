/**
 * 运行时日志客户端（读独立服务）的离线测试：
 * 正常映射、服务不可达时的降级、以及"不重复触发 onUpdate"的节流。
 */
import assert from 'node:assert/strict'
import { RuntimeLogClient } from '../lib/runtime-client.js'

const sample = {
  ok: true,
  now: Date.now(),
  uptimeMs: 12345,
  pollMs: 5000,
  stats: { polls: 7, failures: 0, bytes: 4096, dropped: 0, lastAt: Date.now(), lastError: null },
  perf: { at: Date.now(), promptTps: 245.7, generateTps: 113.3, source: 'spark-x25-err' },
  sources: [
    { id: 'spark-x25-err', label: 'Spark（stderr）', path: 'C:\\llama\\logs\\spark-x25.err.log', host: 'win-omen', size: 41847, count: 357, lastAt: Date.now(), error: null, lines: [{ at: Date.now(), source: 'spark-x25-err', label: 'Spark（stderr）', level: 'info', text: 'ok' }] },
  ],
  lines: [{ at: Date.now(), source: 'spark-x25-err', label: 'Spark（stderr）', level: 'info', text: 'ok' }],
}

let calls = 0
let mode = 'ok'
let updates = 0
globalThis.fetch = async (url) => {
  calls += 1
  assert.ok(String(url).endsWith('/api/state'), '应当读 /api/state：' + String(url))
  if (mode === 'fail') throw new Error('ECONNREFUSED')
  if (mode === 'http500') return { ok: false, status: 500, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => sample }
}

const client = new RuntimeLogClient({ url: 'http://127.0.0.1:18610/', pollMs: 60000, onUpdate: () => { updates += 1 } })

// 1) 正常映射
await client.poll()
const view = client.view()
assert.equal(calls, 1)
assert.equal(view.standalone, true)
assert.equal(view.url, 'http://127.0.0.1:18610', '末尾斜杠应当被去掉')
assert.equal(view.running, true)
assert.equal(view.polls, 7)
assert.equal(view.bytes, 4096)
assert.equal(view.perf.generateTps, 113.3)
assert.equal(view.sources.length, 1)
assert.equal(view.sources[0].count, 357)
assert.equal(view.sources[0].lines.length, 1)
assert.equal(view.lines.length, 1)
assert.equal(updates, 1, '首次读取应当触发一次更新回调')

// 2) 同样的数据再来一次：不应当重复触发（避免无谓推送）
await client.poll()
assert.equal(updates, 1, '数据没变不应当再触发更新')

// 3) 服务不可达：降级但不丢旧数据，且如实标注
mode = 'fail'
await client.poll()
const degraded = client.view()
assert.equal(degraded.running, false)
assert.ok(String(degraded.lastError).includes('ECONNREFUSED'), '应当带上失败原因：' + String(degraded.lastError))
assert.equal(degraded.sources.length, 1, '旧数据应当保留（界面不至于空白）')
assert.equal(updates, 2, '状态由好变坏应当触发一次更新')

// 4) 恢复：再次拉到数据
mode = 'ok'
await client.poll()
assert.equal(client.view().running, true)
assert.equal(client.view().lastError, null)

// 5) HTTP 500 也算失败
mode = 'http500'
await client.poll()
assert.equal(client.view().running, false)
assert.ok(String(client.view().lastError).includes('500'))

client.stop()
console.log('✅ 运行时日志客户端：映射 / 降级 / 节流 全部符合预期')
