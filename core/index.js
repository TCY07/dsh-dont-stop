/**
 * dont-stop-core：/dont-stop 命令、自主轮次驱动、等待声明、软着陆与强停。
 *
 * 驱动方式：插件自己按轮次注入提示（followup），不接管官方 goal 状态机。
 * 监督状态靠注入的上下文消息播报，不改系统提示词：开始时说明截止时间与规则，延长时间更新，
 * 收尾时说明已经结束；dont_stop_wait 常驻注册，只在处于监督中的会话里生效。
 * 这些公告的开标签带机器可读属性，core/projection.js 据此折叠出界面用的监督状态；
 * 每条监督结束时都会写一条结束公告，进程重启或会话重新打开时再对账补上缺的那条。
 *  - 官方 goal 处于 active+armed（driver 自己会续轮）时让位，只在它停下后接力。
 *  - 到点收尾与模型声明等待时会临时关掉续轮开关；收工后把仍在进行的目标置为暂停。
 *  - 每轮提示要求模型在旧目标完成后自行决定下一个目标（结合工作区状态与用户可能期望），而不是死守原目标。
 *
 * 未到点：工具调用一律等结果；只有“等人类回答”有上限（默认 5 分钟）。
 * 到点：停止注入轮次 → 提示收尾（模型空闲时也叫醒一轮）→ 5 分钟软着陆窗口 → 强停
 * （停子 agent/后台任务，再结束 turn）。
 * 人类手动强停（终止回答）优先级最高：直接终止监督。
 *
 * 发给模型的文字都在仓库根的 prompts.json，由 core/prompts.js 读取拼装；运行时设置（报错恢复、到点是否要求停止、
 * 两轮监督消息的最短间隔、提问限时、保持系统唤醒）在 core/settings.js，由设置页直接读写，改了立即生效。
 */

import { DEFAULT_DURATION_MS, MAX_DURATION_MS, USAGE, parseSpec } from '../shared/duration.js'
import { userMessage } from '../shared/message.js'
import {
  dropSupervision,
  inResumeGrace,
  listRecoveries,
  markResume,
  recoveryControlOf,
  recoveryStatusOf,
  setResumeRoundHook,
  setStopSupervisionHook,
  setSupervision,
} from '../shared/state.js'
import { PROJECTION_KEY, createProjection } from './projection.js'
import {
  WAIT_TOOL_DESCRIPTION,
  endNotice,
  finishSteer,
  humanTimeoutPrompt,
  roundPrompt,
  supervisionNotice,
} from './prompts.js'
import { MAX_QUESTION_LIMIT_MS, createSettingsStore, readBody, registerSettingsRoute, sameOrigin } from './settings.js'
import {
  errorText,
  formatClock,
  formatDuration,
  goalRef,
  isLiveAgent,
  logInfo,
  logWarn,
  mergeConfig,
} from '../shared/util.js'

export const name = 'dont-stop-core'
export const inject = ['agents', 'commands', 'tools']

const DEFAULTS = {
  duration: { defaultMs: DEFAULT_DURATION_MS, maxMs: MAX_DURATION_MS },
  finish: { graceMs: 300000, stopChildren: true, stopJobs: true },
  wait: { defaultMs: 600000, maxMs: 7200000 },
}

const TIMER_CHUNK_MS = 3600000
const HUMAN_QUESTION_TOOL = 'ask_user_question'
const WAIT_TOOL = 'dont_stop_wait'
const ERROR_BACKOFF_BASE_MS = 60000
const ERROR_BACKOFF_MAX_MS = 900000
const DRIVER_RECHECK_MS = 60000
/** 恢复等待的只读接口：请求级重试不落会话事件，状态条轮询它显示“恢复中”。 */
const RECOVERY_ROUTE_PATH = '/dsh-dont-stop/recovery'

/** 保持唤醒状态的只读接口：设置页用它显示当前由谁在阻止系统睡眠。 */
const POWER_ROUTE_PATH = '/dsh-dont-stop/power'

/** 系统恢复后的宽限期：这段时间里的失败是“被打断”，不是真的失败。 */
const RESUME_GRACE_MS = 10000

/**
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 这一行的配置。
 * @param {{settings?: ReturnType<typeof import('./settings.js').createSettingsStore>, power?: ReturnType<typeof import('../power/index.js').createKeepAwake>}} [options] - 与同一行的其他模块共用的设置存储与保持唤醒服务。
 */
