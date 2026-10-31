/**
 * /dont-stop 参数解析：6h / 90m / 1.5h / 1h30m / 8min / 8分钟 / 8 hours / 2天 /
 * until 22:00 / until 22点 / off，以及本周期选项 --stop / --no-stop。
 * 纯函数，便于单测。
 */

import { formatDuration } from './util.js'

/** 单位别名：英文单复数与常见缩写、中文写法都收，长的排前面以便优先匹配。 */
const UNITS = [
  ['milliseconds', 1],
  ['millisecond', 1],
  ['msecs', 1],
  ['msec', 1],
  ['ms', 1],
  ['毫秒', 1],
  ['seconds', 1000],
  ['second', 1000],
  ['secs', 1000],
  ['sec', 1000],
  ['s', 1000],
  ['秒钟', 1000],
  ['秒', 1000],
  ['minutes', 60000],
  ['minute', 60000],
  ['mins', 60000],
  ['min', 60000],
  ['m', 60000],
  ['分钟', 60000],
  ['分鐘', 60000],
  ['分', 60000],
  ['hours', 3600000],
  ['hour', 3600000],
  ['hrs', 3600000],
  ['hr', 3600000],
  ['h', 3600000],
  ['小时', 3600000],
  ['小時', 3600000],
  ['时', 3600000],
  ['days', 86400000],
  ['day', 86400000],
  ['d', 86400000],
  ['天', 86400000],
  ['日', 86400000],
]
  .map(([alias, ms]) => ({ alias, ms }))
  .sort((a, b) => b.alias.length - a.alias.length)

const NUMBER_RE = /\d+(?:\.\d+)?/y
const CLOCK_COLON_RE = /^(\d{1,2}):(\d{2})$/
const CLOCK_CN_RE = /^(\d{1,2})(?:点|點|时|時)(?:(\d{1,2})?分?)?$/

export const USAGE =
  '/dont-stop 6h | until 22:00 [instruction] [--stop|--no-stop] | off'

/** 不带时长时的默认持续时长；插件默认配置与投影折叠共用。 */
export const DEFAULT_DURATION_MS = 21600000
/**
 * 默认不设时长上限：`2天`、`100h` 这类写法照常生效。
 * 需要限制时由插件配置里的 `duration.maxMs` 给一个有限值，解析器才会拒绝更长的时长。
 */
export const MAX_DURATION_MS = Number.POSITIVE_INFINITY

/** 全角数字、冒号、空格转半角；长度不变，便于把扫描位置映射回原文。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\uff1a/g, ':')
    .replace(/[\u3000\u00a0]/g, ' ')
}

/** 从 start 起匹配一个单位；允许“3 个（空格）任务”这类写法里的量词。 */
function matchUnit(text, start) {
  let at = start
  if (text[at] === '个' || text[at] === '個') at += 1
  const tail = text.slice(at).toLowerCase()
  for (const unit of UNITS) {
    if (!tail.startsWith(unit.alias)) continue
    const next = text[at + unit.alias.length]
    // 英文单位后面紧跟字母说明是别的词（8months 不该按 8m 算），中文单位无此问题。
    if (/[a-z]/i.test(unit.alias[0]) && next !== undefined && /[a-z]/i.test(next)) return null
    return { ms: unit.ms, length: at - start + unit.alias.length }
  }
  return null
}

/**
 * 吃掉开头的时长（一段或多段紧邻的写法），返回剩下的指令。
 *
 * 多段只认紧邻形式（`1h30m`、`1小时30分钟`）；`1h 30个测试` 里隔了空格的 30 属于指令，
 * 不当成时长，避免把指令开头的数字吞掉。
 * @returns {{ms:number, rest:string, glued:boolean}|null} glued 表示时长后面紧贴着无法解析的数字
 */
export function takeDuration(text) {
  const source = normalize(text)
  let index = 0
  let total = 0
  let segments = 0
  for (;;) {
    if (segments > 0 && (index >= source.length || /\s/.test(source[index]))) break
    NUMBER_RE.lastIndex = index
    const number = NUMBER_RE.exec(source)
    if (!number) break
    const value = Number(number[0])
    if (!Number.isFinite(value) || value <= 0) break
    const numberEnd = NUMBER_RE.lastIndex
    let cursor = numberEnd
    while (cursor < source.length && /\s/.test(source[cursor])) cursor++
    const unit = matchUnit(source, cursor)
    if (!unit) {
      if (segments > 0) return { ms: total, rest: source.slice(index).trim(), glued: true }
      return null
    }
    total += value * unit.ms
    segments += 1
    index = cursor + unit.length
  }
  if (segments === 0) return null
  return { ms: total, rest: source.slice(index).trim(), glued: false }
}

/** 解析 "6h"、"8 minutes"、"8分钟"、"1h30m"；整串必须只是时长，失败返回 null。 */
export function parseDuration(text) {
  const parsed = takeDuration(text)
  if (!parsed || parsed.glued || parsed.rest !== '') return null
  return parsed.ms
}

