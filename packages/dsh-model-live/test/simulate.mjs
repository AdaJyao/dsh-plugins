/**
 * dsh-model-live — Host 半边的离线仿真测试（不依赖任何 DSH 运行时）
 *
 * 用假的 ctx / webServer / llm 服务驱动真实插件代码，验证四件事：
 * 1. llm/stream 包装是**透明**的：chunk 逐个原样透传（同一对象），异常照抛。
 * 2. 观测正确：进行中/结束/失败/中断四种状态、usage 归类、TTL 速率估算。
 * 3. 模型元数据来自 llm.resolveModelInfo，并进入快照的 models 行。
 * 4. 路由可用：/state、/catalog、/clear、/events（SSE 快照 + tick + ping）。
 */
import assert from 'node:assert/strict'
import { apply, name } from '../lib/index.js'

assert.equal(name, 'dsh-model-live')

/** 造一个足够像 cordis 的假上下文。 */
function makeCtx() {
  const listeners = new Map()
  const services = new Map()
  let route = null
  const ctx = {
    on(event, callback) { listeners.set(event, callback); return () => listeners.delete(event) },
    get(service) { return services.get(service) },
    effect(factory) { const dispose = factory(); return typeof dispose === 'function' ? dispose : () => {} },
    inject(names, callback) { callback(ctx) },
    logger: { warn() {}, info() {}, error() {} },
    services,
    listeners,
    get route() { return route },
  }
  services.set('webServer', {
    register(entry) { route = entry; return () => { route = null } },
  })
  // 真实 cordis 里 ctx.inject(['webServer'], cb) 的 wsCtx 直接带 webServer 属性。
  Object.defineProperty(ctx, 'webServer', { get() { return services.get('webServer') } })
  services.set('llm', {
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek 官方' }, { id: 'ollama', name: 'Ollama' }],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: 'DeepSeek V4 Flash（视觉实验版）',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 262144 },
      defaultMaxTokens: 8192,
      reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'low', name: '低' }], defaultEffort: 'high' },
    }),
    listModels: async (provider) => [{ id: provider + '-model-a', name: '模型 A', description: '描述', inputModalities: ['text'] }],
  })
  return ctx
}

/** 假的 HTTP 响应对象，记录写出的内容。 */
function makeRes() {
  const res = {
    status: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) { res.status = status; res.headers = headers; return res },
    write(chunk) { res.chunks.push(String(chunk)); return true },
    end(chunk) { if (chunk !== undefined) res.chunks.push(String(chunk)); res.ended = true },
  }
  return res
}

