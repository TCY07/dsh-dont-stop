/**
 * 进程内监督状态登记表，供 core（写）与 retry（读）在同一 bundle 内共享。
 * 有意不做成 Cordis Service：两个插件行同属一个包，共享模块比跨插件服务契约简单，
 * core 被禁用时这里自然为空，retry 退化为“无 deadline 截断”。
 */

const states = new Map()

export function setSupervision(sessionId, state) {
  states.set(sessionId, state)
  return state
}

export function getSupervision(sessionId) {
  return states.get(sessionId)
}

export function dropSupervision(sessionId) {
  states.delete(sessionId)
}

export function deadlineOf(sessionId) {
  return states.get(sessionId)?.deadlineAt
}

export function isFinishing(sessionId) {
  return states.get(sessionId)?.mode === 'finishing'
}

export function listSupervisions() {
  return [...states.values()]
}

/** 正在等待重试的会话：单独的恢复条靠它显示倒计时与按钮。 */
const recoveries = new Map()

/** 每个会话的恢复动作：立即重试 / 放弃重试，由 retry 注册、HTTP 接口调用。 */
const recoveryControls = new Map()

/**
 * 记录一次恢复等待。
 * @param {string} sessionId - 会话 id。
 * @param {{cls:string, attempt:number, maxAttempts:number, waitMs:number, resumeAt:number, message:string}} status - 只是给界面看的快照。
 */
export function setRecoveryStatus(sessionId, status) {
  recoveries.set(sessionId, status)
  return status
}

export function clearRecoveryStatus(sessionId) {
  recoveries.delete(sessionId)
}

export function clearAllRecoveries() {
  recoveries.clear()
}

export function recoveryStatusOf(sessionId) {
  return recoveries.get(sessionId)
}

export function listRecoveries() {
  return [...recoveries.entries()].map(([sessionId, status]) => ({ sessionId, ...status }))
}

/** 登记某个会话的恢复动作；恢复结束或放弃时注销。 */
export function setRecoveryControl(sessionId, control) {
  recoveryControls.set(sessionId, control)
  return control
}

export function clearRecoveryControl(sessionId) {
  recoveryControls.delete(sessionId)
}

export function recoveryControlOf(sessionId) {
  return recoveryControls.get(sessionId)
}

/**
 * 两个跨模块钩子：core 注册，retry 调用。
 *  - 恢复轮到点时由 core 打下一轮（监督中的轮次只能由 core 注入）；
 *  - 放弃重试时若在监督中，顺手把监督也结束掉。
 */
let resumeRoundHook
let stopSupervisionHook

export function setResumeRoundHook(hook) {
  resumeRoundHook = hook
  return () => {
    if (resumeRoundHook === hook) resumeRoundHook = undefined
  }
}

/** 请求 core 立即注入一轮；返回 true 表示已经接管。 */
export function requestResumeRound(sessionId) {
  if (typeof resumeRoundHook !== 'function') return false
  try {
    return resumeRoundHook(sessionId) === true
  } catch {
    return false
  }
}

export function setStopSupervisionHook(hook) {
  stopSupervisionHook = hook
  return () => {
    if (stopSupervisionHook === hook) stopSupervisionHook = undefined
  }
}

/** 请 core 结束这个会话的监督；返回 true 表示当时确实在监督。 */
export function requestStopSupervision(sessionId) {
  if (typeof stopSupervisionHook !== 'function') return false
  try {
    return stopSupervisionHook(sessionId) === true
  } catch {
    return false
  }
}
