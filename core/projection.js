/**
 * dontStop 会话投影：把 Dont-Stop 的监督状态从会话日志折叠出来。
 *
 * 监督本身是进程内状态，日志里留下的痕迹分两种：
 *  - 开始 / 结束公告：以注入消息的形式写进日志（agent/inbox/spliced），机器数据挂在
 *    消息的 `source.dontStop` 上（模型看不到 source），正文只有人读文字；
 *  - 延长时间：不发公告（模型那边不该知道时间变了），折叠的是命令日志里的
 *    `command/run`（`/dont-stop <新时长>`），读它的 args 重新算截止时间。
 *
 * 纯折叠：重开会话、回放日志、冷读缓存得到的结果一致，进程重启后也不会平白显示
 * 一条其实已经不存在的监督。
 *
 * 机器数据形状：
 *   { phase: 'start', startedAt: <毫秒>, deadlineAt: <毫秒>, stopAtDeadline: <布尔，可选> }
 *   { phase: 'end', reason: 'deadline|manual|stale|released' }
 *   { phase: 'extend', deadlineAt: <毫秒> }    // 仅旧日志里的延时公告
 * 早期版本把时间和 kind 写在正文开标签里（`started="<毫秒>"`、`deadline="<毫秒>"`），
 * 读旧日志时那条路径仍然保留。`stopAtDeadline` 只影响状态条显示，缺省时界面不显示。
 */

import { DEFAULT_DURATION_MS, MAX_DURATION_MS, parseSpec } from '../shared/duration.js'

/** 投影键：客户端用同一个名字读取。 */
export const PROJECTION_KEY = 'dontStop'

/** 公告开标签；闭合标签以 `</` 开头，不会命中这里。 */
const SUPERVISION_TAG = /<dont_stop_supervision([^>]*)>/u
const ROUND_TAG = /<dont_stop_round([^>]*)>/u
const ATTRIBUTE = /([a-z]+)="([^"]*)"/gu

/** 未处于监督时的状态；每次重置都返回新对象，视图引用才会变化。 */
function idle() {
  return { phase: 'idle', startedAt: 0, deadlineAt: 0, rounds: 0 }
}

/** 投影状态与客户端视图都按原样通过：本单元的值本身就是纯 JSON。 */
const passthrough = { parse: (value) => value }

/**
 * 从消息的 source 里读机器数据。模型只收到 content，source 不进上下文，
 * 所以截止时间放在这里既能让状态条读到，又不会泄漏给模型。
 */
function machineOf(message) {
  if (message?.source?.kind !== 'dont-stop') return undefined
  const machine = message.source.dontStop
  return typeof machine === 'object' && machine !== null && !Array.isArray(machine) ? machine : undefined
}

/** 折叠一条机器数据公告；读不懂的字段当作没有，保持原状态。 */
function foldMachine(state, machine) {
  const phase = machine.phase
  if (phase === 'end') return state.phase === 'idle' ? state : idle()
  if (phase !== 'start' && phase !== 'extend') return state
  const deadlineAt = Number(machine.deadlineAt)
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) return state
  // 到点是否强停只影响状态条显示；旧日志没有这个字段时保持未知。
  const stop = typeof machine.stopAtDeadline === 'boolean' ? { stopAtDeadline: machine.stopAtDeadline } : {}
  if (phase === 'extend') return { ...state, phase: 'supervising', deadlineAt, ...stop }
  const startedAt = Number(machine.startedAt)
  return {
    phase: 'supervising',
    startedAt: Number.isSafeInteger(startedAt) && startedAt > 0 ? startedAt : deadlineAt,
    deadlineAt,
    rounds: 0,
    ...stop,
  }
}

/**
 * 从一段旧格式公告文字里读出状态变化（正文开标签带 kind / 毫秒时间戳）。
 * @param {object} state - 之前的折叠结果。
 * @param {string} text - 公告正文。
 * @returns {object} 新状态，或原状态（这条公告不需要改变状态）。
 */
