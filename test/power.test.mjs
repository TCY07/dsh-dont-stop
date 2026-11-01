/**
 * 保持唤醒的离线测试：环境判定、各平台 helper 命令、电池解析、引用计数与降级。
 *
 * 全部 IO 都是注入的假实现，所以这些用例在 Windows / macOS / Linux 上行为一致。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createKeepAwake } from '../power/index.js'
import {
  buildLinuxHelper,
  buildMacHelper,
  buildWindowsHelper,
  detectEnvironment,
  encodePowerShellCommand,
  findOnPath,
  helperCandidates,
  normalizeKeepAwakeMode,
  parseMacBatteryState,
  parseWindowsBatteryStatus,
  readLinuxBatteryState,
  windowsBatteryQuery,
  windowsHelperScript,
  windowsPowerShellPath,
} from '../power/platform.js'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** 记录所有计时器，`ms <= 10` 的立即执行（helper 的启动探测用），其余留给测试手动触发。 */
function makeTimers() {
  const timeouts = []
  const intervals = []
  let nextId = 0
  return {
    timeouts,
    intervals,
    setTimeout(callback, ms) {
      nextId += 1
      const entry = { id: nextId, callback, ms, cleared: false, unref() {} }
      if (ms <= 10) callback()
      else timeouts.push(entry)
      return entry
    },
    clearTimeout(entry) {
      if (entry !== undefined) entry.cleared = true
    },
    setInterval(callback, ms) {
      nextId += 1
      const entry = { id: nextId, callback, ms, unref() {} }
      intervals.push(entry)
      return entry
    },
    clearInterval(entry) {
      if (entry !== undefined) entry.cleared = true
    },
    /** 触发所有还没被撤销的定时器。 */
    runTimeouts() {
      for (const entry of timeouts.splice(0)) {
        if (!entry.cleared) entry.callback()
      }
    },
  }
}

function makeChild() {
  const handlers = new Map()
  const child = {
    pid: 9001,
    killed: [],
    stderrText: '',
    stderr: {
      on(name, callback) {
        if (name === 'data') child.stderrCallback = callback
      },
    },
    once(name, callback) {
      handlers.set(name, [...(handlers.get(name) ?? []), callback])
    },
    on(name, callback) {
      child.once(name, callback)
    },
    emit(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args)
      handlers.delete(name)
    },
    kill(signal) {
      child.killed.push(signal)
    },
  }
  return child
}

function makeSpawn(children = []) {
  const calls = []
  const spawn = (file, args) => {
    const child = children.shift() ?? makeChild()
    child.file = file
    child.args = args
    calls.push({ file, args, child })
    return child
  }
  spawn.calls = calls
  return spawn
}

function makeElectron({ onBattery = false } = {}) {
  const started = new Set()
  const calls = []
  let id = 0
  const monitorListeners = new Map()
  return {
    calls,
    monitorListeners,
    powerSaveBlocker: {
      start(reason) {
        calls.push(['start', reason])
        id += 1
        started.add(id)
        return id
      },
      stop(blockerId) {
        calls.push(['stop', blockerId])
        started.delete(blockerId)
      },
      isStarted(blockerId) {
        return started.has(blockerId)
      },
      startedIds: () => [...started],
    },
    powerMonitor: {
      isOnBatteryPower: () => onBattery,
      on(name, callback) {
        monitorListeners.set(name, callback)
        return () => monitorListeners.delete(name)
      },
    },
  }
}

