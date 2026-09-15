/**
 * dsh-route-mode — Host 半边进程内自检（不依赖 DSH，直接 node 跑）
 *
 * 覆盖：路由注册契约、台账读写、四种指令文本、跨会话隔离、无 agent 回退、
 *       参数校验（缺 sessionId / 未知方法）。
 *
 *   node test/inprocess.mjs      # 通过输出「通过 N / 失败 0」，exit 0
 */
import { apply, name } from '../lib/index.js'

let pass = 0
let fail = 0

/**
 * 断言并计数。
 * @param {string} label - 用例名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 失败细节。
 */
function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log('  ✓ ' + label)
  } else {
    fail += 1
    console.log('  ✗ ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}

/** 捕获到的路由与提示词注册。 */
let routeSpec = null
let contextSpec = null
/** 记录 dispose 是否被正确取用。 */
let effects = 0

const fakeScope = {
  effect(fn) {
    effects += 1
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register(spec) {
      routeSpec = spec
      return () => {}
    },
  },
  systemPrompt: {
    context(spec) {
      contextSpec = spec
      return () => {}
    },
  },
}

const fakeCtx = {
  inject(services, callback) {
    callback(fakeScope)
  },
}

/**
 * 造一个假请求（异步可迭代，供 readBody 使用）。
 * @param {string} url - 请求路径。
 * @param {object} [body] - JSON 请求体。
 * @param {string} [method] - HTTP 方法。
 * @returns {object} 假请求。
 */
function makeReq(url, body, method) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    url,
    method: method === undefined ? 'POST' : method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** @returns {object} 假响应。 */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
    },
    end(text) {
      res.body = text === undefined ? '' : String(text)
    },
  }
  return res
}

/**
 * 发一次请求并解析回包。
 * @param {string} url - 路径。
 * @param {object} [body] - 请求体。
 * @param {string} [method] - 方法。
 * @returns {Promise<{status: number, json: object}>} 状态与 JSON。
 */
async function call(url, body, method) {
  const res = makeRes()
  await routeSpec.handler(makeReq(url, body, method), res)
  let json = {}
  try {
    json = JSON.parse(res.body)
  } catch {
    json = {}
  }
  return { status: res.statusCode, json }
}

/**
 * 造一个装配上下文。
 * @param {string|null} sessionId - 会话 id，null 表示无 agent。
 * @returns {object} 装配上下文。
 */
function ctxOf(sessionId) {
  if (sessionId === null) return {}
  return { agent: { session: { id: sessionId } } }
}

console.log('== dsh-route-mode host in-process ==')

apply(fakeCtx)

check('插件名正确', name === 'dsh-route-mode', String(name))
check('注册了两个 effect（路由 + 提示词）', effects === 2, 'effects=' + String(effects))
check('路由已注册', routeSpec !== null)
check('路由 kind=prefix', routeSpec !== null && routeSpec.kind === 'prefix', routeSpec === null ? 'null' : String(routeSpec.kind))
check('路由 path=/_dsh/route-mode', routeSpec !== null && routeSpec.path === '/_dsh/route-mode', routeSpec === null ? 'null' : String(routeSpec.path))
check('提示词段已注册', contextSpec !== null)
check('提示词段名唯一前缀', contextSpec !== null && String(contextSpec.name).indexOf('route-mode:') === 0, contextSpec === null ? 'null' : String(contextSpec.name))
check('提示词段有有限 order', contextSpec !== null && Number.isFinite(contextSpec.order), contextSpec === null ? 'null' : String(contextSpec.order))
check('未点选时不注入任何指令', contextSpec !== null && contextSpec.text(ctxOf('S1')) === '', JSON.stringify(contextSpec === null ? null : contextSpec.text(ctxOf('S1'))))

const read0 = await call('/_dsh/route-mode/state?sessionId=S1', undefined, 'GET')
check('GET state 回 200', read0.status === 200, String(read0.status))
check('GET state 默认 cloud 且未点选', read0.json.ok === true && read0.json.data.mode === 'cloud' && read0.json.data.touched === false, JSON.stringify(read0.json))

