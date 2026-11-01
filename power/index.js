/**
 * 保持系统唤醒：在监督期间阻止宿主机因空闲进入睡眠，监督结束后立即释放。
 *
 * 两套后端，按可用性自动选择：
 *  1. Electron 的 powerSaveBlocker（官方桌面版，纯进程内调用，最干净）；
 *  2. 平台自带的命令行工具（纯 Node 宿主）：Windows 用 PowerShell 调
 *     SetThreadExecutionState，macOS 用 caffeinate，Linux 用 systemd-inhibit。
 *
 * 全部手段都不需要管理员权限、不写任何系统设置，进程退出即释放；
 * 外部 helper 还各自带"父进程消失就退出"的兜底，避免留下永久不休眠的机器。
 * WSL、容器、以及没有电池的台式机都会按实际情况降级，不假装成功。
 *
 * 另外顺便负责"睡醒自愈"的事件源：有 Electron 时订阅 powerMonitor 的挂起/恢复，
 * 没有时用墙钟跳变兜底；恢复后通知 core 与 retry 重算定时器。
 */

import { execFile as execFileCallback, spawn as spawnCallback } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'

import { errorText } from '../shared/util.js'
import {
  detectEnvironment,
  helperCandidates,
  normalizeKeepAwakeMode,
  parseMacBatteryState,
  parseWindowsBatteryStatus,
  readLinuxBatteryState,
  windowsBatteryQuery,
} from './platform.js'

/** Electron 模块只在宿主真的是 Electron 时才存在；失败一次就记住。 */
let electronModuleCache

function loadElectron() {
  if (electronModuleCache !== undefined) return electronModuleCache
  electronModuleCache = null
  if (typeof process.versions?.electron === 'string') {
    try {
      electronModuleCache = createRequire(import.meta.url)('electron')
    } catch {
      electronModuleCache = null
    }
  }
  return electronModuleCache
}

function execFileAsync(execFile, file, args, options) {
  return new Promise((resolve, reject) => {
    try {
      execFile(file, args, options, (error, stdout) => {
        if (error) reject(error)
        else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''))
      })
    } catch (error) {
      reject(error)
    }
  })
}

const CLOCK_TICK_MS = 15000
const RESUME_MIN_GAP_MS = 60000
const RESUME_DEDUPE_MS = 5000
const RETRY_MS = 300000
const MAX_STDERR = 4000

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../core/settings.js').createSettingsStore>} options.settings - 设置存储（读 keepAwake）。
 * @param {{info?:Function, warn?:Function}} [options.log] - 日志回调。
 * @param {string} [options.platform] - 平台，测试注入。
 * @param {object} [options.env] - 环境变量，测试注入。
 * @param {object} [options.io] - IO 注入（fs、child_process、计时器、Electron 加载）。
 */