/** 假的 HTTP 请求对象（POST 带 JSON 体，SSE 用 on('close')）。 */
function makeReq(body, method) {
  const handlers = new Map()
  return {
    method: method === undefined ? 'POST' : method,
    url: '/',
    on(event, callback) { handlers.set(event, callback); return this },
    emit(event) { const cb = handlers.get(event); if (cb) cb() },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
}

/** 走一次路由。 */
async function callRoute(ctx, path, body, method) {
  const res = makeRes()
  const req = makeReq(body, method)
  req.url = path
  await ctx.route.handler(req, res)
  return { res, req }
}

/** 从各种应答里取 JSON。 */
function jsonOf(res) {
  return JSON.parse(res.chunks.join(''))
}

/**
 * 组装一条假模型流。
 * 注意 next 的契约：调用 next() 得到的是「异步可迭代对象」，不是生成器函数本身。
 */
function streamOf(chunks) {
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

// 本测试只验证「本进程实时观测」这条路：清掉 DSH_HOME，插件就不会去扫真实会话目录，
// 断言因此是确定的（会话日志那条源由 e2e-inprocess.mjs 用合成日志覆盖）。
delete process.env.DSH_HOME
// 运行时日志采集走真实 SSH，测试里关掉（那条源由 test/runtime-log-scan.mjs 单独实测）。
process.env.DSH_MODEL_LIVE_RUNTIME = '0'

const ctx = makeCtx()
apply(ctx)
assert.ok(ctx.route !== null, '应当注册了 webServer 前缀路由')
assert.equal(ctx.route.kind, 'prefix')
assert.equal(ctx.route.path, '/_dsh/model-live')
const waterfall = ctx.listeners.get('llm/stream')
assert.equal(typeof waterfall, 'function', '应当挂上 llm/stream 瀑布')

/* ------------------------- 1. 透明性 + 进行中状态 ------------------------- */

const chunks = [
  { type: 'text-delta', index: 0, text: '你好' },
  { type: 'reasoning-delta', index: 1, text: '先想一想…' },
  { type: 'text-delta', index: 0, text: '，世界' },
  { type: 'tool-call-delta', index: 2, name: 'bash', argumentsDelta: '{"command":"ls"}' },
  { type: 'usage', usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 8000, reasoningTokens: 120 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

const seen = []
const stream = waterfall(
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    sessionId: 'session-abcdef12',
    system: 'x'.repeat(400),
    messages: [{}, {}, {}],
    tools: [{}, {}],
    reasoningEffort: 'high',
    maxTokens: 8192,
  },
  () => streamOf(chunks),
)

let midState = null
for await (const chunk of stream) {
  seen.push(chunk)
  if (seen.length === 3 && midState === null) {
    const { res } = await callRoute(ctx, '/_dsh/model-live/state', {})
    midState = jsonOf(res).data
  }
}

assert.equal(seen.length, chunks.length, 'chunk 个数必须一致')
for (let i = 0; i < chunks.length; i += 1) {
  assert.equal(seen[i], chunks[i], '第 ' + String(i) + ' 个 chunk 必须是同一个对象（原样透传）')
}

assert.equal(midState.active.length, 1, '进行中应当有 1 条')
assert.equal(midState.active[0].status, 'active')
assert.equal(midState.active[0].model, 'deepseek-v4-flash-vision-exp')
assert.equal(midState.active[0].messages, 3)
assert.equal(midState.active[0].tools, 2)
assert.equal(midState.active[0].systemChars, 400)
assert.equal(midState.recent.length, 0, '进行中的调用不进最近列表')
console.log('1) 透明透传 + 进行中快照 OK', JSON.stringify({
  textChars: midState.active[0].textChars,
  reasoningChars: midState.active[0].reasoningChars,
  toolNames: midState.active[0].toolNames,
  tps: midState.active[0].tps,
  tpsEstimated: midState.active[0].tpsEstimated,
}))

/* ---------------------------- 2. 结束后的统计 ---------------------------- */

// 等一次模型元数据解析 + 结构变化推送。
await new Promise((resolve) => setTimeout(resolve, 60))
const after = jsonOf((await callRoute(ctx, '/_dsh/model-live/state', {})).res).data
assert.equal(after.active.length, 0)
assert.equal(after.recent.length, 1)
const done = after.recent[0]
assert.equal(done.status, 'ok')
assert.equal(done.finishKind, 'tool-calls')
assert.equal(done.inputTokens, 1200)
assert.equal(done.outputTokens, 300)
assert.equal(done.cacheReadTokens, 8000)
assert.equal(done.reasoningTokens, 120)
assert.equal(done.contextTokens, 1200 + 300 + 8000)
assert.equal(done.contextWindow, 262144, '上下文窗口应来自 resolveModelInfo')
assert.equal(typeof done.contextPercent, 'number')
assert.deepEqual(done.toolNames, ['bash'])
assert.ok(done.durationMs >= 0)
assert.equal(done.errorMessage, null)
// 累计
assert.equal(after.totals.calls, 1)
assert.equal(after.totals.outputTokens, 300)
assert.equal(after.totals.totalTokens, 1200 + 300 + 8000)
assert.equal(after.providers.length, 2, '提供方来自 llm.listProviders')
// 模型行：元数据 + 实测统计
const modelRow = after.models.find((row) => row.model === 'deepseek-v4-flash-vision-exp')
assert.ok(modelRow !== undefined, '模型行应当存在')
assert.equal(modelRow.calls, 1)
assert.equal(modelRow.name, 'DeepSeek V4 Flash（视觉实验版）')
assert.equal(modelRow.contextWindow, 262144)
assert.equal(modelRow.maxTokens, 8192)
assert.deepEqual(modelRow.modalities, ['text', 'image'])
assert.deepEqual(modelRow.efforts, ['high', 'low'])
assert.equal(modelRow.defaultEffort, 'high')
assert.equal(modelRow.cacheHitPercent, Math.round((8000 / (1200 + 8000)) * 1000) / 10)
console.log('2) 结束统计 + 模型元数据 OK', JSON.stringify({ totals: after.totals, modelRow: { calls: modelRow.calls, cacheHitPercent: modelRow.cacheHitPercent, avgTps: modelRow.avgTps } }))

/* --------------------------- 3. 失败与中断路径 --------------------------- */

// 3a. 内核用 finish{reason:error} 表达适配器失败。
const errorStream = waterfall(
  { provider: 'ollama', model: 'qwen3.8-27b-iq4xs:latest', messages: [] },
  () => streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '限流', status: 429 } } }]),
)
for await (const chunk of errorStream) { /* 消费完 */ }

// 3b. 中间件/消费者异常必须原样抛回，同时记录为失败。
const boom = new Error('下游炸了')
const throwing = waterfall(
  { provider: 'ollama', model: 'gemma4:12b', messages: [] },
  () => (async function* () { yield { type: 'text-delta', text: 'a' }; throw boom })(),
)
let caught = null
try {
  for await (const chunk of throwing) { /* 消费 */ }
} catch (error) {
  caught = error
}
assert.equal(caught, boom, '异常必须原样抛回内核')

// 3c. 消费者提前退出（abort 常见形态）：生成器 return 也要结算。
const early = waterfall(
  { provider: 'ollama', model: 'gemma3:4b', messages: [] },
  () => streamOf([{ type: 'text-delta', text: 'x' }, { type: 'text-delta', text: 'y' }]),
)
for await (const chunk of early) break