export function apply(ctx, config = {}, options = {}) {
  const cfg = mergeConfig(mergeConfig({}, DEFAULTS), config)
  cfg.duration = mergeConfig(DEFAULTS.duration, config?.duration)
  cfg.finish = mergeConfig(DEFAULTS.finish, config?.finish)
  cfg.wait = mergeConfig(DEFAULTS.wait, config?.wait)

  const settings = options.settings ?? createSettingsStore({
    onError: (error) => logWarn(ctx, `could not save the plugin settings: ${errorText(error)}`),
  })
  // 保持唤醒由包根入口创建并挂好生命周期，这里只负责在监督开始/结束时登记所有权。
  const power = options.power
  const states = new Map()

  function goalsService() {
    return ctx.get('goals')
  }

  function readGoal(agent) {
    const goals = goalsService()
    if (!goals) return undefined
    try {
      return goals.get(agent)
    } catch {
      return undefined
    }
  }

  /** 官方 driver 只会驱动 active + armed 的 goal；它有事可做时插件让位。 */
  function driverWillDrive(agent) {
    const goal = readGoal(agent)
    return goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'
  }

  /** 收尾/终止时才停掉官方续轮：disarm 是进程内操作，不改 phase、不落库。 */
  function stopDriver(state) {
    const goals = goalsService()
    if (!goals) return
    try {
      const goal = goals.get(state.agent)
      if (goal !== undefined && goal.activation === 'armed') goals.disarm(state.agent)
    } catch (error) {
      logWarn(ctx, `could not stop the official goal driver: ${errorText(error)}`)
    }
  }

  function publish(state) {
    setSupervision(state.agent.id, state)
  }

  /** 保持唤醒的登记失败不能影响监督本身：只记一条日志。 */
  function powerHold(sessionId) {
    try {
      power?.hold?.(sessionId)
    } catch (error) {
      logWarn(ctx, `could not hold the wake lock: ${errorText(error)}`)
    }
  }

  function powerRelease(sessionId) {
    try {
      power?.release?.(sessionId)
    } catch (error) {
      logWarn(ctx, `could not release the wake lock: ${errorText(error)}`)
    }
  }

  /** 恢复等待期间被临时停掉的官方续轮；目标已经不在 active 时什么也不做。 */
  function resumeDriver(state) {
    const goals = goalsService()
    if (!goals) return false
    try {
      const goal = goals.get(state.agent)
      if (goal === undefined || goal.phase !== 'active') return false
      goals.resume(state.agent, goalRef(goal))
      return true
    } catch (error) {
      logWarn(ctx, `could not resume the official goal: ${errorText(error)}`)
      return false
    }
  }

  /**
   * 投递一条监督公告。用 inject 而不是 followup：它排进下一步的输入、不额外唤醒回合，
   * 因此会并进下一次真正要跑的回合里，而不是自己造出一个回合。
   *
   * 公告的 `machine` 挂在消息 source 上：模型只看到正文，界面投影从 source 读时间。
   * @returns {boolean} 是否投递成功；会话正在发布事件时会拒绝再次追加，调用方要延后重试。
   */
  function injectNotice(agent, notice) {
    try {
      const text = typeof notice === 'string' ? notice : notice.text
      const machine = typeof notice === 'string' ? undefined : notice.machine
      agent.inject(machine === undefined ? userMessage(text) : userMessage(text, 'dont-stop', { dontStop: machine }))
      return true
    } catch (error) {
      logWarn(ctx, `could not inject a supervision notice: ${errorText(error)}`)
      return false
    }
  }

  /**
   * 延后一条公告到当前这批事件发布完成之后再投。
   * `turn/end` 发布期间会话禁止再次 append，此刻注入会失败、公告丢失，状态条会一直停在“监督中”。
   */
  function injectNoticeLater(agent, notice) {
    queueMicrotask(() => {
      // 期间又开了新一轮监督：这条结束公告已经过时，投进去反而会把新状态清掉。
      // 注意不能用 isSupervising：收尾中的这一轮自己也在 states 里，那会把本该投递的结束公告丢掉。
      if (hasSupervisingState(agent.id)) return
      injectNotice(agent, notice)
    })
  }

  /**
   * 命令里附带的初始指令：以用户消息的形式投递。
   * 斜杠命令会吞掉整行输入，剩下的文字不会自动变成用户消息；这样会话里既有用户对话框，
   * 模型也真的收到这段指令。
   */
  function queueObjective(state) {
    if (typeof state.objective !== 'string' || state.objective.trim() === '') return
    try {
      state.agent.followup(userMessage(state.objective, 'user'))
    } catch (error) {
      logWarn(ctx, `could not queue the initial objective: ${errorText(error)}`)
    }
  }

  /** 模型可主动声明“我在等外部事情”：声明期间不注入新轮次。 */
  function waitToolDefinition() {
    return {
      name: WAIT_TOOL,
      description: WAIT_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '你在等什么；会显示在日志和状态里。' },
          minutes: { type: 'number', description: '等这么多分钟后唤醒（默认取插件配置）。' },
          job_id: { type: 'string', description: '要等待的后台任务 id；它结束后继续。' },
          subagent_id: { type: 'string', description: '只等这一个子 agent；它返回后继续。不传则等当前正在跑的子 agent 全部结束。' },
        },
        required: ['reason'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            wakeAt: { type: 'number' },
            jobId: { type: 'string' },
            subagentId: { type: 'string' },
            subagentIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['status'],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec) => {
        const agent = exec?.agent
        const current = agent === undefined ? undefined : states.get(agent)
        if (current === undefined) return { status: 'not-supervised' }
        if (current.mode !== 'supervising') return { status: 'finishing' }
        const minutes = typeof args?.minutes === 'number' && Number.isFinite(args.minutes) ? args.minutes : undefined
        const jobId = typeof args?.job_id === 'string' && args.job_id !== '' ? args.job_id : undefined
        const subagentId = typeof args?.subagent_id === 'string' && args.subagent_id !== '' ? args.subagent_id : undefined
        // 没点名某个子 agent 时，把“当前正在跑的直接子 agent”整体当成一个 join：
        // 全部结束才唤醒，而不是谁先结束谁说了算。
        const subagentIds = subagentId === undefined ? await runningSubagents(agent) : undefined
        // 列举子 agent 是异步的：这期间监督可能已经结束，别把等待挂到已经不在的状态上。
        if (states.get(agent) !== current || current.mode !== 'supervising') return { status: 'not-supervised' }
        const wakeAt = beginWait(current, {
          reason: typeof args?.reason === 'string' ? args.reason : '',
          minutes,
          jobId,
          subagentId,
          subagentIds,
        })
        const joined = subagentIds === undefined || subagentIds.size === 0 ? undefined : [...subagentIds]
        return {
          status: 'waiting',
          ...(wakeAt === undefined ? {} : { wakeAt }),
          ...(jobId === undefined ? {} : { jobId }),
          ...(subagentId === undefined ? {} : { subagentId }),
          ...(joined === undefined ? {} : { subagentIds: joined }),
        }
      },
    }
  }

  /**
   * 当前正在跑的直接子 agent。用它把“等子 agent”做成 join：
   * 拿不到服务或读不出来时返回 undefined，调用方退回“首个结束即唤醒”。
   */
  async function runningSubagents(agent) {
    const service = ctx.get('subagents')
    if (!service || typeof service.listDescendants !== 'function') return undefined
    try {
      const entries = await service.listDescendants(agent.id)
      if (!Array.isArray(entries)) return undefined
      const ids = new Set()
      for (const entry of entries) {
        if (entry?.kind !== 'child' || entry.depth !== 1 || entry.activity !== 'running') continue
        if (typeof entry.id === 'string' && entry.id !== '') ids.add(entry.id)
      }
      return ids
    } catch (error) {
      logWarn(ctx, `could not list the running subagents: ${errorText(error)}`)
      return undefined
    }
  }

  function clearDeadlineTimer(state) {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  function clearHardTimer(state) {
    if (state.hardTimer !== undefined) {
      clearTimeout(state.hardTimer)
      state.hardTimer = undefined
    }
  }

  function clearHumanTimer(state) {
    if (state.humanTimer !== undefined) {
      clearTimeout(state.humanTimer)
      state.humanTimer = undefined
    }
  }

  function clearRoundTimer(state) {
    if (state.roundTimer !== undefined) {
      clearTimeout(state.roundTimer)
      state.roundTimer = undefined
    }
  }

  function armDeadlineTimer(state) {
    clearDeadlineTimer(state)
    if (state.mode !== 'supervising') return
    const remaining = state.deadlineAt - Date.now()
    if (remaining <= 0) {
      beginFinish(state, 'deadline')
      return
    }
    state.timer = setTimeout(() => {
      state.timer = undefined
      armDeadlineTimer(state)
    }, Math.min(remaining, TIMER_CHUNK_MS))
  }

  function pendingHumanQuestion(state) {
    for (const entry of state.pending.values()) {
      if (entry.name === HUMAN_QUESTION_TOOL) return entry
    }
    return undefined
  }

  /** 提问限时：设置页的值，0 表示不限。 */
  function questionLimitMs() {
    const value = Number(settings.get().questionLimitMs)
    if (!Number.isFinite(value) || value <= 0) return 0
    return Math.min(Math.round(value), MAX_QUESTION_LIMIT_MS)
  }

  /** 没在监督时是否也限制提问等待。 */
  function questionLimitAlways() {
    return settings.get().questionLimitAlways === true
  }

  /** 等人类回答的上限，超时关闭问题并要求模型自行决定；0 表示不限。 */
  function scheduleHumanWait(state) {
    clearHumanTimer(state)
    const limit = questionLimitMs()
    if (limit <= 0) return
    state.humanTimer = setTimeout(() => {
      state.humanTimer = undefined
      expireHumanQuestion(state)
    }, Math.max(limit, 1))
  }

  function expireHumanQuestion(state) {
    if (states.get(state.agent) !== state || state.mode !== 'supervising') return
    const { agent } = state
    if (!isLiveAgent(ctx, agent)) return
    state.humanWaits += 1
    logWarn(ctx, `no human answer within ${formatDuration(questionLimitMs())}; closing the question and asking the agent to decide`)
    state.selfStop = true
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      logWarn(ctx, `could not close the pending question: ${errorText(error)}`)
    }
    try {
      agent.followup(userMessage(humanTimeoutPrompt()))
    } catch (error) {
      logWarn(ctx, `could not queue the decide-yourself prompt: ${errorText(error)}`)
    }
    state.pending.clear()
  }

  /* ── 没在监督时的提问等待（“始终提问限时”开启后生效） ── */

  const questionWaits = new Map()

  function clearQuestionWait(agent) {
    const entry = questionWaits.get(agent)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    questionWaits.delete(agent)
  }

  function scheduleQuestionWait(agent) {
    clearQuestionWait(agent)
    const limit = questionLimitMs()
    if (limit <= 0) return
    const timer = setTimeout(() => {
      questionWaits.delete(agent)
      expireQuestionWait(agent)
    }, Math.max(limit, 1))
    questionWaits.set(agent, { timer })
  }

  /** 超时与监督中一致：关掉提问、让 agent 自行决定，然后继续。 */
  function expireQuestionWait(agent) {
    if (!isLiveAgent(ctx, agent)) return
    logWarn(ctx, `no human answer within ${formatDuration(questionLimitMs())}; closing the question and asking the agent to decide`)
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      logWarn(ctx, `could not close the pending question: ${errorText(error)}`)
    }
    try {
      agent.followup(userMessage(humanTimeoutPrompt()))
    } catch (error) {
      logWarn(ctx, `could not queue the decide-yourself prompt: ${errorText(error)}`)
    }
  }

  function scheduleRound(state, delayMs) {
    clearRoundTimer(state)
    if (state.mode !== 'supervising') return
    state.roundTimer = setTimeout(() => {
      state.roundTimer = undefined
      injectRound(state)
    }, Math.max(delayMs, 1))
  }

  /**
   * 注入一轮自主提示。
   * 官方 driver 正在驱动（goal active+armed）时让位，只安排一次复查；
   * 等它把当前流程跑完（完成/阻塞/出错/无 goal），再由这里接力。
   */
  function injectRound(state) {
    if (states.get(state.agent) !== state || state.mode !== 'supervising') return
    const { agent } = state
    if (!isLiveAgent(ctx, agent) || agent.status !== 'idle') return
    if (state.waiting !== undefined) return
    // 正在等错误恢复：这段时间不发“进行下一轮”，到点由 retry 叫醒这里。
    if (recoveryStatusOf(agent.id) !== undefined) return
    if (Date.now() >= state.deadlineAt) {
      beginFinish(state, 'deadline')
      return
    }
    // 出错退避与“两条监督消息的最短间隔”取较晚的那个时刻。
    const earliest = Math.max(state.nextRoundAt, state.lastRoundAt + settings.get().minRoundIntervalMs)
    if (Date.now() < earliest) {
      scheduleRound(state, earliest - Date.now())
      return
    }
    if (driverWillDrive(agent)) {
      scheduleRound(state, DRIVER_RECHECK_MS)
      return
    }
    state.lastRoundAt = Date.now()
    state.rounds += 1
    try {
      agent.followup(userMessage(roundPrompt(state)))
      logInfo(ctx, `round ${state.rounds} started for ${agent.id}`)
    } catch (error) {
      logWarn(ctx, `could not queue round ${state.rounds}: ${errorText(error)}`)
      scheduleRound(state, ERROR_BACKOFF_BASE_MS)
    }
  }

  function clearWait(state) {
    if (state.waitTimer !== undefined) {
      clearTimeout(state.waitTimer)
      state.waitTimer = undefined
    }
    const dispose = state.waitDisposer
    state.waitDisposer = undefined
    if (typeof dispose === 'function') {
      try {
        dispose()
      } catch (error) {
        logWarn(ctx, `wait subscription dispose failed: ${errorText(error)}`)
      }
    }
    state.waiting = undefined
  }

  /** 结束等待：若此前为了等待停过官方续轮就恢复它，否则直接开下一轮。 */
  function endWait(state, reason) {
    if (state.waiting === undefined) return
    const waiting = state.waiting
    const stoppedDriver = state.waitStoppedDriver
    state.waitStoppedDriver = false
    clearWait(state)
    logInfo(ctx, `wait ended (${reason})${waiting.reason === '' ? '' : `: ${waiting.reason}`}`)
    if (state.mode !== 'supervising' || Date.now() >= state.deadlineAt) return
    // 驱动接不回来（目标已完成/被阻塞/被删）时不能就此停摆：排一轮让监督继续。
    if (stoppedDriver && resumeDriver(state)) return
    scheduleRound(state, 1)
  }

  /** 开始等待：停止注入轮次，并登记唤醒来源。 */
  function beginWait(state, request) {
    clearWait(state)
    const { agent } = state
    const requestedMs = Number.isFinite(request.minutes) ? request.minutes * 60000 : cfg.wait.defaultMs
    const waitMs = Math.min(Math.max(requestedMs, 1), cfg.wait.maxMs)
    state.waiting = {
      reason: request.reason ?? '',
      jobId: request.jobId,
      subagentId: request.subagentId,
      // join 模式：这些子 agent 全部结束才唤醒。声明时为空集合表示“没有在跑的子 agent”。
      subagentIds: request.subagentIds,
      wakeAt: Date.now() + waitMs,
    }
    state.waitTimer = setTimeout(() => {
      state.waitTimer = undefined
      endWait(state, 'timer')
    }, waitMs)

    if (request.jobId !== undefined) {
      const jobs = ctx.get('jobs')
      if (jobs?.events && typeof jobs.events.subscribe === 'function') {
        try {
          state.waitDisposer = jobs.events.subscribe({ owner: agent.id }, (event) => {
            if (event?.type !== 'settled') return
            if (state.waiting?.jobId !== undefined && event.job?.id !== state.waiting.jobId) return
            endWait(state, 'job-settled')
          })
        } catch (error) {
          logWarn(ctx, `could not subscribe to job settlement: ${errorText(error)}`)
        }
      }
    }

    clearRoundTimer(state)
    // 模型明确声明等待时，临时停掉官方续轮；等待结束后若原本在驱动则恢复。
    // 同一轮里再次声明等待时，驱动可能已经被上一次等待停掉，这个标记不能因此丢掉。
    state.waitStoppedDriver = state.waitStoppedDriver === true || driverWillDrive(agent)
    if (state.waitStoppedDriver) stopDriver(state)
    const joined = request.subagentIds === undefined ? '' : ` or ${request.subagentIds.size === 0 ? 'any' : [...request.subagentIds].join(', ')} subagent(s) to settle`
    logInfo(ctx, `waiting until ${formatClock(state.waiting.wakeAt)}${request.jobId === undefined ? '' : ` or job ${request.jobId}`}${request.subagentId === undefined ? '' : ` or subagent ${request.subagentId}`}${joined}${request.reason === '' ? '' : `: ${request.reason}`}`)
    return state.waiting.wakeAt
  }

  /** 到点：停止注入 → 收尾提示（空闲也叫醒）→ 5 分钟软着陆窗口。 */
  function beginFinish(state, reason) {
    if (!state || state.mode === 'finishing') return
    // 命令里的选项优先于设置页的全局开关：两者都表示“到点不强停”时，只结束监督。
    if (reason === 'deadline' && (state.stopAtDeadline ?? settings.get().stopAtDeadline) === false) {
      endSupervision(state, 'released')
      return
    }
    state.mode = 'finishing'
    state.finishReason = reason
    clearDeadlineTimer(state)
    clearHumanTimer(state)
    clearRoundTimer(state)
    clearWait(state)
    publish(state)
    const { agent } = state
    if (!isLiveAgent(ctx, agent)) {
      teardownState(state, { quiet: true })
      return
    }
    stopDriver(state)
    // 结束公告同时是状态条的收尾信号：无论模型在不在跑都要写，否则日志里会一直留着“监督中”。
    const notice = endNotice(reason)
    if (!injectNotice(agent, notice)) injectNoticeLater(agent, notice)
    if (!armFinishWindow(state, reason)) settle(state)
  }

  /**
   * 收尾窗口：让模型尽快收尾，缓冲时间后强停。
   *
   * 正在跑就 steer 到当前这一步；空闲（声明过等待、回合已经结束）也要 followup 叫醒一轮，
   * 否则模型既读不到收尾要求，也不会去结束自己启动的 subagent 与后台任务。
   * 人类手动停止且模型空闲时没有在跑的工作，不开这一轮，直接收尾。
   * @returns {boolean} 是否进入了收尾窗口；false 表示调用方应直接收尾。
   */
  function armFinishWindow(state, reason) {
    const { agent } = state
    const running = agent.status === 'running'
    if (!running && reason !== 'deadline') return false
    try {
      const message = userMessage(finishSteer())
      if (running) agent.steer(message)
      else agent.followup(message)
    } catch (error) {
      logWarn(ctx, `could not ask the agent to wrap up: ${errorText(error)}`)
      return false
    }
    clearHardTimer(state)
    state.hardTimer = setTimeout(() => {
      state.hardTimer = undefined
      hardStop(state)
    }, Math.max(cfg.finish.graceMs, 1))
    logInfo(ctx, `supervision finishing (${reason}); ${formatDuration(cfg.finish.graceMs)} grace before the hard stop`)
    return true
  }

  function closeGoal(state) {
    if (state.goalClosed) return
    state.goalClosed = true
    const goals = goalsService()
    if (!goals) return
    const goal = readGoal(state.agent)
    if (goal === undefined || goal.phase !== 'active') return
    try {
      goals.pause(state.agent, goalRef(goal))
    } catch (error) {
      logWarn(ctx, `could not pause goal: ${errorText(error)}`)
    }
  }

  /**
   * 停稳：到点收尾时停掉残留的子 agent 与后台任务，pause 仍在进行的目标，
   * 然后收尾（此时不再给模型发任何消息）。
   */
  function settle(state) {
    if (states.get(state.agent) !== state) return
    // 到点停止承诺“连同 subagent 与后台任务一起停”：模型自己收完尾、回合先结束时，
    // 这里再兜一遍，别把残留的工作留在无人监督的会话里。
    if (state.finishReason === 'deadline') {
      stopChildren(state)
      stopJobs(state)
    }
    closeGoal(state)
    teardownState(state)
  }

  /** 同步停掉子 agent（含更深的后代）：它们的返回结果不允许再把父 agent 唤醒。 */
  function stopChildren(state) {
    if (!cfg.finish.stopChildren) return
    const subagents = ctx.get('subagents')
    if (!subagents) return
    const { agent } = state
    const interruptAll = (entries) => {
      for (const entry of entries ?? []) {
        try {
          subagents.interrupt(entry.id, { kind: 'ancestor', agent })
        } catch (error) {
          logWarn(ctx, `could not interrupt subagent ${entry.id}: ${errorText(error)}`)
        }
      }
    }
    if (typeof subagents.listDescendants === 'function') {
      Promise.resolve()
        .then(() => subagents.listDescendants(agent.id))
        .then(interruptAll)
        .catch((error) => logWarn(ctx, `could not list subagents to stop: ${errorText(error)}`))
      return
    }
    if (typeof subagents.listChildren === 'function') {
      Promise.resolve()
        .then(() => subagents.listChildren(agent.id))
        .then(interruptAll)
        .catch((error) => logWarn(ctx, `could not list subagents to stop: ${errorText(error)}`))
    }
  }

  /** 同步停掉本会话的后台任务。 */
  function stopJobs(state) {
    if (!cfg.finish.stopJobs) return
    const jobs = ctx.get('jobs')
    if (!jobs || typeof jobs.list !== 'function') return
    const { agent } = state
    let listed
    try {
      listed = jobs.list(agent.id)
    } catch (error) {
      logWarn(ctx, `could not list background jobs: ${errorText(error)}`)
      return
    }
    for (const job of listed ?? []) {
      if (job.status !== 'running' && job.status !== 'stopping') continue
      // 列表里还会混着不属于任何会话的后台任务，那些不能因为本会话到点就被顺带杀掉。
      if (job.owner !== agent.id) continue
      try {
        jobs.kill(job.id, agent.id, 'dont-stop: supervision deadline')
      } catch (error) {
        logWarn(ctx, `could not kill job ${job.id}: ${errorText(error)}`)
      }
    }
  }

  /** 到点硬停：等价于用户点“终止回答”，并连带停掉子 agent 与后台任务。 */
  function hardStop(state) {
    if (states.get(state.agent) !== state || state.mode !== 'finishing') return
    const { agent } = state
    logWarn(ctx, `grace period over; stopping the turn, its subagents and background jobs`)
    stopChildren(state)
    stopJobs(state)
    if (isLiveAgent(ctx, agent)) {
      state.selfStop = true
      try {
        agent.cancel({ kind: 'user' })
      } catch (error) {
        logWarn(ctx, `could not stop the running turn: ${errorText(error)}`)
      }
    }
    closeGoal(state)
    teardownState(state)
  }

  function teardownState(state, options = {}) {
    if (states.get(state.agent) !== state) return
    states.delete(state.agent)
    dropSupervision(state.agent.id)
    powerRelease(state.agent.id)
    clearDeadlineTimer(state)
    clearHardTimer(state)
    clearHumanTimer(state)
    clearRoundTimer(state)
    clearWait(state)
    state.pending.clear()
    if (!options.quiet) logInfo(ctx, `supervision ended for ${state.agent.id}`)
  }

  function beginSupervision(agent, spec) {
    // 监督自己有更强的一套提问等待，先收掉没监督时挂的那个计时器。
    clearQuestionWait(agent)
    const now = Date.now()
    const existing = states.get(agent)
    if (existing && existing.mode === 'supervising') {
      // 重新设定截止时间：只改监督状态，不给模型发任何消息，界面倒计时由投影从这次命令日志折叠。
      existing.deadlineAt = spec.deadlineAt
      if (typeof spec.objective === 'string' && spec.objective !== '') existing.objective = spec.objective
      // 没写选项时保留本周期已有的设定；写了就以新选项为准。
      if (spec.stopAtDeadline !== undefined) existing.stopAtDeadline = spec.stopAtDeadline
      publish(existing)
      armDeadlineTimer(existing)
      queueObjective(existing)
      return {
        kind: 'success',
        text: `Dont-Stop extended to ${formatClock(existing.deadlineAt)} (remaining ${formatDuration(existing.deadlineAt - now)}, rounds ${existing.rounds}).`,
      }
    }
    if (existing) teardownState(existing, { quiet: true })

    const state = {
      agent,
      startedAt: now,
      deadlineAt: spec.deadlineAt,
      objective: spec.objective,
      // 本周期到点是否强停：命令里的 --stop / --no-stop 优先于设置页的全局开关；undefined 表示跟设置。
      stopAtDeadline: spec.stopAtDeadline,
      mode: 'supervising',
      // 进入收尾的原因；到点停止要比手动停止多停一层（残留的 subagent 与后台任务）。
      finishReason: undefined,
      rounds: 0,
      nextRoundAt: 0,
      // 两条监督消息的最短间隔从这次监督开始算起。
      lastRoundAt: now,
      errorStreak: 0,
      timer: undefined,
      hardTimer: undefined,
      humanTimer: undefined,
      roundTimer: undefined,
      goalClosed: false,
      pending: new Map(),
      humanWaits: 0,
      waiting: undefined,
      waitTimer: undefined,
      waitDisposer: undefined,
      waitStoppedDriver: false,
      selfStop: false,
    }
    states.set(agent, state)
    publish(state)
    powerHold(agent.id)
    injectNotice(agent, supervisionNotice(state, {
      stopAtDeadline: state.stopAtDeadline ?? settings.get().stopAtDeadline,
    }))
    armDeadlineTimer(state)
    queueObjective(state)
    scheduleRound(state, 1)
    const stopping = state.stopAtDeadline ?? settings.get().stopAtDeadline
    return {
      kind: 'success',
      text: `Dont-Stop active until ${formatClock(state.deadlineAt)} (remaining ${formatDuration(state.deadlineAt - now)}). At the deadline: ${stopping ? 'wrap up and stop the turn' : 'just end supervision and keep working'}.`,
    }
  }

  /**
   * 只调整本周期「到点是否强停」：监督中就地改、不动截止时间；
   * 没在监督时按默认时长开始一轮，选项同样生效。
   */
  function optionCommand(agent, spec) {
    const state = states.get(agent)
    if (state !== undefined && state.mode === 'supervising') {
      state.stopAtDeadline = spec.stopAtDeadline
      publish(state)
      const remaining = Math.max(state.deadlineAt - Date.now(), 0)
      return {
        kind: 'success',
        text: `Deadline behavior set to ${spec.stopAtDeadline ? 'stop the turn' : 'keep working'}; the deadline is unchanged (${formatClock(state.deadlineAt)}, remaining ${formatDuration(remaining)}).`,
      }
    }
    return beginSupervision(agent, {
      kind: 'start',
      deadlineAt: Date.now() + cfg.duration.defaultMs,
      objective: '',
      stopAtDeadline: spec.stopAtDeadline,
    })
  }

  function offCommand(agent) {
    const state = states.get(agent)
    if (!state) {
      // 界面上的“结束 Dont-Stop”也走这里：日志里若还留着一条陈旧公告，顺手补上结束公告把它清掉。
      reconcileStaleNotice(agent)
      return { kind: 'success', text: 'Dont-Stop is not active.' }
    }
    if (state.mode === 'finishing') {
      // 已经在收尾（软着陆）里：再点一次就直接清掉，不再等宽限期。
      endSupervision(state, 'manual')
      return { kind: 'success', text: 'Dont-Stop is not active.' }
    }
    try {
      beginFinish(state, 'manual')
    } catch (error) {
      // 收尾流程出意外也要真的退出：直接清掉监督，别把它挂在“finishing”。
      logWarn(ctx, `finishing failed; ending supervision anyway: ${errorText(error)}`)
      endSupervision(state, 'manual')
    }
    return { kind: 'success', text: 'Dont-Stop ended early; the agent has been asked to wrap up.' }
  }

  const command = {
    name: 'dont-stop',
    description: 'Dont-Stop 插件命令',
    input: { hint: USAGE },
    handler: (invocation) => {
      try {
        const agent = invocation?.agent
        if (!agent) return { kind: 'error', text: 'No live agent for this command.' }
        const spec = parseSpec(invocation.rawInput, {
          now: Date.now(),
          defaultMs: cfg.duration.defaultMs,
          maxMs: cfg.duration.maxMs,
        })
        if (spec.kind === 'error') return { kind: 'error', text: spec.message }
        if (spec.kind === 'option') return optionCommand(agent, spec)
        if (spec.kind === 'off') return offCommand(agent)
        return beginSupervision(agent, spec)
      } catch (error) {
        return { kind: 'error', text: `dont-stop failed: ${errorText(error)}` }
      }
    },
  }

  function onStatus({ agent, status }) {
    if (status !== 'idle') return
    const state = states.get(agent)
    if (!state) return
    try {
      if (state.mode === 'supervising') {
        clearHumanTimer(state)
        scheduleRound(state, Math.max(state.nextRoundAt - Date.now(), 1))
        return
      }
      settle(state)
    } catch (error) {
      logWarn(ctx, `idle handling failed: ${errorText(error)}`)
    }
  }

  /**
   * 系统从睡眠里恢复：定时器在挂起期间被冻结，醒来后不能沿用旧的排期。
   *  - 已经过了截止时间：立刻走收尾；
   *  - 还在监督中：清掉旧排期与错误退避，立即补一轮；
   *  - 等外部事情的等待：时间已经过了就直接结束等待。
   */
  function onSystemResume(info) {
    try {
      markResume(RESUME_GRACE_MS)
      const stamp = Date.now()
      for (const state of [...states.values()]) {
        if (state.mode !== 'supervising') continue
        clearRoundTimer(state)
        if (state.waiting !== undefined && stamp >= state.waiting.wakeAt) {
          endWait(state, 'resume')
          continue
        }
        if (stamp >= state.deadlineAt) {
          beginFinish(state, 'deadline')
          continue
        }
        state.nextRoundAt = 0
        state.errorStreak = 0
        // 正在等错误恢复时由 retry 自己叫醒这一轮，别在这里补出第二轮回。
        if (recoveryStatusOf(state.agent.id) !== undefined) continue
        scheduleRound(state, 1)
      }
      logInfo(ctx, `system resumed after ${Math.round((info?.suspendedMs ?? 0) / 1000)}s suspended; supervision timers re-armed`)
    } catch (error) {
      logWarn(ctx, `resume handling failed: ${errorText(error)}`)
    }
  }

  function onDisposed({ agent }) {
    clearQuestionWait(agent)
    const state = states.get(agent)
    if (state) teardownState(state, { quiet: true })
  }

  function onAgentError({ agent }) {
    const state = states.get(agent)
    if (!state || state.mode !== 'supervising') return
    // 挂起打断了这一轮：错误不是真的失败，别让退避把后续轮次拖长。
    if (inResumeGrace()) {
      state.nextRoundAt = 0
      logInfo(ctx, 'the failure overlapped a system suspend; it is not counted as a failed round')
      return
    }
    state.errorStreak += 1
    const delayMs = Math.min(ERROR_BACKOFF_BASE_MS * 2 ** (state.errorStreak - 1), ERROR_BACKOFF_MAX_MS)
    state.nextRoundAt = Date.now() + delayMs
    logWarn(ctx, `round failed; next round in ${formatDuration(delayMs)} (streak ${state.errorStreak})`)
  }

  /**
   * 维护“未结工具调用”集合，识别人类手动强停与成功回合。
   * 人类强停（turn/end 原因为 aborted/user）优先级最高，直接终止监督。
   */
  function onSessionEvent(session, event) {
    try {
      const type = event?.type
      if (type !== 'tool/call' && type !== 'tool/result' && type !== 'turn/end' && type !== 'turn/start' && type !== 'assistant/message') return
      let state
      for (const candidate of states.values()) {
        if (candidate.agent.id === session.id) {
          state = candidate
          break
        }
      }
      if (state === undefined) {
        // 没在监督：若开了“始终提问限时”，同样给提问挂一个等待计时器。
        const agent = ctx.agents.get(session.id)
        if (agent === undefined) return
        if (type === 'tool/call') {
          const name = typeof event.data?.name === 'string' ? event.data.name : ''
          if (name === HUMAN_QUESTION_TOOL && questionLimitAlways()) scheduleQuestionWait(agent)
          return
        }
        if (type === 'tool/result' || type === 'turn/end') clearQuestionWait(agent)
        return
      }

      if (type === 'turn/start') {
        state.selfStop = false
        return
      }
      if (type === 'tool/call') {
        const callId = event.data?.callId
        if (typeof callId === 'string') {
          const name = typeof event.data?.name === 'string' ? event.data.name : ''
          state.pending.set(callId, { name })
          if (state.mode === 'supervising' && name === HUMAN_QUESTION_TOOL) scheduleHumanWait(state)
        }
        return
      }
      if (type === 'tool/result') {
        const callId = event.data?.message?.toolCallId ?? event.data?.callId
        if (typeof callId === 'string') state.pending.delete(callId)
        if (pendingHumanQuestion(state) === undefined) clearHumanTimer(state)
        return
      }

      // 走到这里的只该是 turn/end：其他事件在上面各自 return 掉了，否则 assistant/message 会被当成一轮收尾。
      if (type !== 'turn/end') return
      state.pending.clear()
      clearHumanTimer(state)
      const ended = event.data?.reason
      if (state.selfStop) {
        state.selfStop = false
        return
      }
      if (ended?.kind === 'aborted' && ended.reason?.kind === 'user') {
        logWarn(ctx, 'the human stopped the turn; ending supervision')
        endSupervision(state)
        return
      }
      // 只有真正跑完的一轮才把出错退避清零；以错误结束的一轮保留计数（agent/error 先于此事件发出）。
      // 放在 assistant/message 上清零会让多步任务里“前几步成功、最后一步失败”的退避永远停在第一档。
      if (ended?.kind !== 'error') {
        state.errorStreak = 0
        state.nextRoundAt = 0
      }
    } catch (error) {
      logWarn(ctx, `session event handling failed: ${errorText(error)}`)
    }
  }

  /**
   * 等待期间：以下消息都会结束等待并继续下一轮——
   * 定时提醒、用户消息、teammate 消息，以及子 agent 返回结果。
   * 子 agent 有三种等待口径：点名一个（只认它）、join（等这批全部结束，默认）、
   * 没有子 agent 服务（退回“首个结束即唤醒”）。
   * teammate 本身没有“结束”通知，它发消息就是有新进展。
   */
  function onInboxInserted({ agent, message }) {
    const state = states.get(agent)
    if (!state || state.waiting === undefined) return
    const source = message?.source
    const kind = source?.kind
    if (kind === 'schedule') endWait(state, 'reminder')
    else if (kind === 'user') endWait(state, 'human')
    else if (kind === 'agent-message') endWait(state, 'teammate')
    else if (kind === 'subagent-settled') {
      const wanted = state.waiting.subagentId
      const joined = state.waiting.subagentIds
      if (wanted !== undefined) {
        if (wanted === source?.senderSessionId) endWait(state, 'subagent')
        return
      }
      const sender = source?.senderSessionId
      if (joined instanceof Set) {
        if (typeof sender === 'string') joined.delete(sender)
        if (joined.size === 0) endWait(state, 'subagents')
        return
      }
      endWait(state, 'subagent')
    }
  }

  /** 主动结束监督（人类强停，或到点但设置里不要求停止）：停掉计时器与等待订阅，不再驱动。 */
  function endSupervision(state, reason = 'manual') {
    if (states.get(state.agent) !== state) return
    try {
      // 只收拾自己动过的官方续轮：收尾流程停过它，等待期间也临时停过它。
      // released（到点继续）不能 disarm——那会把仍在驱动的 goal 一起停掉，任务反而停住。
      if (state.mode === 'finishing') stopDriver(state)
      else if (state.waitStoppedDriver === true) resumeDriver(state)
      logInfo(ctx, reason === 'released'
        ? 'supervision ended at the deadline; the task itself is not required to stop'
        : 'supervision ended because the human took over')
      const notice = endNotice(reason)
      if (!injectNotice(state.agent, notice)) injectNoticeLater(state.agent, notice)
    } finally {
      // 收尾这几天里任何一步出错都不能把监督卡在“监督中”：状态一定要清掉。
      teardownState(state)
    }
  }

  /** 按会话 id 强制结束监督；本进程已经没有这条监督时，顺手清掉日志里的陈旧公告。 */
  function forceEndSupervision(sessionId) {
    let ended = false
    for (const state of [...states.values()]) {
      if (state.agent.id !== sessionId) continue
      ended = true
      try {
        endSupervision(state, 'manual')
      } catch (error) {
        logWarn(ctx, `could not end supervision cleanly: ${errorText(error)}`)
        teardownState(state, { quiet: true })
      }
    }
    if (ended) return true
    const agent = ctx.agents.get(sessionId)
    if (agent !== undefined) reconcileStaleNotice(agent)
    return false
  }

  /** 这个会话是否正被本进程监督（按会话 id 判断，agent 对象可能被重建）。 */
  function isSupervising(sessionId) {
    for (const state of states.values()) {
      if (state.agent.id === sessionId) return true
    }
    return false
  }

  /** 是否存在一条仍在“监督中”的状态；收尾中的状态不算，用来判断旧公告是否已过时。 */
  function hasSupervisingState(sessionId) {
    for (const state of states.values()) {
      if (state.agent.id === sessionId && state.mode === 'supervising') return true
    }
    return false
  }

  /**
   * 日志里还留着“监督中”的公告、本进程却没有这条监督时，补一条结束公告。
   * 进程重启、会话重新打开或分叉、插件重载都会留下这种陈旧状态。
   */
  function reconcileStaleNotice(agent) {
    if (agent === undefined || isSupervising(agent.id)) return
    try {
      const projections = ctx.get('sessionProjections')
      const session = agent.session
      if (!projections || typeof projections.stateOf !== 'function' || session === undefined) return
      const state = projections.stateOf(session, PROJECTION_KEY)
      if (state === undefined || state.phase !== 'supervising') return
      logInfo(ctx, `clearing a stale supervision notice for ${agent.id}`)
      const notice = endNotice('stale')
      if (!injectNotice(agent, notice)) injectNoticeLater(agent, notice)
    } catch (error) {
      // 对账失败不能连累调用方：agent/created 里抛错会让会话创建失败。
      logWarn(ctx, `could not reconcile a stale supervision notice: ${errorText(error)}`)
    }
  }

  function onAgentCreated({ agent }) {
    reconcileStaleNotice(agent)
  }

  /** 界面读的监督状态由会话日志折叠而来；登记失败只影响状态条，不影响监督本身。 */
  function registerProjection(disposers) {
    const projections = ctx.get('sessionProjections')
    if (!projections || typeof projections.register !== 'function') {
      logWarn(ctx, `session projections are unavailable; the supervision status bar has no data`)
      return
    }
    try {
      disposers.push(projections.register(createProjection(cfg.duration)))
    } catch (error) {
      logWarn(ctx, `could not register the supervision projection: ${errorText(error)}`)
    }
  }

  /**
   * 恢复等待的读写接口：恢复条轮询 GET 显示倒计时，按钮 POST
   * `{sessionId, action: 'retry-now' | 'cancel'}` 立即重试或放弃。
   * `cancel` 也是状态条「结束」的兜底：命令那一路失败时客户端直接调它，没有等待中的恢复
   * 就当作强制结束监督；连监督也没有时，顺手把日志里的陈旧公告清掉。
   */
  function registerRecoveryRoute(scoped, webServer) {
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    const reply = (response, status, payload) => {
      const body = JSON.stringify(payload)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
    }
    const handle = async (request, response) => {
      const method = request.method ?? 'GET'
      if (method === 'GET') {
        reply(response, 200, { ok: true, value: { recoveries: listRecoveries() } })
        return
      }
      if (method !== 'POST') {
        response.writeHead(405, { allow: 'GET, POST' })
        response.end()
        return
      }
      if (!sameOrigin(request)) {
        reply(response, 403, { ok: false, error: 'untrusted origin' })
        return
      }
      let body
      try {
        body = JSON.parse(await readBody(request))
      } catch (error) {
        reply(response, 400, { ok: false, error: `invalid JSON body: ${errorText(error)}` })
        return
      }
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      const action = typeof body?.action === 'string' ? body.action : ''
      if (action !== 'retry-now' && action !== 'cancel') {
        reply(response, 400, { ok: false, error: `unknown action "${action}"` })
        return
      }
      if (action === 'cancel') {
        const control = sessionId === '' ? undefined : recoveryControlOf(sessionId)
        if (control !== undefined) control.cancel()
        else if (sessionId !== '') forceEndSupervision(sessionId)
        reply(response, 200, { ok: true, value: { recoveries: listRecoveries() } })
        return
      }
      const control = sessionId === '' ? undefined : recoveryControlOf(sessionId)
      if (control === undefined) {
        reply(response, 404, { ok: false, error: 'no pending recovery for this session' })
        return
      }
      control.retryNow()
      reply(response, 200, { ok: true, value: { recoveries: listRecoveries() } })
    }
    try {
      return webServer.register({ kind: 'exact', path: RECOVERY_ROUTE_PATH, handler: handle })
    } catch (error) {
      logWarn(ctx, `could not register the recovery endpoint: ${errorText(error)}`)
      return () => {}
    }
  }

  /**
   * 保持唤醒状态的只读接口：设置页显示当前后端、电源来源与降级原因。
   * 没有接 power 服务时（例如只挂 core 的测试）返回一个中性的空状态。
   */
  function registerPowerRoute(webServer) {
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    const handle = (_request, response) => {
      let value
      try {
        value = power?.diagnose?.() ?? { mode: 'off', holding: false, backend: 'none', reason: 'disabled' }
      } catch (error) {
        value = { mode: 'off', holding: false, backend: 'none', reason: 'failed', detail: errorText(error) }
      }
      const body = JSON.stringify({ ok: true, value })
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
    }
    try {
      return webServer.register({ kind: 'exact', path: POWER_ROUTE_PATH, handler: handle })
    } catch (error) {
      logWarn(ctx, `could not register the power endpoint: ${errorText(error)}`)
      return () => {}
    }
  }

  /**
   * dont_stop_wait 随插件常驻注册：监督中生效，其余时候返回 not-supervised。
   * 它不是设置项，注册一次就不再变化。
   */
  let disposeWaitTool

  function registerWaitTool() {
    if (disposeWaitTool !== undefined) return
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') {
      logWarn(ctx, `tool service is unavailable; ${WAIT_TOOL} was not registered`)
      return
    }
    try {
      disposeWaitTool = tools.register(waitToolDefinition())
    } catch (error) {
      logWarn(ctx, `could not register ${WAIT_TOOL}: ${errorText(error)}`)
    }
  }

  ctx.effect(() => {
    const disposers = []
    try {
      disposers.push(ctx.commands.register(command))
    } catch (error) {
      logWarn(ctx, `could not register /dont-stop: ${errorText(error)}`)
    }
    registerWaitTool()
    // “始终提问限时”关掉时，没监督那边挂着的等待立即撤掉。
    const unsubscribeQuestionLimit = settings.subscribe((value) => {
      if (value.questionLimitAlways === true) return
      for (const agent of [...questionWaits.keys()]) clearQuestionWait(agent)
    })
    registerProjection(disposers)
    // 设置页读写这些设置走这个接口；没有 webServer 的组成（比如纯 CLI）直接跳过。
    const releaseSettingsRoute = ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => registerSettingsRoute(scoped, scoped.webServer, settings))
    })
    // 恢复等待的读写接口：恢复条轮询 GET，按钮 POST 立即重试 / 放弃。
    const releaseRecoveryRoute = ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => registerRecoveryRoute(scoped, scoped.webServer))
    })
    // 保持唤醒状态的只读接口：设置页显示当前由谁在阻止系统睡眠。
    const releasePowerRoute = ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => registerPowerRoute(scoped.webServer))
    })
    // 系统从睡眠里恢复：重算监督的定时器，并给被打断的回合留一段免计失败的窗口。
    let releaseResume = () => {}
    try {
      releaseResume = power?.onResume?.(onSystemResume) ?? (() => {})
    } catch (error) {
      logWarn(ctx, `could not subscribe to system resume events: ${errorText(error)}`)
    }
    // retry 的两个动作入口：恢复到点替它打下一轮；放弃重试时连监督一起结束。
    const releaseResumeHook = setResumeRoundHook((sessionId) => {
      for (const state of states.values()) {
        if (state.agent.id !== sessionId || state.mode !== 'supervising') continue
        // 等待已经结束：把错误退避清掉，直接排一轮。
        state.nextRoundAt = 0
        injectRound(state)
        return true
      }
      return false
    })
    const releaseStopHook = setStopSupervisionHook((sessionId) => {
      for (const state of states.values()) {
        if (state.agent.id !== sessionId) continue
        endSupervision(state, 'manual')
        return true
      }
      return false
    })
    const agentsService = ctx.get('agents')
    if (agentsService && typeof agentsService.list === 'function') {
      for (const agent of agentsService.list()) reconcileStaleNotice(agent)
    }
    disposers.push(ctx.on('agent/created', onAgentCreated))
    disposers.push(ctx.on('agent/status', onStatus))
    disposers.push(ctx.on('agent/disposed', onDisposed))
    disposers.push(ctx.on('agent/error', onAgentError))
    disposers.push(ctx.on('session/event', onSessionEvent))
    disposers.push(ctx.on('agent/inbox/inserted', onInboxInserted))

    return () => {
      unsubscribeQuestionLimit()
      if (disposeWaitTool !== undefined) {
        try {
          disposeWaitTool()
        } catch (error) {
          logWarn(ctx, `could not unregister ${WAIT_TOOL}: ${errorText(error)}`)
        }
        disposeWaitTool = undefined
      }
      releaseSettingsRoute()
      releaseRecoveryRoute()
      releasePowerRoute()
      releaseResume()
      releaseResumeHook()
      releaseStopHook()
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          logWarn(ctx, `dispose failed: ${errorText(error)}`)
        }
      }
      for (const state of [...states.values()]) {
        clearDeadlineTimer(state)
        clearHardTimer(state)
        clearHumanTimer(state)
        clearRoundTimer(state)
        clearWait(state)
        // 只把自己停过的驱动收拾干净：重载插件时不该 disarm 一条我们从没碰过的 active goal。
        if (state.mode === 'finishing') stopDriver(state)
        else if (state.waitStoppedDriver === true) resumeDriver(state)
        states.delete(state.agent)
        dropSupervision(state.agent.id)
        powerRelease(state.agent.id)
      }
      for (const agent of [...questionWaits.keys()]) clearQuestionWait(agent)
    }
  }, 'dont-stop-core lifecycle')
}
