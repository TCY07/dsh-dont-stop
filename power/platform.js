/**
 * 跨平台“保持系统唤醒”的平台知识：环境判定、外部 helper 的命令构造、电源状态解析。
 *
 * 这里只放纯函数与常量，所有 IO 都由调用方注入，便于在任意机器上跑单元测试。
 * 设计底线：任何手段都不需要管理员权限、不修改系统电源设置，进程退出即释放。
 */

/** 保持唤醒的三种模式。 */
export const KEEP_AWAKE_MODES = ['off', 'ac-only', 'always']

/** 认不出来的值退回默认的 ac-only（笔记本插电时保持唤醒，电池时不动）。 */
export function normalizeKeepAwakeMode(value) {
  return KEEP_AWAKE_MODES.includes(value) ? value : 'ac-only'
}

/** 外部 helper 只在这几种宿主里才有意义；WSL 与容器里控制不到真正的电源。 */
const HELPER_PLATFORMS = new Set(['win32', 'darwin', 'linux'])

/**
 * 判定运行环境。
 * @param {{platform:string, env?:object, hasElectron?:boolean, exists?:(path:string)=>boolean, readFile?:(path:string)=>string}} input
 * @returns {{platform:string, host:'desktop'|'node', wsl:boolean, container:boolean, helperPlatform:boolean, unsupportedReason?:string}}
 */
export function detectEnvironment({ platform, env = {}, hasElectron = false, exists = () => false, readFile = () => '' }) {
  let wsl = false
  let container = false
  if (platform === 'linux') {
    if (typeof env.WSL_DISTRO_NAME === 'string' && env.WSL_DISTRO_NAME !== '') wsl = true
    if (!wsl) {
      try {
        wsl = String(readFile('/proc/version') ?? '').toLowerCase().includes('microsoft')
      } catch {
        wsl = false
      }
    }
    try {
      container = exists('/.dockerenv') || exists('/run/.containerenv') || /docker|kubepods|containerd|libpod/.test(String(readFile('/proc/1/cgroup') ?? ''))
    } catch {
      container = false
    }
  }
  const helperPlatform = HELPER_PLATFORMS.has(platform) && !wsl && !container
  return {
    platform,
    host: hasElectron ? 'desktop' : 'node',
    wsl,
    container,
    helperPlatform,
    ...(helperPlatform
      ? {}
      : {
          unsupportedReason: wsl
            ? 'this process runs inside WSL, which cannot control the host power state; set the Windows host itself to stay awake'
            : container
              ? 'this process runs in a container, which cannot control the host power state; set the host machine to stay awake'
              : `no supported keep-awake mechanism on ${platform}`,
        }),
  }
}

