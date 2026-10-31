/**
 * dont-stop-retry：错误分级恢复。
 *
 * 由包根入口（index.js）与 core 一起挂进同一个插件行，不单独占一行。
 * 只做回合级恢复：一轮以错误结束（官方 llm-retry 已经把短抖动吃完了）之后，
 * 按错误类别等一段时间再把工作拉起来——
 *  - 监督中的会话：到点后请 core 注入下一轮（轮次只能由 core 驱动）；
 *  - 有 goal 的普通会话：重新武装 goal，让官方 driver 接着跑；
 *  - 没有 goal 的普通会话：注入一条恢复提示，重新开一轮。
 *
 * 等待期间会登记一条状态，界面用一条独立的恢复条显示“错误类型 / 第几次 / 倒计时”，
 * 并提供“立即重试”和“放弃重试”。放弃重试时如果正在 Dont-Stop 监督，会连监督一起结束；
 * 反过来，用户手动结束监督不会带走等待中的重试。
 *
 * 只接管顶层会话，子会话的失败由父会话的工具结果处理；人类主动停止/取消不算错误，不恢复。
 * 设置页把“报错恢复”关掉时不做任何动作，交回 DSH 的普通失败处理。
 */

import {
  AUTH,
  CONTEXT,
  DEFAULT_RECOVERY_DELAYS,
  classifyError,
} from '../shared/classify.js'
import { userMessage } from '../shared/message.js'
import {
  clearAllRecoveries,
  clearRecoveryControl,
  clearRecoveryStatus,
  getSupervision,
  requestResumeRound,
  requestStopSupervision,
  setRecoveryControl,
  setRecoveryStatus,
} from '../shared/state.js'
import {
  errorText,
  formatDuration,
  goalRef,
  isLiveAgent,
  logInfo,
  logWarn,
  mergeConfig,
} from '../shared/util.js'
import { createSettingsStore } from '../core/settings.js'
import { recoveryPrompt } from './prompts.js'

export const name = 'dont-stop-retry'
export const inject = ['agents']

const DEFAULTS = {
  turnRecovery: {
    enabled: true,
    resumeGoal: true,
    delaysMs: null,
    maxConsecutiveSameClass: 5,
    onExhausted: 'block',
  },
}

const RESUME_CODES = new Set(['round-limit', 'queue-failed', 'prompt-rejected'])

/** 人类主动停止/取消的失败不恢复：那不是错误，是意图。 */
const DELIBERATE_STOP = /abort|cancel|interrupt|stopped by|disposed/i

/** 错误事件可能早于 idle 状态切换：投递恢复回合前轮询等待。 */
const IDLE_POLL_MS = 500
const IDLE_WAIT_MAX_MS = 15000

/**
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 这一行的配置。
 * @param {{settings?: ReturnType<typeof createSettingsStore>}} [options] - 与同一行的其他模块共用的设置存储。
 */