await new Promise((resolve) => setTimeout(resolve, 60))
const mixed = jsonOf((await callRoute(ctx, '/_dsh/model-live/state', {})).res).data
const byModel = (id) => mixed.recent.find((row) => row.model === id)
assert.equal(byModel('qwen3.8-27b-iq4xs:latest').status, 'error')
assert.equal(byModel('qwen3.8-27b-iq4xs:latest').errorCode, 'RATE_LIMIT')
assert.equal(byModel('gemma4:12b').status, 'error')
assert.equal(byModel('gemma4:12b').errorMessage, '下游炸了')
assert.equal(byModel('gemma3:4b').status, 'closed')
assert.equal(mixed.totals.calls, 4)
assert.equal(mixed.totals.failed, 2)
assert.equal(mixed.recent.length, 4)
console.log('3) 失败/异常/提前退出 OK', JSON.stringify({ statuses: mixed.recent.map((row) => row.status), failed: mixed.totals.failed }))

/* ------------------------------ 4. 模型目录 ------------------------------ */

const catalog = jsonOf((await callRoute(ctx, '/_dsh/model-live/catalog', { provider: 'ollama' })).res).data
assert.equal(catalog.entries.length, 1)
assert.equal(catalog.entries[0].provider, 'ollama')
assert.equal(catalog.entries[0].models[0].id, 'ollama-model-a')
assert.equal(catalog.entries[0].cached, false)
const cachedAgain = jsonOf((await callRoute(ctx, '/_dsh/model-live/catalog', { provider: 'ollama' })).res).data
assert.equal(cachedAgain.entries[0].cached, true, '第二次应当命中 60 秒缓存')
console.log('4) 模型目录 + 缓存 OK')

/* -------------------------------- 5. SSE -------------------------------- */

const sseRes1 = makeRes()
const sseReq1 = makeReq(undefined, 'GET')
sseReq1.url = '/_dsh/model-live/events'
const sseRes2 = makeRes()
const sseReq2 = makeReq(undefined, 'GET')
sseReq2.url = '/_dsh/model-live/events'
await Promise.all([
  ctx.route.handler(sseReq1, sseRes1),
  ctx.route.handler(sseReq2, sseRes2),
])
assert.equal(sseRes1.headers['content-type'], 'text/event-stream; charset=utf-8')
assert.ok(sseRes1.chunks.join('').includes('event: snapshot'), 'SSE 首包应当是 snapshot')

// 跑一条长一点的流，让节拍器推 tick。
const liveStream = waterfall(
  { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] },
  () => (async function* () {
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      yield { type: 'text-delta', text: '字'.repeat(20) }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 240 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
)
const consumed = (async () => { for await (const chunk of liveStream) { /* 消费 */ } })()
await new Promise((resolve) => setTimeout(resolve, 500))
const text1 = sseRes1.chunks.join('')
assert.ok(text1.includes('event: tick'), '应当收到 tick 事件')
assert.ok(text1.includes('"status":"active"'), 'tick 里应当有进行中的调用')
await consumed
await new Promise((resolve) => setTimeout(resolve, 300))
const text2 = sseRes1.chunks.join('')
assert.ok(text2.includes('"finishKind":"stop"'), '结束后应当推一份含 finish 的快照')
const text2b = sseRes2.chunks.join('')
assert.ok(text2b.includes('event: snapshot'), '第二个连接也应当收到快照')
assert.ok(text2b.includes('event: tick'), '第二个连接也应当收到 tick')
// 用「同一时刻之后」的两份累计内容比较：text2 与 text2b 都是收尾后读取的。
const framesOf = (text) => (text.match(/^event: /gm) || []).length
assert.ok(Math.abs(framesOf(text2) - framesOf(text2b)) <= 1,
  '两个连接的帧数应当基本一致：' + String(framesOf(text2)) + ' vs ' + String(framesOf(text2b)))

// 断开一个连接：不应影响另一个，也不应报错。
sseReq1.emit('close')
const before = sseRes2.chunks.length
await new Promise((resolve) => setTimeout(resolve, 350))
assert.ok(sseRes2.chunks.length >= before, '另一个连接应当继续可用')
console.log('5) SSE 快照/tick/断开 OK', JSON.stringify({ frames: sseRes1.chunks.length, connected: true }))

/* -------------------------------- 6. 清空 -------------------------------- */

const cleared = jsonOf((await callRoute(ctx, '/_dsh/model-live/clear', {})).res).data
assert.equal(cleared.totals.calls, 0)
assert.equal(cleared.recent.length, 0)
// 清空只清「记录与统计」：已经解析到的模型元数据行保留，但计数必须归零。
for (const row of cleared.models) {
  assert.equal(row.calls, 0, String(row.model) + ' 的调用数应当归零')
  assert.equal(row.outputTokens, 0)
  assert.equal(row.avgTps, null)
}
assert.ok(cleared.models.length >= 1, '模型元数据行应当保留（下次调用不必重新解析）')
console.log('6) 清空 OK')

/* ------------------------------ 7. 未知方法 ------------------------------ */

const unknown = makeRes()
const unknownReq = makeReq({}, 'POST')
unknownReq.url = '/_dsh/model-live/nope'
await ctx.route.handler(unknownReq, unknown)
assert.equal(unknown.status, 404)
console.log('7) 未知方法 404 OK')

console.log('\n全部仿真断言通过 ✅')
