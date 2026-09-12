/**
 * dsh-api-balance — Host 端
 *
 * 只读查询 DeepSeek 官方余额接口 `/user/balance`，经 webServer HTTP 路由提供给浏览器半边。
 *
 * 三条不可动摇的约束：
 * 1. 只读：没有任何充值、扣费、写操作，也不改用户账户设置。
 * 2. 查询节奏与官方更新节奏一致：对官方接口的调用不快于每 5 分钟一次，
 *    且「失败」也计入这个节奏（按 attemptAt 判定），所以刷新页面、多开标签、
 *    多个界面同时轮询都不会额外打到官方接口。
 * 3. 密钥不落地：凭据由 Host 的 credentials 服务解析，经 stdin 交给 curl 的配置
 *    解析器 —— 不进 argv（ps 看不到）、不进子进程环境、不写文件、不下发浏览器。
 *
 * 状态模型（关键）：「最近一次尝试」与「最近一次成功读数」是两件事。
 * 前者决定展示形态（fresh/stale/error）与限速，后者是失败时唯一能拿出来的事实。
 * 两者混成一个变量会导致「成功一次反而丢掉新值」—— 这正是早期版本的缺陷。
 */

/** Cordis 插件名（与包名一致，便于在插件清单里对上）。 */
export const name = 'dsh-api-balance'

/** 对官方接口的最小调用间隔（毫秒）。 */
const API_INTERVAL_MS = 5 * 60 * 1000
/** 官方余额接口。 */
const ENDPOINT = 'https://api.deepseek.com/user/balance'
/**
 * HTTP 路由前缀。刻意挂在 `/_dsh/` 之下：当 DSH 部署在门户或反向代理
 * 之后时，网关通常只转发一组固定的路径前缀，而 `/_dsh/` 是常见的既有
 * 前缀之一 —— 选它可以让本路由在直连端口与门户路径下都可达，无需改
 * 网关配置。
 */
const ROUTE_PREFIX = '/_dsh/api-balance'
/** curl 绝对路径（不依赖 PATH）。 */
const CURL = '/usr/bin/curl'