export function apply(ctx, config = {}, options = {}) {
  const cfg = mergeConfig(mergeConfig({}, DEFAULTS), config)
  cfg.turnRecovery = mergeConfig(DEFAULTS.turnRecovery, config?.turnRecovery)

  // 直接挂载这个模块（没有同一行的其他模块）时自己开一个存储，读的是同一个设置文件。
  const settings = options.settings ?? createSettingsStore()

  /** 设置页关掉“报错恢复”后，退回普通失败处理。 */
  function recoveryEnabled() {
    return settings.get().errorRecovery !== false
  }

  const recovery = new Map()

  function delaysFor(cls) {
    const configured = cfg.turnRecovery.delaysMs
    if (Array.isArray(configured)) return configured.length > 0 ? configured : null
    if (configured && typeof configured === 'object') {
      const perClass = configured[cls]
      return Array.isArray(perClass) && perClass.length > 0 ? perClass : null
    }
    return DEFAULT_RECOVERY_DELAYS[cls] ?? null
  }

  function ensureRoundBudget(goals, agent, goal) {
    if (goal.roundsStarted < goal.maxGoalRounds) return goal
    const next = goal.maxGoalRounds + 64
    return goals.edit(agent, goalRef(goal), { maxGoalRounds: next })
  }

  /** 有 goal 的会话：按状态重新武装；处理了返回 true。 */
  function resumeGoal(agent, cls) {
    try {
      if (!isLiveAgent(ctx, agent)) return false
      const supervision = getSupervision(agent.id)
      if (supervision && supervision.mode === 'finishing') return false
      const goals = ctx.get('goals')
      if (!goals) return false
      if (!cfg.turnRecovery.resumeGoal) return false
      let goal = goals.get(agent)
      if (goal === undefined) return false

      if (goal.phase === 'active' && goal.activation === 'disarmed') {
        goal = ensureRoundBudget(goals, agent, goal)
        goals.resume(agent, goalRef(goal))
        logInfo(ctx, `goal re-armed after ${cls} failure`)
        return true
      }
      if (goal.phase === 'paused') {
        goal = ensureRoundBudget(goals, agent, goal)
        goals.resume(agent, goalRef(goal))
        logInfo(ctx, `goal resumed after ${cls} failure`)
        return true
      }
      if (goal.phase === 'blocked' && RESUME_CODES.has(goal.blockedReason?.code)) {
        goal = goals.edit(agent, goalRef(goal), { maxGoalRounds: goal.maxGoalRounds + 64 })
        goals.resume(agent, goalRef(goal))
        logInfo(ctx, `goal recovered from ${goal.blockedReason?.code ?? 'blocked'} after ${cls} failure`)
        return true
      }
      return false
    } catch (error) {
      logWarn(ctx, `goal recovery failed: ${errorText(error)}`)
      return false
    }
  }

  /**
   * 没有 goal 可复活的普通会话：注入一条恢复提示，重新开一轮。
   * 错误事件偶尔早于状态切到 idle，所以先等它空闲再投递，最多等 15 秒。
   */
  function startRecoveryTurn(agent, cls, attempt, message, waitedMs = 0) {
    try {
      if (!isLiveAgent(ctx, agent)) return false
      if (agent.status !== 'idle') {
        if (waitedMs >= IDLE_WAIT_MAX_MS) {
          logWarn(ctx, `not queueing the recovery turn: the agent is still ${agent.status}`)
          return false
        }
        const current = recovery.get(agent)
        if (current === undefined) return false
        current.idleTimer = setTimeout(() => {
          current.idleTimer = undefined
          startRecoveryTurn(agent, cls, attempt, message, waitedMs + IDLE_POLL_MS)
        }, IDLE_POLL_MS)
        return true
      }
      // 走官方的 followup 队列：用户排在前面的消息仍然先跑。
      agent.followup(userMessage(recoveryPrompt({ cls, attempt, message })))
      logInfo(ctx, `${cls} ended the turn; a recovery turn was queued (attempt ${attempt})`)
      return true
    } catch (error) {
      logWarn(ctx, `could not queue the recovery turn: ${errorText(error)}`)
      return false
    }
  }

  /** 等待结束、真正恢复：监督中交给 core 打下一轮，其余走 goal 或恢复提示。 */
  function resumeWork(agent, cls, attempt, message) {
    if (!isLiveAgent(ctx, agent)) return
    clearRecoveryStatus(agent.id)
    if (getSupervision(agent.id) !== undefined) {
      if (requestResumeRound(agent.id)) return
      // 监督中但暂时打不出轮次：core 的空闲处理会在恢复等待撤掉后自己补上。
      return
    }
    if (resumeGoal(agent, cls)) return
    try {
      const goals = ctx.get('goals')
      if (goals?.get(agent) !== undefined) return
    } catch {
      return
    }
    startRecoveryTurn(agent, cls, attempt, message)
  }

  /** 只接管顶层会话：子会话的失败由父会话的工具结果处理，不替它续跑。 */
  function isRootAgent(agent) {
    try {
      const agents = ctx.get('agents')
      const roots = agents?.roots?.()
      if (!Array.isArray(roots)) return true
      return roots.includes(agent)
    } catch {
      return true
    }
  }

  /** 人类主动停止或被放弃的失败不恢复。 */
  function deliberateStop(error) {
    const code = typeof error?.code === 'string' ? error.code : ''
    const message = typeof error?.message === 'string' ? error.message : ''
    return DELIBERATE_STOP.test(`${code} ${message}`)
  }

  function stopLoss(agent, cls, consecutive) {
    try {
      const goals = ctx.get('goals')
      if (!goals) return
      const goal = goals.get(agent)
      if (goal === undefined) return
      if (cfg.turnRecovery.onExhausted === 'block') {
        goals.block(agent, goalRef(goal), {
          code: 'recovery-exhausted',
          message: `Automatic recovery stopped after ${consecutive} consecutive ${cls} failures.`,
        })
      }
      logWarn(ctx, `recovery exhausted after ${consecutive} consecutive ${cls} failures; waiting for a human`)
    } catch (error) {
      logWarn(ctx, `stop-loss bookkeeping failed: ${errorText(error)}`)
    }
  }

  /** 撤掉一个等待里的两个定时器：排期定时器与“等 agent 空闲”的轮询。 */
  function clearTimers(entry) {
    if (entry === undefined) return
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  /** 清掉一个会话的等待：定时器、状态条数据、恢复动作都撤掉。 */
  function clearRecovery(agent) {
    const current = recovery.get(agent)
    if (current !== undefined) {
      clearTimers(current)
      recovery.delete(agent)
    }
    clearRecoveryStatus(agent.id)
    clearRecoveryControl(agent.id)
  }

  function scheduleRecovery(agent, cls, attempt, delayMs, message) {
    const current = recovery.get(agent) ?? { consecutive: 0 }
    // 上一轮的 500ms 空闲轮询还活着的话，它会按旧的 cls/attempt 再投一条恢复提示。
    clearTimers(current)
    current.consecutive = attempt
    current.cls = cls
    current.timer = setTimeout(() => {
      current.timer = undefined
      resumeWork(agent, cls, attempt, message)
    }, delayMs)
    recovery.set(agent, current)
    const status = {
      cls,
      attempt,
      maxAttempts: cfg.turnRecovery.maxConsecutiveSameClass,
      waitMs: delayMs,
      resumeAt: Date.now() + delayMs,
      message,
      supervised: getSupervision(agent.id) !== undefined,
    }
    setRecoveryStatus(agent.id, status)
    // 界面上的两个按钮：立即重试、放弃重试。
    setRecoveryControl(agent.id, {
      retryNow() {
        const entry = recovery.get(agent)
        if (entry?.timer !== undefined) {
          clearTimeout(entry.timer)
          entry.timer = undefined
        }
        resumeWork(agent, cls, attempt, message)
      },
      cancel() {
        clearRecovery(agent)
        // 监督中放弃重试，等于连监督一起关掉；反过来结束监督不影响仍在等待的重试。
        if (getSupervision(agent.id) !== undefined) requestStopSupervision(agent.id)
        logInfo(ctx, `automatic recovery was cancelled for ${agent.id}`)
      },
    })
  }

  const onAgentError = ({ agent, error }) => {
    try {
      if (!cfg.turnRecovery.enabled) return
      if (!recoveryEnabled()) return
      if (!isRootAgent(agent)) return
      if (deliberateStop(error)) {
        logInfo(ctx, `not recovering after a deliberate stop: ${errorText(error)}`)
        return
      }
      const cls = classifyError(error)
      if (cls === AUTH || cls === CONTEXT) {
        logWarn(ctx, `${cls} failure cannot be retried automatically: ${errorText(error)}`)
        return
      }
      const delays = delaysFor(cls)
      if (delays === null) return

      const previous = recovery.get(agent) ?? { consecutive: 0 }
      clearTimers(previous)
      const attempt = previous.consecutive + 1
      if (attempt > cfg.turnRecovery.maxConsecutiveSameClass) {
        recovery.set(agent, previous)
        clearRecovery(agent)
        stopLoss(agent, cls, attempt)
        return
      }
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)]
      scheduleRecovery(agent, cls, attempt, delayMs, errorText(error))
      logInfo(ctx, `${cls} ended the turn; recovery scheduled in ${formatDuration(delayMs)} (attempt ${attempt})`)
    } catch (error) {
      logWarn(ctx, `turn recovery scheduling failed: ${errorText(error)}`)
    }
  }

  const onSessionEvent = (session, event) => {
    try {
      const agent = ctx.agents.get(session.id)
      if (!agent) return
      const current = recovery.get(agent)
      if (!current) return
      const type = event?.type
      // 有新的回合开始（人类消息、goal driver 或我们自己的恢复提示），或这一轮已经在产出内容：
      // 等待作废、状态条收起，但连续失败计数保留——多步任务里“前几步成功、最后一步才报错”是常态，
      // 在这里清零会让退避永远停在第一档、stop-loss 永远到不了。
      if (type === 'turn/start' || type === 'assistant/message') {
        clearTimers(current)
        clearRecoveryStatus(agent.id)
        clearRecoveryControl(agent.id)
        return
      }
      if (type !== 'turn/end') return
      // 以错误结束的一轮：agent/error 已经排好了恢复（它先于 turn/end 发出），这里不能当成成功收尾撤掉。
      if (event.data?.reason?.kind === 'error') return
      // 正常跑完的一轮或人类中止：等待与计数一起清零。
      clearRecovery(agent)
    } catch {
      /* 观测性监听器失败不影响主流程 */
    }
  }

  const onDisposed = ({ agent }) => {
    clearRecovery(agent)
  }

  /** 设置页关掉“报错恢复”：所有等待中的重试立即撤掉。 */
  const unsubscribeSettings = settings.subscribe((value) => {
    if (value.errorRecovery !== false) return
    for (const agent of [...recovery.keys()]) clearRecovery(agent)
  })

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.on('agent/error', onAgentError))
    disposers.push(ctx.on('session/event', onSessionEvent))
    disposers.push(ctx.on('agent/disposed', onDisposed))

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          logWarn(ctx, `dispose failed: ${errorText(error)}`)
        }
      }
      unsubscribeSettings()
      for (const agent of [...recovery.keys()]) clearRecovery(agent)
      clearAllRecoveries()
    }
  }, 'dont-stop-retry lifecycle')
}
