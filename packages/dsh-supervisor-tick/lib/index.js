/**
 * dsh-supervisor-tick —— DSH 进程内的看门狗周期调度（Host 半边，无 UI）
 *
 * 为什么是插件而不是别的：
 *   * DSH 自带的 `@deepseek-ai/dsh-schedule` 是**会话级**的提醒器（durable
 *     reminder over the session event log），投递的是给 agent 的 prompt、
 *     不是 shell 命令，而且 `every_seconds` 最小 300（MIN_EVERY_INTERVAL_SECONDS），
 *     只在这个会话活着时才会按时触发 —— 挂不了 120 秒的 shell 看门狗。
 *   * 用户拍板：用 DSH 自带调度、**不要动系统 crontab / fnOS**。
 *     所以这里用 DSH 自己的插件机制（profile bundle）在 DSH 进程里起一个
 *     120 秒的 in-process 定时器 —— 调度声明、实现、日志全部落在 DSH 侧。
 *
 * 行为：
 *   * apply() 时立刻跑一次（trigger=boot），随后每 120 秒一次（trigger=interval）。
 *   * **不重入**：上一次还没跑完就跳过本次（日志记 skipped=true, reason=busy）——
 *     本地模型执行一张卡可能要几分钟，绝不允许叠跑。
 *   * 每次 tick 追加一行 JSON 到 <landing>/logs/schedule-tick.log，
 *     并把最近一次结果原子写到 <landing>/state/schedule-last.json（供复核）。
 *   * 落地目录不存在时只告警、不抛错（不能让 DSH 启动失败）。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis 插件名（与包名一致）。 */
export const name = 'dsh-supervisor-tick'

/** 周期（毫秒）—— 用户拍板的 120 秒。 */
export const INTERVAL_MS = 120_000

/**
 * 首次 tick 的延迟（毫秒），**必须 > 0**：apply() 发生在 DSH 启动过程中，
 * 那时 webServer 还没开始监听 23006，立刻跑 watchdog 会因为 task-board API
 * 「Connection refused」失败（2026-09-12 实测踩到，见 logs/schedule-tick.log 的
 * seq=1 记录）。等 web 起来再跑第一次。
 */
export const BOOT_DELAY_MS = 20_000

/** 落地根目录（可用环境变量覆盖，默认就是 dsh-supervisor-worker）。 */
const LAND = process.env.DSH_SUPERVISOR_ROOT
  || '/vol1/1000/DeepSeek herness/project/dsh-supervisor-worker'
const LOG = join(LAND, 'logs', 'schedule-tick.log')
const LAST = join(LAND, 'state', 'schedule-last.json')
const WATCHDOG = join(LAND, 'bin', 'watchdog.sh')

let busy = false
let tickSeq = 0
let last = null

function stamp() {
  return new Date().toISOString()
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

function logLine(obj) {
  try {
    mkdirSync(join(LAND, 'logs'), { recursive: true })
    appendFileSync(LOG, JSON.stringify(obj) + '\n')
  } catch (error) {
    console.error('[dsh-supervisor-tick] 写日志失败:', error?.message ?? error)
  }
}

/**
 * 跑一次 `bin/watchdog.sh --once`，并把结果记进日志与 last 快照。
 * 导出是为了让 `bin/schedule-register.sh --tick-now` 能在**不重启 DSH** 的情况下
 * 直接验证这条代码路径（interval 只负责按 120s 调它）。
 * @param {string} trigger - boot | interval | manual
 * @returns {Promise<object>} 本次 tick 的结果记录
 */
export async function tick(trigger = 'manual') {
  const startedAt = stamp()
  const t0 = Date.now()
  const seq = ++tickSeq
  if (busy) {
    const rec = { seq, trigger, at: startedAt, skipped: true, reason: 'busy', durationMs: 0 }
    logLine(rec)
    return rec
  }
  if (!existsSync(WATCHDOG)) {
    const rec = { seq, trigger, at: startedAt, skipped: true, reason: 'watchdog-missing',
      path: WATCHDOG, durationMs: 0 }
    logLine(rec)
    last = rec
    return rec
  }
  busy = true
  try {
    const res = await new Promise((resolve) => {
      const child = spawn('bash', [WATCHDOG, '--once'], {
        cwd: LAND,
        env: { ...process.env, DSH_SUPERVISOR_TICK_TRIGGER: trigger },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (c) => { out += c })
      child.stderr.on('data', (c) => { err += c })
      child.on('error', (e) => resolve({ code: -1, out, err: String(e?.message ?? e) }))
      child.on('close', (code) => resolve({ code, out, err }))
    })
    const rec = {
      seq, trigger, at: startedAt, finishedAt: stamp(),
      durationMs: Date.now() - t0,
      exit: res.code,
      stdoutTail: res.out.slice(-1500),
      stderrTail: res.err.slice(-800),
      skipped: false,
    }
    logLine(rec)
    last = rec
    try {
      atomicWrite(LAST, JSON.stringify(rec, null, 2) + '\n')
    } catch (error) {
      console.error('[dsh-supervisor-tick] 写快照失败:', error?.message ?? error)
    }
    return rec
  } finally {
    busy = false
  }
}

/** 最近一次 tick 记录（进程内）。 */
export function lastTick() {
  return last
}

/**
 * 注册存续期定时器。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 */
export function apply(ctx) {
  console.log(`[dsh-supervisor-tick] 已装载：每 ${INTERVAL_MS / 1000}s 跑一次 ${WATCHDOG} --once（首次延迟 ${BOOT_DELAY_MS / 1000}s）`)
  const start = () => {
    const boot = setTimeout(() => { void tick('boot') }, BOOT_DELAY_MS)
    const timer = setInterval(() => { void tick('interval') }, INTERVAL_MS)
    return () => { clearTimeout(boot); clearInterval(timer) }
  }
  // ctx.effect 的回调返回值就是销毁函数（cordis 语义），插件卸载时自动清理两个定时器。
  if (typeof ctx?.effect === 'function') {
    ctx.effect(start, 'dsh-supervisor-tick.interval')
    return
  }
  start()
}