/** Windows PowerShell 的固定位置：优先 %WINDIR%，不写死盘符。 */
export function windowsPowerShellPath(env = {}) {
  const configured = typeof env.WINDIR === 'string' ? env.WINDIR.trim() : ''
  const windir = configured === '' ? 'C:\\Windows' : configured.replace(/[\\/]+$/, '')
  return `${windir}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

/** 在 PATH 里找一个可执行文件（Linux/macOS 用 PATH 分隔符，Windows 看 PATHEXT）。 */
export function findOnPath(name, { env = {}, exists = () => false, platform = process.platform } = {}) {
  const separator = env.PATH_SEPARATOR ?? (platform === 'win32' ? ';' : ':')
  const rawPath = typeof env.PATH === 'string' ? env.PATH : ''
  if (rawPath === '') return undefined
  const extensions = platform === 'win32' && !name.includes('.')
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((entry) => entry !== '')
    : ['']
  for (const directory of rawPath.split(separator)) {
    const base = directory.trim()
    if (base === '') continue
    for (const extension of extensions) {
      const candidate = `${base}${platform === 'win32' ? '\\' : '/'}${name}${extension}`
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

/** PowerShell 脚本里声明 Win32 调用的类型名，换名字的时候一起改。 */
const WINDOWS_TYPE = 'DshDontStopPower'

/**
 * Windows helper 脚本：调用 SetThreadExecutionState 阻止空闲睡眠，屏幕照常可以熄灭。
 * 用父进程 pid 做存活检查、并用硬超时兜底，父进程被强杀时最多再撑一个检查周期。
 * 常量写成十进制 uint32：PowerShell 不支持 C 的 `0x…u` 后缀，十六进制字面量会变成负数。
 */
export function windowsHelperScript({ parentPid, ttlSeconds = 86400 }) {
  return [
    "$ErrorActionPreference = 'Stop'",
    // 不让 PowerShell 把启动进度写成 CLIXML 塞进 stderr，失败详情才读得懂。
    '$ProgressPreference = \'SilentlyContinue\'',
    'try {',
    'Add-Type -TypeDefinition @"',
    'using System.Runtime.InteropServices;',
    `public static class ${WINDOWS_TYPE} {`,
    '    [DllImport("kernel32.dll", SetLastError = true)]',
    '    public static extern uint SetThreadExecutionState(uint flags);',
    '}',
    '"@',
    `$set = [${WINDOWS_TYPE}]::SetThreadExecutionState([uint32]2147483649)`,
    // 返回 0 表示这次请求没被系统接受：照着“正在阻止睡眠”报出去就是假状态。
    'if ($set -eq 0) { throw "SetThreadExecutionState returned 0" }',
    `$deadline = [DateTime]::UtcNow.AddSeconds(${Math.max(1, Math.round(ttlSeconds))})`,
    'try {',
    '    while ([DateTime]::UtcNow -lt $deadline) {',
    '        Start-Sleep -Seconds 5',
    `        if (-not (Get-Process -Id ${Math.max(1, Math.round(parentPid))} -ErrorAction SilentlyContinue)) { break }`,
    '    }',
    '} finally {',
    `    [void][${WINDOWS_TYPE}]::SetThreadExecutionState([uint32]2147483648)`,
    '}',
    '} catch {',
    '    [Console]::Error.WriteLine("dont-stop keep-awake helper failed: " + $_.Exception.Message)',
    '    exit 2',
    '}',
  ].join('\n')
}

/** PowerShell 的 -EncodedCommand 要 base64 的 UTF-16LE。 */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

/** Windows：本体是 PowerShell（系统自带），用 -EncodedCommand 避免多行与引号转义问题。 */
export function buildWindowsHelper({ env = {}, parentPid, ttlSeconds, file } = {}) {
  const script = windowsHelperScript({ parentPid, ttlSeconds })
  return {
    backend: 'powershell',
    file: file ?? windowsPowerShellPath(env),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)],
  }
}

/** macOS：caffeinate -i 只防空闲系统睡眠、不点亮屏幕；-w 监视宿主 pid，宿主没了自动退出。 */
export function buildMacHelper({ parentPid, file = '/usr/bin/caffeinate' } = {}) {
  const pid = Math.max(1, Math.round(parentPid))
  return { backend: 'caffeinate', file, args: ['-i', '-w', String(pid)] }
}

/**
 * Linux：systemd-inhibit 持锁。锁随进程退出释放；锁住的命令用 shell 轮询父进程，
 * 这样宿主崩溃后不会把机器的睡眠永远关掉；再加一个硬截止时间，pid 被复用时也不会永久持锁。
 */
export function buildLinuxHelper({ parentPid, file = 'systemd-inhibit', ttlSeconds = 86400 } = {}) {
  const pid = Math.max(1, Math.round(parentPid))
  const deadline = Math.floor(Date.now() / 1000) + Math.max(1, Math.round(ttlSeconds))
  const watch = `while kill -0 ${pid} 2>/dev/null && [ "$(date +%s)" -lt ${deadline} ]; do sleep 5; done`
  return {
    backend: 'systemd-inhibit',
    file,
    args: ['--what=sleep:idle', '--mode=block', '--who=dsh-dont-stop', '--why=keep the agent working', 'sh', '-c', watch],
  }
}

/**
 * 按平台给出可用的外部 helper，顺序即优先级。
 * 只看"命令是否存在"，真正的启动成败由调用方探测。
 */
export function helperCandidates({ platform, env = {}, parentPid = process.pid, exists = () => false } = {}) {
  if (platform === 'win32') {
    const known = windowsPowerShellPath(env)
    const file = exists(known) ? known : findOnPath('powershell.exe', { env, exists, platform })
    if (file === undefined) return []
    return [buildWindowsHelper({ env, parentPid, file })]
  }
  if (platform === 'darwin') {
    const file = '/usr/bin/caffeinate'
    if (!exists(file)) return []
    return [buildMacHelper({ parentPid, file })]
  }
  if (platform === 'linux') {
    const file = findOnPath('systemd-inhibit', { env, exists, platform })
    if (file === undefined) return []
    return [buildLinuxHelper({ parentPid, file })]
  }
  return []
}

/** 解析 `pmset -g batt`：现在是从电池还是交流电取电。 */
export function parseMacBatteryState(output) {
  const text = String(output ?? '')
  if (text.includes("'AC Power'")) return false
  if (text.includes("'Battery Power'")) return true
  return null
}

/**
 * 读 Linux 的 /sys/class/power_supply：有 Mains 就看它的 online；没有电源信息时当作台式机。
 * @returns {boolean|null} true 表示正在用电池，null 表示判断不了。
 */
export function readLinuxBatteryState({ readdir, readFile }) {
  let entries
  try {
    entries = readdir('/sys/class/power_supply')
  } catch {
    return null
  }
  const names = Array.isArray(entries) ? entries : []
  if (names.length === 0) return false
  let sawBattery = false
  for (const name of names) {
    const type = String(readFile(`/sys/class/power_supply/${name}/type`) ?? '').trim()
    if (type === 'Mains' || type === 'AC') {
      const online = String(readFile(`/sys/class/power_supply/${name}/online`) ?? '').trim()
      if (online === '0') return true
      if (online === '1') return false
    }
    if (type === 'Battery') sawBattery = true
  }
  // 没有 Mains 节点：笔记本电池在放电时按电池算，其余情况交给未知。
  if (sawBattery) {
    for (const name of names) {
      const type = String(readFile(`/sys/class/power_supply/${name}/type`) ?? '').trim()
      if (type !== 'Battery') continue
      const status = String(readFile(`/sys/class/power_supply/${name}/status`) ?? '').trim()
      if (status === 'Discharging') return true
      if (status === 'Charging' || status === 'Full') return false
    }
  }
  return null
}

/** Windows 的 Win32_Battery.BatteryStatus：2 表示插着交流电，1 表示在放电。 */
export function parseWindowsBatteryStatus(output) {
  const text = String(output ?? '').trim()
  if (text === '') return false
  const values = text.split(/\s+/).map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
  if (values.length === 0) return null
  if (values.includes(1)) return true
  if (values.includes(2)) return false
  return null
}

/** Windows 上查询电池状态的 PowerShell 命令（只读，不需要管理员）。 */
export function windowsBatteryQuery(env = {}) {
  return {
    file: windowsPowerShellPath(env),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue).BatteryStatus',
    ],
  }
}