function makeSettings(initial = {}) {
  let value = { keepAwake: 'ac-only', ...initial }
  const listeners = new Set()
  return {
    get: () => value,
    update(patch) {
      value = { ...value, ...patch }
      for (const listener of [...listeners]) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** 组装一个全注入的 keep-awake。 */
function makeKeepAwake({ platform = 'win32', electron = null, settings = makeSettings(), children = [], env = {}, exists = undefined, readFile = () => '', readdir = () => [], execFile = undefined, now = Date.now, pid = 4242 } = {}) {
  const timers = makeTimers()
  const spawn = makeSpawn(children)
  const exec = execFile ?? ((_file, _args, _options, callback) => callback(null, '2', ''))
  // 默认的“文件是否存在”只认两个平台 helper，别让 /.dockerenv 之类的探针把测试判成容器。
  const existsFn = exists ?? ((path) => path.startsWith('/usr/bin') || path.toLowerCase().endsWith('powershell.exe'))
  const keepAwake = createKeepAwake({
    settings,
    platform,
    env: { WINDIR: 'C:\\Windows', PATH: '/usr/bin:/bin', ...env },
    io: {
      exists: existsFn,
      readFile,
      readdir,
      spawn,
      execFile: exec,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      electron: () => electron,
      pid,
      settleMs: 0,
      now,
    },
    log: { info: () => {}, warn: () => {} },
  })
  return { keepAwake, timers, spawn, settings }
}

test('normalizeKeepAwakeMode accepts the three modes and falls back to ac-only', () => {
  for (const mode of ['off', 'ac-only', 'always']) assert.equal(normalizeKeepAwakeMode(mode), mode)
  assert.equal(normalizeKeepAwakeMode(undefined), 'ac-only')
  assert.equal(normalizeKeepAwakeMode('sometimes'), 'ac-only')
  assert.equal(normalizeKeepAwakeMode(1), 'ac-only')
})

test('detectEnvironment tells desktop/web apart and refuses WSL and containers', () => {
  const desktop = detectEnvironment({ platform: 'win32', hasElectron: true })
  assert.equal(desktop.host, 'desktop')
  assert.equal(desktop.helperPlatform, true)

  const node = detectEnvironment({ platform: 'linux', hasElectron: false })
  assert.equal(node.host, 'node')
  assert.equal(node.helperPlatform, true)

  const wsl = detectEnvironment({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } })
  assert.equal(wsl.wsl, true)
  assert.equal(wsl.helperPlatform, false)
  assert.match(wsl.unsupportedReason, /WSL/)

  const container = detectEnvironment({ platform: 'linux', exists: (path) => path === '/.dockerenv' })
  assert.equal(container.container, true)
  assert.equal(container.helperPlatform, false)
  assert.match(container.unsupportedReason, /container/)

  const other = detectEnvironment({ platform: 'aix' })
  assert.equal(other.helperPlatform, false)
  assert.match(other.unsupportedReason, /aix/)
})

test('the Windows helper follows %WINDIR% and carries the parent pid in an encoded command', () => {
  const file = windowsPowerShellPath({ WINDIR: 'D:\\Windows' })
  assert.equal(file, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(windowsPowerShellPath({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')

  const helper = buildWindowsHelper({ env: { WINDIR: 'C:\\Windows' }, parentPid: 4242, ttlSeconds: 60 })
  assert.equal(helper.backend, 'powershell')
  assert.match(helper.args.join(' '), /-EncodedCommand/)
  const encoded = helper.args[helper.args.length - 1]
  const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.match(decoded, /SetThreadExecutionState/)
  assert.match(decoded, /Get-Process -Id 4242/)
  assert.match(decoded, /AddSeconds\(60\)/)
  assert.equal(encodePowerShellCommand('x'), Buffer.from('x', 'utf16le').toString('base64'))
})

test('the Windows script sets and clears the continuous execution state', () => {
  const script = windowsHelperScript({ parentPid: 7, ttlSeconds: 30 })
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\)/, 'sets ES_CONTINUOUS | ES_SYSTEM_REQUIRED')
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483648\)/, 'clears the request on the way out')
  assert.match(script, /Get-Process -Id 7/)
  assert.match(script, /\[Console\]::Error\.WriteLine/, 'failures come back as plain text, not CLIXML')
})

test('the macOS helper uses caffeinate -i and watches the host pid', () => {
  const helper = buildMacHelper({ parentPid: 4242 })
  assert.equal(helper.backend, 'caffeinate')
  assert.equal(helper.file, '/usr/bin/caffeinate')
  assert.deepEqual(helper.args, ['-i', '-w', '4242'])
})

test('the Linux helper blocks sleep and idle through systemd-inhibit', () => {
  const helper = buildLinuxHelper({ parentPid: 4242 })
  assert.equal(helper.backend, 'systemd-inhibit')
  assert.ok(helper.args.includes('--what=sleep:idle'))
  assert.ok(helper.args.includes('--mode=block'))
  assert.match(helper.args[helper.args.length - 1], /kill -0 4242/)
})

test('helperCandidates only offers what exists on this machine', () => {
  assert.equal(helperCandidates({ platform: 'darwin', exists: (path) => path === '/usr/bin/caffeinate' }).length, 1)
  assert.equal(helperCandidates({ platform: 'darwin', exists: () => false }).length, 0)

  const windows = helperCandidates({ platform: 'win32', env: { WINDIR: 'C:\\Windows' }, exists: (path) => path.endsWith('powershell.exe') })
  assert.equal(windows.length, 1)
  assert.equal(windows[0].backend, 'powershell')

  const linux = helperCandidates({
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    exists: (path) => path === '/usr/bin/systemd-inhibit',
  })
  assert.equal(linux.length, 1)
  assert.equal(linux[0].file, '/usr/bin/systemd-inhibit')

  assert.equal(helperCandidates({ platform: 'linux', env: { PATH: '/bin' }, exists: () => false }).length, 0)
})

test('findOnPath walks PATH entries and Windows extensions', () => {
  assert.equal(findOnPath('systemd-inhibit', { env: { PATH: '/bin:/usr/bin' }, exists: (path) => path === '/usr/bin/systemd-inhibit', platform: 'linux' }), '/usr/bin/systemd-inhibit')
  const windows = findOnPath('powershell.exe', {
    env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE;.CMD' },
    exists: (path) => path.toLowerCase().endsWith('powershell.exe'),
    platform: 'win32',
  })
  assert.equal(windows, 'C:\\Windows\\System32\\powershell.exe')
  assert.equal(findOnPath('missing', { env: { PATH: '/bin' }, platform: 'linux' }), undefined)
})

test('battery state parsing handles AC, battery, desktops and garbage', () => {
  assert.equal(parseMacBatteryState("Now drawing from 'AC Power'\n"), false)
  assert.equal(parseMacBatteryState("Now drawing from 'Battery Power'\n"), true)
  assert.equal(parseMacBatteryState('something else'), null)

  assert.equal(parseWindowsBatteryStatus('2'), false)
  assert.equal(parseWindowsBatteryStatus('1'), true)
  assert.equal(parseWindowsBatteryStatus(''), false, 'no battery means a desktop, i.e. always on AC')
  assert.equal(parseWindowsBatteryStatus('not a number'), null)
  assert.equal(windowsBatteryQuery({}).args.join(' '), '-NoProfile -NonInteractive -Command (Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue).BatteryStatus')

  const files = {
    '/sys/class/power_supply/AC/type': 'Mains',
    '/sys/class/power_supply/AC/online': '1',
    '/sys/class/power_supply/BAT0/type': 'Battery',
    '/sys/class/power_supply/BAT0/status': 'Discharging',
  }
  const readFile = (path) => files[path] ?? ''
  assert.equal(readLinuxBatteryState({ readdir: () => ['AC', 'BAT0'], readFile }), false)
  assert.equal(readLinuxBatteryState({ readdir: () => [], readFile }), false)
  assert.equal(readLinuxBatteryState({ readdir: () => ['AC'], readFile: (path) => (files[path] === '1' ? '0' : files[path] ?? '') }), true)
  const batteryOnly = {
    '/sys/class/power_supply/BAT0/type': 'Battery',
    '/sys/class/power_supply/BAT0/status': 'Discharging',
  }
  assert.equal(readLinuxBatteryState({ readdir: () => ['BAT0'], readFile: (path) => batteryOnly[path] ?? '' }), true)
  assert.equal(readLinuxBatteryState({ readdir: () => ['BAT0'], readFile: () => '' }), null)
})

test('the Electron blocker is held once for many sessions and released with the last one', async () => {
  const electron = makeElectron()
  const { keepAwake } = makeKeepAwake({ platform: 'win32', electron })
  keepAwake.attach()

  keepAwake.hold('session-a')
  await tick()
  keepAwake.hold('session-b')
  await tick()
  assert.equal(electron.calls.filter(([kind]) => kind === 'start').length, 1, 'one request for both sessions')
  assert.equal(keepAwake.state().holding, true)
  assert.equal(keepAwake.state().backend, 'electron')

  keepAwake.release('session-a')
  await tick()
  assert.equal(keepAwake.state().holding, true, 'still held while another session is supervising')

  keepAwake.release('session-b')
  await tick()
  assert.equal(keepAwake.state().holding, false)
  assert.equal(electron.powerSaveBlocker.startedIds().length, 0)
  keepAwake.dispose()
})

test('the setting "off" suppresses the hold and "always" ignores the battery', async () => {
  const settings = makeSettings({ keepAwake: 'off' })
  const electron = makeElectron({ onBattery: false })
  const { keepAwake } = makeKeepAwake({ platform: 'win32', electron, settings })
  keepAwake.attach()
  await tick()
  // 没有在监督时也要如实说“已关闭”，否则状态栏会一直显示“监督开始后生效”。
  assert.equal(keepAwake.state().reason, 'disabled', 'the disabled setting shows before supervision starts')
  keepAwake.hold('session-a')
  await tick()
  assert.equal(keepAwake.state().holding, false)
  assert.equal(keepAwake.state().reason, 'disabled')

  settings.update({ keepAwake: 'always' })
  await tick()
  assert.equal(keepAwake.state().holding, true, 'switching the setting on takes effect immediately')

  settings.update({ keepAwake: 'ac-only' })
  const battery = makeElectron({ onBattery: true })
  const second = makeKeepAwake({ platform: 'win32', electron: battery, settings: makeSettings({ keepAwake: 'ac-only' }) })
  second.keepAwake.attach()
  await tick()
  assert.equal(second.keepAwake.state().reason, 'battery', 'battery is reported before supervision starts too')
  second.keepAwake.hold('session-b')
  await tick()
  assert.equal(second.keepAwake.state().holding, false, 'ac-only pauses on battery')
  assert.equal(second.keepAwake.state().reason, 'battery')
  second.keepAwake.dispose()
  keepAwake.dispose()
})

test('without Electron the platform helper is spawned, then killed on release', async () => {
  const child = makeChild()
  const { keepAwake, spawn } = makeKeepAwake({ platform: 'darwin', electron: null, children: [child], execFile: (_file, _args, _options, callback) => callback(null, "Now drawing from 'AC Power'") })
  keepAwake.attach()
  keepAwake.hold('session-a')
  await tick()

  assert.equal(spawn.calls.length, 1)
  assert.equal(spawn.calls[0].file, '/usr/bin/caffeinate')
  assert.deepEqual(spawn.calls[0].args, ['-i', '-w', '4242'])
  assert.equal(keepAwake.state().backend, 'caffeinate')
  assert.equal(keepAwake.state().holding, true)

  keepAwake.release('session-a')
  await tick()
  assert.deepEqual(child.killed, ['SIGTERM'])
  assert.equal(keepAwake.state().holding, false)
  keepAwake.dispose()
})

test('a helper that exits right away is reported instead of pretending to hold', async () => {
  const child = makeChild()
  const settings = makeSettings({ keepAwake: 'always' })
  const timers = makeTimers()
  const spawn = makeSpawn([child])
  // 让 settleMs 足够大，才能看到“启动后很快退出”这条路径。
  const keepAwake = createKeepAwake({
    settings,
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    io: {
      exists: (path) => path.startsWith('/usr/bin'),
      readFile: () => '',
      readdir: () => [],
      spawn,
      execFile: (_file, _args, _options, callback) => callback(null, ''),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      electron: () => null,
      pid: 4242,
      settleMs: 200,
    },
    log: { info: () => {}, warn: () => {} },
  })
  keepAwake.attach()
  keepAwake.hold('session-a')
  await tick()
  // 子进程在探测窗口内退出：载荷里带 stderr，状态里要能看见失败原因。
  child.stderrCallback?.('systemd-inhibit: command not found\n')
  child.emit('exit', 1)
  await tick()

  assert.equal(keepAwake.state().holding, false)
  assert.ok(['failed', 'unsupported'].includes(keepAwake.state().reason))
  assert.match(String(keepAwake.state().detail ?? keepAwake.state().error), /systemd-inhibit/)
  keepAwake.dispose()
})

test('a platform without any mechanism degrades with a readable reason', async () => {
  const { keepAwake } = makeKeepAwake({ platform: 'aix', electron: null, exists: () => false })
  keepAwake.attach()
  keepAwake.hold('session-a')
  await tick()
  const state = keepAwake.state()
  assert.equal(state.holding, false)
  assert.equal(state.reason, 'unsupported')
  assert.match(state.detail, /aix/)
  keepAwake.dispose()
})

test('a wall-clock jump counts as a resume, and only once', async () => {
  let stamp = 1_000_000
  const timers = makeTimers()
  const settings = makeSettings({ keepAwake: 'always' })
  const keepAwake = createKeepAwake({
    settings,
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    io: {
      exists: (path) => path.startsWith('/usr/bin'),
      readFile: () => '',
      readdir: () => [],
      spawn: () => makeChild(),
      execFile: (_file, _args, _options, callback) => callback(null, ''),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      electron: () => null,
      pid: 4242,
      settleMs: 0,
      now: () => stamp,
    },
    log: { info: () => {}, warn: () => {} },
  })
  const resumes = []
  keepAwake.attach()
  keepAwake.onResume((event) => resumes.push(event))
  const clock = timers.intervals.find((entry) => entry.ms === 15000)
  assert.ok(clock, 'a clock watch interval is installed')

  stamp += 15000
  clock.callback()
  assert.equal(resumes.length, 0, 'a normal tick is not a resume')

  stamp += 600000
  clock.callback()
  assert.equal(resumes.length, 1, 'a five minute gap is a resume')
  assert.ok(resumes[0].suspendedMs >= 585000)

  clock.callback()
  assert.equal(resumes.length, 1, 'the same resume is not reported twice')
  keepAwake.dispose()
})

test('diagnose reports the environment, the chosen backend and the reason', async () => {
  const electron = makeElectron()
  const { keepAwake } = makeKeepAwake({ platform: 'win32', electron })
  keepAwake.attach()
  await tick()
  const idle = keepAwake.diagnose()
  assert.equal(idle.reason, 'idle')
  assert.equal(idle.host, 'desktop')
  assert.equal(idle.platform, 'win32')
  assert.equal(idle.electron, 'powerSaveBlocker')
  assert.equal(idle.environment.helperPlatform, true)

  keepAwake.hold('session-a')
  await tick()
  const held = keepAwake.diagnose()
  assert.equal(held.holding, true)
  assert.equal(held.backend, 'electron')
  keepAwake.dispose()
})