export function createKeepAwake(options = {}) {
  const settings = options.settings
  const log = {
    info: typeof options.log?.info === 'function' ? options.log.info : () => {},
    warn: typeof options.log?.warn === 'function' ? options.log.warn : () => {},
  }
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const env = options.env ?? process.env
  const injected = options.io ?? {}
  const now = typeof injected.now === 'function' ? injected.now : Date.now
  // 单调时钟只增不减：挂起时它也会前进，但不像墙钟那样会被校时跳变拉走。
  const monotonic = typeof injected.monotonic === 'function' ? injected.monotonic : () => performance.now()
  const io = {
    exists: injected.exists ?? ((path) => existsSync(path)),
    readFile: injected.readFile ?? ((path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return ''
      }
    }),
    readdir: injected.readdir ?? ((path) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    }),
    spawn: injected.spawn ?? spawnCallback,
    execFile: injected.execFile ?? execFileCallback,
    setTimeout: injected.setTimeout ?? setTimeout,
    clearTimeout: injected.clearTimeout ?? clearTimeout,
    setInterval: injected.setInterval ?? setInterval,
    clearInterval: injected.clearInterval ?? clearInterval,
    electron: injected.electron ?? loadElectron,
    pid: Number.isFinite(injected.pid) ? injected.pid : process.pid,
    settleMs: Number.isFinite(injected.settleMs) ? injected.settleMs : undefined,
  }

  const electron = io.electron()
  const environment = detectEnvironment({
    platform,
    env,
    hasElectron: electron !== null && electron !== undefined,
    exists: io.exists,
    readFile: io.readFile,
  })

  const owners = new Set()
  const resumeListeners = new Set()

  let disposed = true
  let starting = false
  let holding
  let generation = 0
  let onBattery = null
  let since = 0
  let lastError
  let lastUnsupportedWarn
  let unsupported
  let lastResumeAt = 0
  let lastSuspendedMs = 0
  let lastClock = 0
  let lastMonotonic = 0
  let clockTimer
  let acTimer
  let retryTimer
  let monitorDisposer

  const disposers = []

  function mode() {
    try {
      return normalizeKeepAwakeMode(settings?.get?.()?.keepAwake)
    } catch {
      return 'ac-only'
    }
  }

  function desired() {
    if (disposed) return false
    if (owners.size === 0) return false
    const current = mode()
    if (current === 'off') return false
    // 拿不准电池状态时按“插电”处理：宁可能保住任务，也不要因为一次查询失败就关掉。
    return current === 'always' || onBattery !== true
  }

  function clearRetry() {
    if (retryTimer !== undefined) {
      io.clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  function scheduleRetry() {
    clearRetry()
    if (!desired()) return
    retryTimer = io.setTimeout(() => {
      retryTimer = undefined
      if (!desired() || holding !== undefined || starting) return
      void startHold('retry')
    }, RETRY_MS)
    retryTimer?.unref?.()
  }

  /* ── 后端：Electron powerSaveBlocker ── */

  function startElectronBlocker() {
    const blocker = electron?.powerSaveBlocker
    if (blocker === undefined || typeof blocker.start !== 'function') return undefined
    try {
      const id = blocker.start('prevent-app-suspension')
      if (typeof blocker.isStarted === 'function' && blocker.isStarted(id) === false) return undefined
      return { backend: 'electron', detail: 'prevent-app-suspension', handle: { kind: 'electron', id } }
    } catch (error) {
      lastError = errorText(error)
      return undefined
    }
  }

  function stopElectronBlocker(handle) {
    const blocker = electron?.powerSaveBlocker
    if (blocker === undefined || typeof blocker.stop !== 'function') return
    try {
      blocker.stop(handle.id)
    } catch {
      /* 宿主已经退出时 stop 会失败：不阻塞释放流程 */
    }
  }

  /* ── 后端：平台命令行 helper ── */

  function settleTime(backend) {
    if (io.settleMs !== undefined) return io.settleMs
    return backend === 'powershell' ? 2500 : 800
  }

  function startHelper(candidate) {
    return new Promise((resolve) => {
      let child
      try {
        child = io.spawn(candidate.file, candidate.args, {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        })
      } catch (error) {
        lastError = `${candidate.backend}: ${errorText(error)}`
        resolve(undefined)
        return
      }
      const entry = { child, stderr: '', exited: false, code: undefined, stopped: false }
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const describe = () => {
        const detail = entry.code === undefined ? '' : ` (exit ${String(entry.code)})`
        const message = entry.stderr.trim()
        return `${candidate.backend}${detail}${message === '' ? '' : `: ${message.slice(0, 300)}`}`
      }
      const onFailure = () => {
        lastError = describe()
        finish(undefined)
      }
      child.once?.('error', (error) => {
        entry.stderr = entry.stderr === '' ? errorText(error) : entry.stderr
        entry.exited = true
        onFailure()
      })
      child.once?.('exit', (code) => {
        entry.exited = true
        entry.code = code
        if (settled) {
          // 启动成功之后才退出：请求已经没了，标记出来等重试
          if (!entry.stopped && holding?.handle?.kind === 'helper' && holding.handle.entry === entry) {
            const backend = holding.backend
            holding = undefined
            generation += 1
            lastError = describe()
            // 报告成“启用失败”，否则设置页会把它显示成无害的“未生效”。
            unsupported = { reason: 'failed', detail: lastError }
            log.warn(`the keep-awake helper exited unexpectedly (${backend}); it will be retried later`)
            scheduleRetry()
          }
          return
        }
        onFailure()
      })
      child.stderr?.on?.('data', (chunk) => {
        if (entry.stderr.length < MAX_STDERR) entry.stderr += String(chunk)
      })
      const timer = io.setTimeout(() => {
        if (entry.exited) return
        finish({
          backend: candidate.backend,
          detail: candidate.file,
          handle: { kind: 'helper', entry },
        })
      }, settleTime(candidate.backend))
      timer?.unref?.()
    })
  }

  function stopHelper(handle) {
    const entry = handle.entry
    entry.stopped = true
    try {
      entry.child.kill?.('SIGTERM')
    } catch {
      /* 进程可能已经退出 */
    }
    const killer = io.setTimeout(() => {
      try {
        entry.child.kill?.('SIGKILL')
      } catch {
        /* 同上 */
      }
    }, 3000)
    killer?.unref?.()
  }

  async function selectAndStart() {
    const electronResult = startElectronBlocker()
    if (electronResult !== undefined) return { ok: true, ...electronResult }
    if (!environment.helperPlatform) {
      return { ok: false, reason: 'unsupported', detail: environment.unsupportedReason }
    }
    const candidates = helperCandidates({
      platform,
      env,
      parentPid: io.pid,
      exists: io.exists,
    })
    if (candidates.length === 0) {
      return { ok: false, reason: 'unsupported', detail: `no keep-awake helper found on ${platform}` }
    }
    for (const candidate of candidates) {
      const started = await startHelper(candidate)
      if (started !== undefined) return { ok: true, ...started }
    }
    return { ok: false, reason: 'failed', detail: lastError ?? `could not start a keep-awake helper on ${platform}` }
  }

  /* ── 电池 / 交流电状态 ── */

  async function probeBattery() {
    const monitor = electron?.powerMonitor
    if (monitor !== undefined && typeof monitor.isOnBatteryPower === 'function') {
      try {
        const value = monitor.isOnBatteryPower()
        if (typeof value === 'boolean') return value
      } catch {
        /* 退回平台探测 */
      }
    }
    try {
      if (platform === 'linux') return readLinuxBatteryState({ readdir: io.readdir, readFile: io.readFile })
      if (platform === 'darwin') {
        const output = await execFileAsync(io.execFile, '/usr/bin/pmset', ['-g', 'batt'], { timeout: 5000, windowsHide: true })
        return parseMacBatteryState(output)
      }
      if (platform === 'win32') {
        const query = windowsBatteryQuery(env)
        const output = await execFileAsync(io.execFile, query.file, query.args, { timeout: 20000, windowsHide: true })
        return parseWindowsBatteryStatus(output)
      }
    } catch {
      return null
    }
    return null
  }

  async function refreshBattery(trigger) {
    try {
      const previous = onBattery
      const value = await probeBattery()
      onBattery = typeof value === 'boolean' ? value : null
      if (previous !== onBattery && trigger !== 'attach') {
        log.info(`power source is now ${onBattery === true ? 'the battery' : onBattery === false ? 'AC' : 'unknown'}`)
      }
      evaluate(trigger)
    } catch (error) {
      log.warn(`could not read the power source: ${errorText(error)}`)
    }
  }

  function acPollMs() {
    // Linux 读 sysfs 几乎免费；macOS 起一个 pmset 进程约几十毫秒；Windows 要起 PowerShell，放慢。
    if (platform === 'linux') return 60000
    if (platform === 'darwin') return 120000
    return 300000
  }

  function stopAcWatch() {
    if (acTimer !== undefined) {
      io.clearInterval(acTimer)
      acTimer = undefined
    }
  }

  /**
   * 电池轮询跟着“监督中 + 插电时生效”走，而不是跟着持锁走：
   * 拔电释放锁之后仍要轮询，才能发现插回电源并重新持锁。
   */
  function syncAcWatch() {
    const wanted = !disposed && owners.size > 0 && mode() === 'ac-only' && electron?.powerMonitor === undefined
    if (!wanted) {
      stopAcWatch()
      return
    }
    if (acTimer !== undefined) return
    acTimer = io.setInterval(() => {
      void refreshBattery('poll')
    }, acPollMs())
    acTimer?.unref?.()
  }

  /* ── 挂起 / 恢复检测 ── */

  function reportResume(suspendedMs) {
    const stamp = now()
    if (stamp - lastResumeAt < RESUME_DEDUPE_MS) return
    lastResumeAt = stamp
    lastSuspendedMs = Math.max(0, Math.round(suspendedMs))
    log.info(`the system resumed after ${Math.round(lastSuspendedMs / 1000)}s suspended; re-arming supervision timers`)
    for (const listener of [...resumeListeners]) {
      try {
        listener({ at: stamp, suspendedMs: lastSuspendedMs })
      } catch (error) {
        log.warn(`a resume listener failed: ${errorText(error)}`)
      }
    }
    void refreshBattery('resume')
  }

  function startClockWatch() {
    lastClock = now()
    lastMonotonic = monotonic()
    clockTimer = io.setInterval(() => {
      const stamp = now()
      const gap = stamp - lastClock
      const monoGap = Math.max(0, monotonic() - lastMonotonic)
      lastClock = stamp
      lastMonotonic = monotonic()
      // 定时器在挂起期间被冻结：醒来后第一跳的间隔会远大于设定值。
      // 墙钟跳跃但单调时钟也走过同样的时间，说明是校时或事件循环停顿，不是睡醒。
      if (gap >= Math.max(CLOCK_TICK_MS * 2, RESUME_MIN_GAP_MS) && monoGap < gap / 2) reportResume(gap - CLOCK_TICK_MS)
    }, CLOCK_TICK_MS)
    clockTimer?.unref?.()
  }

  function startMonitorWatch() {
    const monitor = electron?.powerMonitor
    if (monitor === undefined || typeof monitor.on !== 'function') return
    // Electron 的 on() 返回 emitter 本身，不返回注销函数：注销要自己用 removeListener 做。
    const subscribe = (name, listener) => {
      try {
        monitor.on(name, listener)
        disposers.push(() => {
          try {
            const remove = monitor.removeListener ?? monitor.off
            if (typeof remove === 'function') remove.call(monitor, name, listener)
          } catch {
            /* 宿主已经拆掉服务 */
          }
        })
      } catch {
        /* 事件名在旧版 Electron 上可能不存在 */
      }
    }
    subscribe('suspend', () => {
      lastClock = now()
    })
    subscribe('resume', () => {
      lastClock = now()
      reportResume(0)
    })
    subscribe('on-ac', () => {
      onBattery = false
      evaluate('ac')
    })
    subscribe('on-battery', () => {
      onBattery = true
      evaluate('battery')
    })
  }

  /* ── 生命周期 ── */

  function acquireHandle(result) {
    holding = {
      backend: result.backend,
      detail: result.detail,
      handle: result.handle,
      pid: result.handle?.kind === 'helper' ? result.handle.entry.child?.pid : undefined,
    }
    since = now()
    unsupported = undefined
    lastError = undefined
    lastUnsupportedWarn = undefined
    log.info(`keeping the system awake (${result.backend})`)
  }

  function releaseHandle(handle) {
    if (handle === undefined) return
    if (handle.kind === 'electron') stopElectronBlocker(handle)
    else stopHelper(handle)
  }

  async function startHold(trigger) {
    if (starting || holding !== undefined || disposed) return
    starting = true
    const token = generation
    let result
    try {
      result = await selectAndStart()
    } catch (error) {
      // 注入的 IO 或 helper 构造抛出时也要落成一次“启动失败”，不能让 promise 悬着。
      result = { ok: false, reason: 'failed', detail: errorText(error) }
    } finally {
      starting = false
    }
    if (result.ok !== true) {
      unsupported = { reason: result.reason, detail: result.detail }
      lastError = result.detail
      // 同一条失败原因（比如容器里永远起不来）只记一次，长监督下不刷屏。
      if (lastError !== lastUnsupportedWarn) {
        lastUnsupportedWarn = lastError
        log.warn(`could not keep the system awake: ${result.detail ?? result.reason}`)
      }
      // 环境本来就不支持时重试没有意义，只会每 5 分钟白跑一次。
      if (result.reason !== 'unsupported') scheduleRetry()
      return
    }
    if (disposed || token !== generation || !desired()) {
      releaseHandle(result.handle)
      return
    }
    acquireHandle(result)
  }

  function stopHold(reason) {
    clearRetry()
    if (holding === undefined) return
    const current = holding
    holding = undefined
    generation += 1
    releaseHandle(current.handle)
    log.info(`released the wake lock (${current.backend}, ${reason})`)
  }

  function evaluate(trigger) {
    if (disposed) return
    syncAcWatch()
    if (desired()) {
      if (holding === undefined && !starting) void startHold(trigger)
      return
    }
    if (holding !== undefined) {
      stopHold(mode() === 'off' ? 'disabled by the setting' : onBattery === true ? 'running on battery' : 'supervision ended')
    }
  }

  function hold(owner) {
    if (typeof owner !== 'string' || owner === '') return
    owners.add(owner)
    evaluate('hold')
  }

  function release(owner) {
    owners.delete(owner)
    evaluate('release')
  }

  function releaseAll() {
    owners.clear()
    evaluate('release-all')
  }

  function state() {
    const current = mode()
    let reason
    // 与是否正在监督无关的原因优先：关掉开关、电池供电这类情况在空闲时也要如实说明。
    if (holding !== undefined) reason = 'holding'
    else if (current === 'off') reason = 'disabled'
    else if (current === 'ac-only' && onBattery === true) reason = 'battery'
    else if (starting) reason = 'starting'
    else if (owners.size > 0 && unsupported !== undefined) reason = unsupported.reason
    else reason = 'idle'
    return {
      mode: current,
      holding: holding !== undefined,
      backend: holding?.backend ?? 'none',
      since: holding === undefined ? 0 : since,
      helperPid: holding?.pid,
      owners: [...owners],
      onBattery,
      host: environment.host,
      platform,
      wsl: environment.wsl,
      container: environment.container,
      resumeAt: lastResumeAt,
      suspendedMs: lastSuspendedMs,
      reason,
      detail: holding !== undefined ? holding.detail : unsupported?.detail,
      error: lastError,
    }
  }

  function diagnose() {
    const candidates = environment.helperPlatform
      ? helperCandidates({ platform, env, parentPid: io.pid, exists: io.exists }).map((entry) => `${entry.backend}:${entry.file}`)
      : []
    return {
      ...state(),
      environment: { ...environment },
      electron: electron === null || electron === undefined ? 'none' : typeof electron.powerSaveBlocker?.start === 'function' ? 'powerSaveBlocker' : 'no-powerSaveBlocker',
      helpers: candidates,
      settingsPath: settings?.path,
    }
  }

  function onResume(listener) {
    if (typeof listener !== 'function') return () => {}
    resumeListeners.add(listener)
    return () => {
      resumeListeners.delete(listener)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    generation += 1
    stopHold('plugin disposed')
    clearRetry()
    if (clockTimer !== undefined) {
      io.clearInterval(clockTimer)
      clockTimer = undefined
    }
    stopAcWatch()
    for (const unsubscribe of disposers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        /* 宿主已经拆掉服务 */
      }
    }
    resumeListeners.clear()
    owners.clear()
    unsubscribeSettings?.()
    unsubscribeSettings = undefined
    process.removeListener?.('exit', killHelperOnExit)
  }

  /** 进程被强杀时尽力同步杀掉 helper：helper 自己也有父进程存活检查兜底。 */
  function killHelperOnExit() {
    if (holding?.handle?.kind !== 'helper') return
    try {
      holding.handle.entry.child.kill?.('SIGTERM')
    } catch {
      /* 已经退出 */
    }
  }

  let unsubscribeSettings

  function attach() {
    if (!disposed) return () => {}
    disposed = false
    if (typeof process.on === 'function') process.on('exit', killHelperOnExit)
    startMonitorWatch()
    startClockWatch()
    unsubscribeSettings = settings?.subscribe?.(() => {
      evaluate('settings')
    })
    void refreshBattery('attach')
    evaluate('attach')
    return dispose
  }

  return {
    attach,
    dispose,
    hold,
    release,
    releaseAll,
    state,
    diagnose,
    onResume,
    /** 供测试与诊断用：立即重新判断一次。 */
    refresh: () => evaluate('manual'),
  }
}