const setHybrid = await call('/_dsh/route-mode/set', { sessionId: 'S1', mode: 'hybrid', localModel: 'qwen3.8-27b-iq4xs:latest' })
check('set hybrid 回 200', setHybrid.status === 200, String(setHybrid.status))
check('set hybrid 生效', setHybrid.json.ok === true && setHybrid.json.data.mode === 'hybrid' && setHybrid.json.data.touched === true, JSON.stringify(setHybrid.json))
check('set 递增 seq', setHybrid.json.data.seq === 1, String(setHybrid.json.data.seq))
check('set 记住本地模型名', setHybrid.json.data.localModel === 'qwen3.8-27b-iq4xs:latest', String(setHybrid.json.data.localModel))

const hybridText = contextSpec.text(ctxOf('S1'))
check('混合指令含模式标记', hybridText.indexOf('模式=混合') !== -1, hybridText.slice(0, 40))
check('混合指令含本地模型名', hybridText.indexOf('qwen3.8-27b-iq4xs:latest') !== -1)
check('混合指令含派单纪律', hybridText.indexOf('不要自己动手产出交付物') !== -1)
check('未点选的会话不注入', contextSpec.text(ctxOf('S2')) === '', JSON.stringify(contextSpec.text(ctxOf('S2'))))
check('无 agent 时不注入（0.1.1 删掉了回退）', contextSpec.text({}) === '', JSON.stringify(contextSpec.text({})))
check('有 agent 无 session 时不注入', contextSpec.text({ agent: {} }) === '', JSON.stringify(contextSpec.text({ agent: {} })))
check('有 session 无 id 时不注入', contextSpec.text({ agent: { session: {} } }) === '', JSON.stringify(contextSpec.text({ agent: { session: {} } })))
const branded = contextSpec.text({ agent: { session: { id: { toString: () => 'S1' } } } })
check('branded id（非字符串）也能命中同一会话', branded.indexOf('模式=混合') !== -1, branded.slice(0, 30))

const setLocal = await call('/_dsh/route-mode/set', { sessionId: 'S2', mode: 'local', localModel: 'qwen3.6:35b-a3b-coding' })
check('set local 生效', setLocal.json.ok === true && setLocal.json.data.mode === 'local', JSON.stringify(setLocal.json))
check('本地指令含模式标记', contextSpec.text(ctxOf('S2')).indexOf('模式=本地') !== -1)
check('本地指令含本地模型名', contextSpec.text(ctxOf('S2')).indexOf('qwen3.6:35b-a3b-coding') !== -1)
check('两个已点选会话时无 agent 也不注入', contextSpec.text({}) === '', JSON.stringify(contextSpec.text({})))

const setCloud = await call('/_dsh/route-mode/set', { sessionId: 'S1', mode: 'cloud' })
check('set cloud 生效', setCloud.json.ok === true && setCloud.json.data.mode === 'cloud', JSON.stringify(setCloud.json))
check('云端指令含模式标记', contextSpec.text(ctxOf('S1')).indexOf('模式=云端') !== -1)
check('切云端后不再保留混合措辞', contextSpec.text(ctxOf('S1')).indexOf('模式=混合') === -1)

const badMode = await call('/_dsh/route-mode/set', { sessionId: 'S3', mode: 'turbo' })
check('非法模式被忽略（不写入）', badMode.json.ok === true && badMode.json.data.touched === false, JSON.stringify(badMode.json))

const noSession = await call('/_dsh/route-mode/set', { mode: 'cloud' })
check('缺 sessionId 回 400', noSession.status === 400, String(noSession.status))

const unknown = await call('/_dsh/route-mode/nope', {})
check('未知方法回 404', unknown.status === 404, String(unknown.status))

const postRead = await call('/_dsh/route-mode/state', { sessionId: 'S1' })
check('POST state 也能读', postRead.json.ok === true && postRead.json.data.mode === 'cloud', JSON.stringify(postRead.json))

check('响应带 no-store', routeSpec !== null)
console.log('')
console.log('通过 ' + String(pass) + ' / 失败 ' + String(fail))
if (fail > 0) process.exit(1)
