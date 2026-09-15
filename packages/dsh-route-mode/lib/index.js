/**
 * dsh-route-mode — Host 半边（跑在 DSH 进程里）
 *
 * 只做两件事，都不碰会话本身：
 *  1. 记一份「会话 → 执行模式」的内存台账（cloud / local / hybrid），供浏览器半边读写；
 *  2. 按台账往 systemPrompt.context 注入一段执行路由指令，决定云端模型这一轮的职责。
 *
 * Host↔Client 通道：静态插件没有 harness 全局，走 webServer HTTP 路由
 *  - GET  /_dsh/route-mode/state?sessionId=...                  读台账
 *  - POST /_dsh/route-mode/state  {sessionId}                   读台账
 *  - POST /_dsh/route-mode/set    {sessionId,mode,localModel}   写台账
 * 路由挂在 /_dsh/ 前缀下（门户网关 bridge.mjs 的改写表已覆盖该前缀）。
 *
 * 本插件不落盘、不改会话记录、不发起对外网络请求；停用即彻底回滚。
 */

export const name = 'dsh-route-mode'

/** Host 路由前缀。 */
const ROUTE_PREFIX = '/_dsh/route-mode'
/** 允许的执行模式。 */
const MODES = ['cloud', 'local', 'hybrid']
/** 内存台账最多记住多少个会话（FIFO 淘汰，防长跑进程无界增长）。 */
const MAX_SESSIONS = 256
/** 请求体上限（字节），防止异常大包。 */
const MAX_BODY = 16 * 1024
/** 指令段在提示词里的排序位（沙箱策略是 110，本段排在更后）。 */
const CONTEXT_ORDER = 320

/**
 * 会话台账：sessionId → { mode, touched, localModel, seq }。
 * `touched=false` 表示用户还没点过按钮，此时**不注入任何指令**（不改变原有行为）。
 */
const ledger = new Map()

/**
 * 模式的中文名。
 * @param {string} mode - cloud / local / hybrid。
 * @returns {string} 中文名。
 */
function modeLabel(mode) {
  if (mode === 'local') return '本地'
  if (mode === 'hybrid') return '混合'
  return '云端'
}

/**
 * 造一段执行路由指令。
 * @param {{mode: string, localModel: string}} entry - 台账条目。
 * @returns {string} 注入提示词的文本。
 */
function directiveText(entry) {
  const model = entry.localModel !== '' ? entry.localModel : '（未指定，取本地模型选择器当前项）'
  if (entry.mode === 'local') {
    return [
      '[执行路由 · 模式=本地]',
      '用户已把本会话切到本地执行：会话模型 = Ollama 本地模型「' + model + '」。',
      '全部工作由本地模型直接完成；不要再把任务转派给任务板/监督链。',
      '如实汇报结果与失败原因，不要假装完成。',
    ].join('\n')
  }
  if (entry.mode === 'hybrid') {
    return [
      '[执行路由 · 模式=混合]',
      '用户已选择混合模式：你（云端模型）是派单者、监督者与审核者，交付物一律由本地 Ollama 模型产出（默认：' + model + '）。',
      '1. 拆解任务并派单：写卡 → 入板 → 由监督链交给本地模型在 workspace 内执行；不要自己动手产出交付物。',
      '2. 机械验收只认退出码；不通过则读交付物 / 看图 / 复跑 accept 审核产物，输出逐条问题清单打回重改。',
      '3. 重改最多 3 轮、逐轮升档；通过后回写审计评论并汇报。',
      '4. 勘察结论、拆卡与最终汇报仍由你负责，这些不占用本地模型。',
    ].join('\n')
  }
  return [
    '[执行路由 · 模式=云端]',
    '用户已选择云端模式：由你（云端模型）直接执行任务，本会话不再强制走本地派单链路（用户显式授权，优先于默认派单纪律）。',
    '安全红线与文件落盘规范仍然适用。',
  ].join('\n')
}

/**
 * 取（必要时新建）某会话的台账条目，并按上限淘汰最老的。
 * @param {string} sessionId - 会话 id。
 * @returns {object} 台账条目（原地可变）。
 */
function ensureEntry(sessionId) {
  const existing = ledger.get(sessionId)
  if (existing !== undefined) return existing
  const created = { mode: 'cloud', touched: false, localModel: '', seq: 0 }
  ledger.set(sessionId, created)
  while (ledger.size > MAX_SESSIONS) {
    const oldest = ledger.keys().next().value
    if (oldest === undefined) break
    ledger.delete(oldest)
  }
  return created
}