/** 解析本地时钟 "22:00"、"22：00"、"22点"、"22点30分"；已过去则顺延到明天。 */
export function parseClock(text, now) {
  const raw = normalize(text).trim()
  let match = CLOCK_COLON_RE.exec(raw)
  let hours
  let minutes = 0
  if (match) {
    hours = Number(match[1])
    minutes = Number(match[2])
  } else {
    match = CLOCK_CN_RE.exec(raw)
    if (!match) return null
    hours = Number(match[1])
    minutes = match[2] === undefined ? 0 : Number(match[2])
  }
  if (hours > 23 || minutes > 59) return null
  const date = new Date(now)
  date.setHours(hours, minutes, 0, 0)
  const at = date.getTime()
  return at <= now ? at + 86400000 : at
}

/** 本周期到点是否强行停止：在命令里临时覆盖设置页的全局开关。 */
export const STOP_FLAG = '--stop'
export const KEEP_FLAG = '--no-stop'

/**
 * 吃掉一段文本开头的 `--stop` / `--no-stop`（同一个写多次以最后一个为准）。
 * 用在两处：整个输入的最前面，以及时长 / `until` 时间之后。
 * @returns {{stopAtDeadline:(boolean|undefined), rest:string, unknown:(string|undefined)}} 剩余文本与认不出的选项。
 */
function takeStopFlags(text) {
  let stopAtDeadline
  let rest = text
  for (;;) {
    const match = /^(--\S+)(?:\s+|$)/.exec(rest)
    if (!match) break
    const token = match[1].toLowerCase()
    if (token === STOP_FLAG) stopAtDeadline = true
    else if (token === KEEP_FLAG) stopAtDeadline = false
    else return { stopAtDeadline, rest, unknown: match[1] }
    rest = rest.slice(match[0].length)
  }
  return { stopAtDeadline, rest, unknown: undefined }
}

/**
 * 解析一条命令输入。
 *
 * 只看第一个词：`off` 后面多写了字也只当误触，不再报“无法解析 off”。
 * `--stop` / `--no-stop` 只认开头这几个位置：整个输入的最前面，以及时长（或 `until`
 * 的时间）后面——`--no-stop until 22:00` 与 `until 22:00 --no-stop` 都算；写进指令中间
 * 就按普通文字处理。认不出的选项按错误返回，避免拼错时静默变成指令。
 * @returns {{kind:'off'}|{kind:'option',stopAtDeadline:boolean}|{kind:'error',message:string}|{kind:'start',deadlineAt:number,objective:string,stopAtDeadline?:boolean}}
 */
export function parseSpec(rawInput, options) {
  const now = options?.now ?? Date.now()
  const defaultMs = options?.defaultMs ?? 6 * 3600000
  const maxMs = options?.maxMs ?? Number.POSITIVE_INFINITY
  const leading = takeStopFlags(normalize(rawInput).trim())
  if (leading.unknown !== undefined) {
    return { kind: 'error', message: `Unknown option "${leading.unknown}". Usage: ${USAGE}` }
  }
  const raw = leading.rest.trim()
  if (raw === '') {
    // 只写选项、没写时长：监督中就地调整本周期行为，不碰截止时间。
    if (leading.stopAtDeadline !== undefined) return { kind: 'option', stopAtDeadline: leading.stopAtDeadline }
    return { kind: 'start', deadlineAt: now + defaultMs, objective: '' }
  }

  const [first, ...rest] = raw.split(/\s+/)
  const head = first.toLowerCase()

  if (head === 'off' || head === 'stop' || head === 'end') return { kind: 'off' }

  if (head === 'until' || head === 'at') {
    const clockText = rest[0]
    if (clockText === undefined) return { kind: 'error', message: `Missing time. Usage: ${USAGE}` }
    const at = parseClock(clockText, now)
    if (at === null) return { kind: 'error', message: `Cannot parse time "${clockText}". Usage: ${USAGE}` }
    if (at - now > maxMs) return { kind: 'error', message: `Deadline is beyond the ${formatDuration(maxMs)} limit.` }
    const tail = takeStopFlags(rest.slice(1).join(' ').trim())
    if (tail.unknown !== undefined) {
      return { kind: 'error', message: `Unknown option "${tail.unknown}". Usage: ${USAGE}` }
    }
    return {
      kind: 'start',
      deadlineAt: at,
      objective: tail.rest.trim(),
      stopAtDeadline: tail.stopAtDeadline ?? leading.stopAtDeadline,
    }
  }

  const duration = takeDuration(raw)
  if (!duration || duration.glued) {
    return { kind: 'error', message: `Cannot parse "${first}". Usage: ${USAGE}` }
  }
  if (duration.ms > maxMs) return { kind: 'error', message: `Duration exceeds the ${formatDuration(maxMs)} limit.` }
  const tail = takeStopFlags(duration.rest)
  if (tail.unknown !== undefined) {
    return { kind: 'error', message: `Unknown option "${tail.unknown}". Usage: ${USAGE}` }
  }
  return {
    kind: 'start',
    deadlineAt: now + duration.ms,
    objective: tail.rest.trim(),
    stopAtDeadline: tail.stopAtDeadline ?? leading.stopAtDeadline,
  }
}
