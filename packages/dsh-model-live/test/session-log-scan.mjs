/**
 * 会话日志观测（第二观测源）实测：直接扫真实会话日志，找回**别的 DSH 进程**里的模型调用。
 *
 * 这一条正是"插件只显示云端调用、看不到本地模型调用"的根因所在：
 * 本部署的本地模型（ollama）调用发生在 `dsh --profile headless` 拉起的执行者进程里，
 * 与 web 进程共用 $DSH_HOME/sessions，因此只能靠读日志看见。
 *
 * 用法: node test/session-log-scan.mjs [sessions 根目录]
 */
import assert from 'node:assert/strict'
import { SessionLogTailer } from '../lib/session-log.js'

const root = process.argv[2] === undefined
  ? (process.env.DSH_HOME === undefined ? '/vol1/@appdata/dsh-qddev/dsh-home/sessions' : process.env.DSH_HOME + '/sessions')
  : process.argv[2]

const calls = []
const tailer = new SessionLogTailer({
  root,
  backfillMs: 24 * 60 * 60 * 1000,
  tickMs: 40,
  maxFilesPerTick: 10,
  onCall: (call) => calls.push(call),
  warn: (text, error) => { console.error('warn:', text, error === undefined ? '' : String(error)) },
})
tailer.start()

// 让扫描器推进（每个文件每 tick 至多 512KB）；连续 1.5 秒没有新字节即认为收敛。
const limitMs = Number(process.argv[3] === undefined ? 25000 : process.argv[3])
const deadline = Date.now() + limitMs
let lastBytes = -1
let idleSince = Date.now()
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  if (tailer.stats.bytes !== lastBytes) {
    lastBytes = tailer.stats.bytes
    idleSince = Date.now()
    continue
  }
  if (Date.now() - idleSince > 1500) break
}
tailer.stop()

const byProvider = new Map()
for (const call of calls) {
  const key = call.provider + '/' + call.model
  const row = byProvider.get(key) ?? { count: 0, tokens: 0, ms: 0, sessions: new Set(), statuses: new Set() }
  row.count += 1
  row.tokens += call.usage === null ? 0 : call.usage.outputTokens
  row.ms += call.endedAt - call.startedAt
  row.sessions.add((call.sessionId ?? '?').slice(0, 12))
  row.statuses.add(call.status)
  byProvider.set(key, row)
}

console.log('扫描统计:', JSON.stringify(tailer.stats))
console.log('解析出调用:', calls.length, '次')
for (const [key, row] of [...byProvider].sort((a, b) => b[1].count - a[1].count)) {
  console.log('  ' + key + '  ' + row.count + ' 次 · 输出 ' + row.tokens + ' tok · 平均 ' +
    Math.round(row.ms / row.count) + 'ms · 会话 ' + row.sessions.size + ' 个 · 状态 ' + [...row.statuses].join('/'))
}

assert.ok(calls.length > 0, '应当从会话日志里解析出调用')
const local = calls.filter((call) => call.provider !== null && call.provider.startsWith('ollama'))
assert.ok(local.length > 0, '应当解析出本地（ollama）模型调用')

// 抽查一条本地调用的字段完整性
const sample = local.find((call) => call.usage !== null) ?? local[0]
console.log('\n样例（本地模型）:', JSON.stringify({
  session: (sample.sessionId ?? '').slice(0, 16),
  workspace: sample.cwd,
  preset: sample.preset,
  provider: sample.provider,
  model: sample.model,
  contextWindow: sample.contextWindow,
  turn: sample.turn,
  step: sample.step,
  durationMs: sample.endedAt - sample.startedAt,
  chunks: sample.chunks,
  textChars: sample.textChars,
  reasoningChars: sample.reasoningChars,
  toolNames: sample.toolNames,
  usage: sample.usage,
  finishKind: sample.finishKind,
  status: sample.status,
}, null, 1))
assert.ok(sample.chunks > 0, '应当统计到分片数')
assert.ok(sample.status === 'ok', '样例应当是正常结束')
assert.ok(typeof sample.model === 'string' && sample.model.length > 0)
assert.ok(sample.contextWindow === null || sample.contextWindow > 0, '上下文窗口应当来自 request/context')

console.log('\n✅ 会话日志观测可用：本地模型调用能被看见')