/**
 * 从装配上下文里解出当前会话 id。
 * @param {object} context - systemPrompt 的装配上下文。
 * @returns {string|null} 会话 id，取不到返回 null。
 */
function sessionIdOf(context) {
  if (context === null || typeof context !== 'object') return null
  const agent = context.agent
  if (agent === null || typeof agent !== 'object') return null
  const session = agent.session
  if (session === null || typeof session !== 'object') return null
  const id = session.id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * 读请求体并解析 JSON。
 * @param {object} req - Node 请求对象（异步可迭代）。
 * @returns {Promise<object>} 解析出的对象，空体或非法 JSON 返回 {}。
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) break
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 回一个 JSON 响应。
 * @param {object} res - Node 响应对象。
 * @param {number} status - HTTP 状态码。
 * @param {object} payload - 响应体。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 组装对外可见的台账视图。
 * @param {string} sessionId - 会话 id。
 * @param {object|null} entry - 台账条目。
 * @returns {object} 可 JSON 化的视图。
 */
function viewOf(sessionId, entry) {
  return {
    sessionId,
    mode: entry === null ? 'cloud' : entry.mode,
    label: modeLabel(entry === null ? 'cloud' : entry.mode),
    touched: entry === null ? false : entry.touched === true,
    localModel: entry === null ? '' : entry.localModel,
    seq: entry === null ? 0 : entry.seq,
    modes: MODES.slice(),
  }
}

/**
 * 挂载插件。
 * @param {object} ctx - Cordis 上下文。
 */
export function apply(ctx) {
  // ① Host↔Client 通道。ctx.inject 保证 webServer 就绪后再注册（apply 时它可能还没挂载）。
  ctx.inject(['webServer'], (wsCtx) => {
    wsCtx.effect(() => wsCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      async handler(req, res) {
        try {
          const url = new URL(req.url || '/', 'http://dsh.internal')
          const method = url.pathname.replace(/^\/_dsh\/route-mode\/?/, '').split('/')[0] || 'state'

          if (method === 'state') {
            if (req.method === 'GET' || req.method === 'HEAD') {
              const sessionId = url.searchParams.get('sessionId') || ''
              return sendJson(res, 200, { ok: true, data: viewOf(sessionId, ledger.get(sessionId) || null) })
            }
            const payload = await readBody(req)
            const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
            return sendJson(res, 200, { ok: true, data: viewOf(sessionId, ledger.get(sessionId) || null) })
          }

          if (method === 'set') {
            const payload = await readBody(req)
            const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
            if (sessionId === '') {
              return sendJson(res, 400, { ok: false, error: { message: '缺少 sessionId' } })
            }
            const entry = ensureEntry(sessionId)
            if (MODES.indexOf(payload.mode) !== -1) {
              entry.mode = payload.mode
              entry.touched = true
            }
            if (typeof payload.localModel === 'string') entry.localModel = payload.localModel
            entry.seq += 1
            return sendJson(res, 200, { ok: true, data: viewOf(sessionId, entry) })
          }

          return sendJson(res, 404, { ok: false, error: { message: '未知路由方法：' + method } })
        } catch (error) {
          return sendJson(res, 500, {
            ok: false,
            error: { message: error !== null && error !== undefined && error.message ? error.message : String(error) },
          })
        }
      },
    }), 'route-mode: host routes')
  })

  // ② 提示词注入。ctx.inject 同样是为了等 systemPrompt 挂载完成。
  ctx.inject(['systemPrompt'], (spCtx) => {
    spCtx.effect(() => spCtx.systemPrompt.context({
      name: 'route-mode:execution-route',
      order: CONTEXT_ORDER,
      text: (context) => {
        const sessionId = sessionIdOf(context)
        if (sessionId !== null) {
          const entry = ledger.get(sessionId)
          if (entry === undefined || entry.touched !== true) return ''
          return directiveText(entry)
        }
        // 装配上下文里取不到会话 id（无 agent 的独立调用）：只有在整个台账里
        // **恰好只有一个**已点选过的会话时才回退注入，避免把 A 会话的模式串到 B 会话。
        const touched = []
        for (const entry of ledger.values()) {
          if (entry.touched === true) touched.push(entry)
        }
        return touched.length === 1 ? directiveText(touched[0]) : ''
      },
    }), 'route-mode: prompt context')
  })
}