/**
 * 注册 Host 半边。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  /** 最近一次成功读数的叶子标量，或 null。 */
  let lastSuccess = null
  /** 最近一次尝试：{ attemptAt, ok, error }，或 null。 */
  let lastAttempt = null
  /** 进行中的查询，用于合并并发请求。 */
  let pending = null

  /** 只取叶子标量并限长：内部活数据不做整体拷贝。 */
  function text(value, max) {
    if (typeof value === 'string') return value.length > max ? value.slice(0, max) : value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return null
  }

  /** 错误信息压成一行短文本，避免把堆栈带到界面上。 */
  function message(error) {
    return String(error && error.message ? error.message : error).slice(0, 200)
  }

  /** 解析 API 密钥。每次调用都重新解析，用户改了凭据下一轮即生效。 */
  async function readCredential() {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return { error: 'Host 未挂载 credentials 服务' }
    const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
    if (resolved === undefined) return { error: '未配置 DEEPSEEK_API_KEY' }
    const value = typeof resolved.value === 'string' ? resolved.value : ''
    if (value === '') return { error: 'DEEPSEEK_API_KEY 为空' }
    return { value, source: text(resolved.source, 40) }
  }

  /** 构造 curl 配置文件内容（经 stdin 传入，密钥不出现在命令行里）。 */
  function curlConfig(key) {
    const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return [
      'silent',
      'show-error',
      'max-time = 12',
      'url = "' + ENDPOINT + '"',
      'header = "Authorization: Bearer ' + escaped + '"',
      'header = "Accept: application/json"',
      'write-out = "\\n__HTTP__%{http_code}"',
    ].join('\n')
  }

  /** 向官方接口发起一次只读查询，返回成功读数或 { ok:false, error }。 */
  async function queryOfficial() {
    const credential = await readCredential()
    if (credential.error !== undefined) return { ok: false, error: credential.error }

    const shell = ctx.get('shell')
    if (shell === undefined) return { ok: false, error: 'Host 未挂载 shell 服务，无法发起查询' }

    let result
    try {
      result = await shell.run(shell.resolve({
        command: CURL + ' -K -',
        timeoutMs: 20000,
        stdoutMaxBytes: 65536,
        stdin: curlConfig(credential.value),
      }))
    } catch (error) {
      return { ok: false, error: '调用 shell 失败：' + message(error) }
    }

    const stdout = result && result.stdout && typeof result.stdout.text === 'string' ? result.stdout.text : ''
    const stderr = result && result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : ''
    const marker = stdout.lastIndexOf('__HTTP__')
    const status = marker === -1 ? null : Number(stdout.slice(marker + 8).trim())
    const body = (marker === -1 ? stdout : stdout.slice(0, marker)).trim()

    if (status !== 200) {
      const detail = status === null
        ? stderr.trim().slice(0, 160)
        : 'HTTP ' + String(status) + ' ' + body.slice(0, 160)
      return { ok: false, error: '官方接口查询失败：' + (detail === '' ? '无响应' : detail) }
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch (error) {
      return { ok: false, error: '官方返回不是 JSON：' + body.slice(0, 160) }
    }

    const infos = payload !== null && typeof payload === 'object' && Array.isArray(payload.balance_infos)
      ? payload.balance_infos
      : null
    if (infos === null || infos.length === 0) return { ok: false, error: '官方响应缺少 balance_infos' }

    // 优先人民币账户，没有则取第一条。
    let chosen = null
    for (let i = 0; i < infos.length; i += 1) {
      const info = infos[i]
      if (info !== null && typeof info === 'object' && info.currency === 'CNY') { chosen = info; break }
    }
    if (chosen === null) chosen = infos[0]

    return {
      ok: true,
      at: Date.now(),
      isAvailable: payload.is_available === true,
      currency: text(chosen.currency, 12),
      totalBalance: text(chosen.total_balance, 40),
      grantedBalance: text(chosen.granted_balance, 40),
      toppedUpBalance: text(chosen.topped_up_balance, 40),
      keySource: credential.source,
    }
  }

  /** 一次尝试：先落状态，再按状态生成回包。 */
  async function attempt() {
    const attemptAt = Date.now()
    const outcome = await queryOfficial()
    if (outcome.ok === true) {
      lastSuccess = {
        at: outcome.at,
        isAvailable: outcome.isAvailable,
        currency: outcome.currency,
        totalBalance: outcome.totalBalance,
        grantedBalance: outcome.grantedBalance,
        toppedUpBalance: outcome.toppedUpBalance,
        keySource: outcome.keySource,
      }
      lastAttempt = { attemptAt, ok: true, error: null }
      console.log('[api-balance] 官方余额已更新: ' + String(outcome.totalBalance))
    } else {
      lastAttempt = { attemptAt, ok: false, error: outcome.error }
      console.log('[api-balance] 查询失败: ' + outcome.error +
        (lastSuccess === null ? '' : '（界面沿用上次成功读数 ' + String(lastSuccess.totalBalance) + '）'))
    }
    return view()
  }

  /**
   * 生成给浏览器的回包。全部字段都是叶子标量，可直接 JSON 过桥。
   * @returns {{ok: boolean, at: number|null, attemptAt: number, stale: boolean, error: string|null,
   *   intervalMs: number, isAvailable: boolean|null, currency: string|null, totalBalance: string|null,
   *   grantedBalance: string|null, toppedUpBalance: string|null, keySource: string|null}}
   */
  function view() {
    if (lastAttempt === null || lastSuccess === null) {
      return {
        ok: false,
        at: null,
        attemptAt: lastAttempt === null ? Date.now() : lastAttempt.attemptAt,
        stale: false,
        error: lastAttempt === null ? '尚未查询' : lastAttempt.error,
        intervalMs: API_INTERVAL_MS,
        isAvailable: null,
        currency: null,
        totalBalance: null,
        grantedBalance: null,
        toppedUpBalance: null,
        keySource: null,
      }
    }
    return {
      ok: lastAttempt.ok === true,
      at: lastSuccess.at,
      attemptAt: lastAttempt.attemptAt,
      stale: lastAttempt.ok !== true,
      error: lastAttempt.error,
      intervalMs: API_INTERVAL_MS,
      isAvailable: lastSuccess.isAvailable,
      currency: lastSuccess.currency,
      totalBalance: lastSuccess.totalBalance,
      grantedBalance: lastSuccess.grantedBalance,
      toppedUpBalance: lastSuccess.toppedUpBalance,
      keySource: lastSuccess.keySource,
    }
  }

  /**
   * 取当前视图，必要时才真正查询官方接口。
   * @param {boolean} force - 忽略新鲜度缓存（仅供渲染层首屏使用，不改变官方调用节奏）。
   */
  async function current(force) {
    const fresh = lastAttempt !== null && Date.now() - lastAttempt.attemptAt < API_INTERVAL_MS
    if (fresh && force !== true) return view()
    if (pending !== null) return pending
    const run = attempt().catch((error) => {
      lastAttempt = { attemptAt: Date.now(), ok: false, error: '查询异常：' + message(error) }
      return view()
    })
    pending = run
    try {
      return await run
    } finally {
      if (pending === run) pending = null
    }
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  async function readBody(req) {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  // 静态插件没有 harness 全局：Host↔Client 走 webServer HTTP 路由。
  // ctx.inject 保证 webServer 就绪后再注册（apply 时它可能还没挂载）。
  ctx.inject(['webServer'], (wsCtx) => {
    wsCtx.effect(() => wsCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      async handler(req, res) {
        try {
          const url = new URL(req.url || '/', 'http://dsh.internal')
          const method = url.pathname.replace(/^\/_dsh\/api-balance\/?/, '').split('/')[0] || ''
          const payload = await readBody(req)
          if (method === 'balance') {
            const snapshot = await current(payload.force === true)
            return sendJson(res, 200, { ok: true, data: snapshot })
          }
          return sendJson(res, 404, { ok: false, error: { message: '未知方法: ' + method } })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: { message: message(error) } })
        }
      },
    }))
  })
}