function foldNotice(state, text) {
  const supervision = SUPERVISION_TAG.exec(text)
  if (supervision !== null) {
    const attrs = attributes(supervision[1])
    if (attrs.kind === 'end') return state.phase === 'idle' ? state : idle()
    if (attrs.kind !== 'start' && attrs.kind !== 'extend') return state
    const deadlineAt = stamp(attrs.deadline)
    if (deadlineAt === undefined) return state
    if (attrs.kind === 'extend') return { ...state, phase: 'supervising', deadlineAt }
    return { phase: 'supervising', startedAt: stamp(attrs.started) ?? deadlineAt, deadlineAt, rounds: 0 }
  }

  const round = ROUND_TAG.exec(text)
  if (round === null) return state
  const attrs = attributes(round[1])
  const rounds = stamp(attrs.round)
  if (rounds === undefined) return state
  const deadlineAt = stamp(attrs.deadline)
  if (state.phase !== 'supervising') return { ...state, rounds }
  return { ...state, rounds, ...(deadlineAt === undefined ? {} : { deadlineAt }) }
}

/** 解析属性表；只看简单的 `key="value"`。 */
function attributes(source) {
  const table = {}
  for (const match of source.matchAll(ATTRIBUTE)) table[match[1]] = match[2]
  return table
}

/** 把旧格式属性值读成正整数毫秒/轮次：毫秒时间戳或早期写过的 ISO 时间都认；读不出就当作没有。 */
function stamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const asNumber = Number(value)
  const parsed = Number.isFinite(asNumber) ? asNumber : Date.parse(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** 取一条注入消息的正文；不是监督公告的消息一律跳过。 */
function noticeText(message) {
  if (message?.source?.kind !== 'dont-stop') return undefined
  const content = message.content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
  }
  return undefined
}

/** 折叠一批入队消息：优先用 source 上的机器数据，旧日志再退回解析正文。 */
function foldSplice(state, event) {
  const inserted = event.data?.inserted
  if (!Array.isArray(inserted)) return state
  let next = state
  for (const message of inserted) {
    const machine = machineOf(message)
    if (machine !== undefined) {
      next = foldMachine(next, machine)
      continue
    }
    const text = noticeText(message)
    if (text === undefined) continue
    next = foldNotice(next, text)
  }
  return next
}

/**
 * 折叠一条 `/dont-stop` 命令日志：监督中再执行一次就是重新设定截止时间（可延长也可缩短），
 * 只写 `--stop` / `--no-stop` 时只改本周期到点是否强停、不动截止时间。
 *
 * 截止时间与命令处理一致：直接取「命令时刻 + 这次给的时长」（或 until 的绝对时刻）。
 * off 以及解析失败的输入都不改变状态。
 */
function foldCommand(state, event, limits) {
  if (state.phase !== 'supervising') return state
  if (event.data?.name !== 'dont-stop') return state
  const args = typeof event.data.args === 'string' ? event.data.args : ''
  const now = typeof event.time === 'number' ? event.time : Date.now()
  const spec = parseSpec(args, { now, defaultMs: limits.defaultMs, maxMs: limits.maxMs })
  if (spec.kind === 'option') {
    return spec.stopAtDeadline === state.stopAtDeadline ? state : { ...state, stopAtDeadline: spec.stopAtDeadline }
  }
  if (spec.kind !== 'start') return state
  const next = { ...state, deadlineAt: spec.deadlineAt }
  if (spec.stopAtDeadline !== undefined) next.stopAtDeadline = spec.stopAtDeadline
  return next.deadlineAt === state.deadlineAt && next.stopAtDeadline === state.stopAtDeadline ? state : next
}

/**
 * 投影定义工厂：延长时间要按命令重新算截止时间，时长上限与插件配置里的 duration 一致，
 * 所以由注册方传进来。
 * @param {{defaultMs?: number, maxMs?: number}} [limits] - 与插件配置 duration 一致的上限。
 */
export function createProjection(limits = {}) {
  const resolved = {
    defaultMs: Number.isFinite(limits.defaultMs) ? limits.defaultMs : DEFAULT_DURATION_MS,
    maxMs: Number.isFinite(limits.maxMs) ? limits.maxMs : MAX_DURATION_MS,
  }
  return {
    key: PROJECTION_KEY,
    stateVersion: 3,
    stateSchema: passthrough,
    init: () => idle(),
    apply(state, event) {
      try {
        if (event?.type === 'agent/inbox/spliced') return foldSplice(state, event)
        if (event?.type === 'command/run') return foldCommand(state, event, resolved)
        return state
      } catch {
        // 一条读不懂的日志不该打断投影驱动：保持现状，等后面的公告纠正。
        return state
      }
    },
    wire: {
      viewSchema: passthrough,
      view: (state) => (state.phase === 'supervising' ? state : null),
    },
  }
}

/** 缺省定义：插件行用 createProjection(cfg.duration) 注册，测试与本模块直接用这个。 */
export const dontStopProjection = createProjection()
