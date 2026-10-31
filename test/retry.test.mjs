import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../retry/index.js'
import {
  clearAllRecoveries,
  dropSupervision,
  recoveryControlOf,
  recoveryStatusOf,
  setResumeRoundHook,
  setStopSupervisionHook,
  setSupervision,
} from '../shared/state.js'
import { makeFakeAgent, makeFakeContext, makeFakeGoals, tick } from './fake-ctx.mjs'

/** 独立的设置存储替身：值可变，测试里改完下一次事件就能读到。 */
function settingsStub(initial = {}) {
  let value = { errorRecovery: true, minRoundIntervalMs: 0, ...initial }
  const listeners = new Set()
  return {
    get: () => value,
    set(patch) {
      value = { ...value, ...patch }
      for (const listener of [...listeners]) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function setup(options = {}) {
  const agent = makeFakeAgent(options.id ?? 'retry-session')
  const goals = options.goals ?? makeFakeGoals()
  const ctx = makeFakeContext({ agents: [agent], goals })
  apply(ctx, options.config ?? {}, { settings: options.settings ?? settingsStub() })
  return { agent, goals, ctx }
}

/** 一个可重试的回合级错误（网络抖动），会让恢复按 delaysMs 排期。 */
const fail = (agent, error = new Error('read ECONNRESET')) => ({ agent, error, turn: 1, step: 1 })

test('a retryable turn error schedules a recovery and publishes it for the bar', async () => {
  const { agent, ctx } = setup({ id: 'retry-schedule', config: { turnRecovery: { delaysMs: [20] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    const status = recoveryStatusOf(agent.id)
    assert.ok(status, 'the bar must know a retry is pending')
    assert.equal(status.cls, 'transient')
    assert.equal(status.attempt, 1)
    assert.equal(status.maxAttempts, 5)
    assert.ok(status.resumeAt > Date.now(), 'the bar counts down')
    assert.equal(typeof recoveryControlOf(agent.id)?.retryNow, 'function')
    assert.equal(typeof recoveryControlOf(agent.id)?.cancel, 'function')
    assert.equal(agent.calls.followup.length, 0, 'nothing is injected before the wait ends')
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('the wait ends by queueing a recovery message through the official queue', async () => {
  const { agent, ctx } = setup({ id: 'retry-fire', config: { turnRecovery: { delaysMs: [5] } } })
  ctx.listeners.get('agent/error')[0](fail(agent))
  await tick(40)
  assert.equal(agent.calls.followup.length, 1)
  const text = String(agent.calls.followup[0].content[0].text)
  assert.match(text, /dont_stop_recovery/)
  assert.match(text, /系统自动发送/)
  assert.equal(recoveryStatusOf(agent.id), undefined, 'the bar closes once the retry starts')
  ctx.dispose()
})

test('a successful answer clears the pending recovery', async () => {
  const { agent, ctx } = setup({ id: 'retry-cleared', config: { turnRecovery: { delaysMs: [500] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.ok(recoveryStatusOf(agent.id))
    ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'assistant/message' })
    assert.equal(recoveryStatusOf(agent.id), undefined)
    assert.equal(recoveryControlOf(agent.id), undefined)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('an error turn/end keeps the recovery that agent/error just scheduled', async () => {
  const { agent, ctx } = setup({ id: 'retry-error-end', config: { turnRecovery: { delaysMs: [20] } } })
  try {
    // 真实顺序：agent/error 先发，turn/end（reason.kind = error）紧随其后。
    const error = Object.assign(new Error('Connection error.'), { code: 'TRANSPORT' })
    ctx.listeners.get('agent/error')[0](fail(agent, error))
    ctx.listeners.get('session/event')[0](
      { id: agent.id },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } } } },
    )
    assert.ok(recoveryStatusOf(agent.id), 'the bar must keep the pending retry')
    await tick(40)
    assert.equal(agent.calls.followup.length, 1, 'the retry still fires after the error turn ended')
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('a human abort clears the pending recovery', async () => {
  const { agent, ctx } = setup({ id: 'retry-aborted', config: { turnRecovery: { delaysMs: [20] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    ctx.listeners.get('session/event')[0](
      { id: agent.id },
      { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    )
    await tick(40)
    assert.equal(recoveryStatusOf(agent.id), undefined)
    assert.equal(agent.calls.followup.length, 0)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('a new turn cancels the wait, so a queued user message wins', async () => {
  const { agent, ctx } = setup({ id: 'retry-turn-start', config: { turnRecovery: { delaysMs: [20] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'turn/start' })
    await tick(40)
    assert.equal(agent.calls.followup.length, 0, 'the user turn keeps the driver, the plugin stays quiet')
    assert.equal(recoveryStatusOf(agent.id), undefined)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('a new turn keeps the failure streak, so the delay escalates', async () => {
  const { agent, ctx } = setup({ id: 'retry-streak', config: { turnRecovery: { delaysMs: [500, 1000, 2000] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.equal(recoveryStatusOf(agent.id).attempt, 1)
    assert.equal(recoveryStatusOf(agent.id).waitMs, 500)
    // 重试本身就是新的一轮：turn/start 只能取消等待，不能把连续失败计数清掉。
    ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'turn/start' })
    assert.equal(recoveryStatusOf(agent.id), undefined, 'the bar closes when the retry starts')
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.equal(recoveryStatusOf(agent.id).attempt, 2)
    assert.equal(recoveryStatusOf(agent.id).waitMs, 1000)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('a failed turn keeps the streak, a completed turn resets it', async () => {
  const { agent, ctx } = setup({ id: 'retry-streak-reset', config: { turnRecovery: { delaysMs: [500, 1000] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'turn/start' })
    // 多步任务里前面的 step 成功过，不代表这一轮没失败：计数不能被中途清零。
    ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'assistant/message' })
    ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.equal(recoveryStatusOf(agent.id).attempt, 2, 'a failed turn keeps the ladder')
    assert.equal(recoveryStatusOf(agent.id).waitMs, 1000)
    // 只有真正跑完的一轮才把阶梯归零。
    ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.equal(recoveryStatusOf(agent.id).attempt, 1, 'a completed turn starts the ladder over')
    assert.equal(recoveryStatusOf(agent.id).waitMs, 500)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('failures with successful steps in between still hit the stop-loss', async () => {
  const goals = makeFakeGoals()
  const { agent, ctx } = setup({
    id: 'retry-stoploss',
    goals,
    config: { turnRecovery: { delaysMs: [10], maxConsecutiveSameClass: 2 } },
  })
  goals.create(agent, { objective: 'previous work' })
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ctx.listeners.get('agent/error')[0](fail(agent))
      ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'turn/start' })
      ctx.listeners.get('session/event')[0]({ id: agent.id }, { type: 'assistant/message' })
    }
    assert.ok(goals.calls.some((entry) => entry[0] === 'block'), 'the stop-loss must fire once the cap is reached')
    assert.equal(goals.goal.phase, 'blocked')
    assert.equal(recoveryStatusOf(agent.id), undefined, 'the stop-loss drops the pending wait')
    await tick(50)
    assert.equal(agent.calls.followup.length, 0, 'no recovery turn is queued after the cap')
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('retry now runs the recovery without waiting for the timer', async () => {
  const { agent, ctx } = setup({ id: 'retry-now', config: { turnRecovery: { delaysMs: [600000] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    recoveryControlOf(agent.id).retryNow()
    assert.equal(agent.calls.followup.length, 1, 'the recovery turn is queued immediately')
    assert.equal(recoveryStatusOf(agent.id), undefined)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('cancelling a recovery also stops supervision, but not the other way round', async () => {
  const { agent, ctx } = setup({ id: 'retry-cancel', config: { turnRecovery: { delaysMs: [600000] } } })
  const stopped = []
  const releaseStop = setStopSupervisionHook((sessionId) => {
    stopped.push(sessionId)
    return true
  })
  try {
    setSupervision(agent.id, { agent, deadlineAt: Date.now() + 3600000, mode: 'supervising' })
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.equal(recoveryStatusOf(agent.id)?.supervised, true)
    recoveryControlOf(agent.id).cancel()
    assert.deepEqual(stopped, [agent.id], 'cancelling the retry closes supervision too')
    assert.equal(recoveryStatusOf(agent.id), undefined)

    // 反过来：结束监督不带走等待中的恢复。
    ctx.listeners.get('agent/error')[0](fail(agent))
    dropSupervision(agent.id)
    assert.ok(recoveryStatusOf(agent.id), 'the pending retry survives the end of supervision')
    recoveryControlOf(agent.id).cancel()
    assert.deepEqual(stopped, [agent.id], 'no supervision left to stop')
  } finally {
    releaseStop()
    dropSupervision(agent.id)
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('a supervised recovery hands the next round to core instead of injecting text', async () => {
  const { agent, ctx } = setup({ id: 'retry-supervised', config: { turnRecovery: { delaysMs: [5] } } })
  const rounds = []
  const releaseRound = setResumeRoundHook((sessionId) => {
    rounds.push(sessionId)
    return true
  })
  try {
    setSupervision(agent.id, { agent, deadlineAt: Date.now() + 3600000, mode: 'supervising' })
    ctx.listeners.get('agent/error')[0](fail(agent))
    await tick(40)
    assert.deepEqual(rounds, [agent.id], 'core is asked for the next round')
    assert.equal(agent.calls.followup.length, 0, 'the plugin does not inject its own message while supervised')
  } finally {
    releaseRound()
    dropSupervision(agent.id)
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('the stop-loss still blocks the goal after too many consecutive failures', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('retry-stop')
  goals.create(agent, { objective: 'work' })
  goals.disarm(agent)
  const ctx = makeFakeContext({ agents: [agent], goals })
  apply(ctx, { turnRecovery: { delaysMs: [1], maxConsecutiveSameClass: 1 } }, { settings: settingsStub() })
  try {
    const onError = ctx.listeners.get('agent/error')[0]
    onError(fail(agent))
    await tick(10)
    onError(fail(agent))
    const blocked = goals.calls.find((entry) => entry[0] === 'block')
    assert.ok(blocked, 'goal must be blocked after the stop-loss threshold')
    assert.equal(blocked[1].code, 'recovery-exhausted')
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('the recovery switch turns scheduling off and cancels what is pending', async () => {
  const settings = settingsStub({ errorRecovery: false })
  const { agent, ctx } = setup({ id: 'retry-switch', settings, config: { turnRecovery: { delaysMs: [10] } } })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.equal(recoveryStatusOf(agent.id), undefined, 'no recovery while the switch is off')

    settings.set({ errorRecovery: true })
    ctx.listeners.get('agent/error')[0](fail(agent))
    assert.ok(recoveryStatusOf(agent.id))
    settings.set({ errorRecovery: false })
    assert.equal(recoveryStatusOf(agent.id), undefined, 'turning it off cancels the wait')
    await tick(30)
    assert.equal(agent.calls.followup.length, 0)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('auth failures, deliberate stops and subagents are not recovered', async () => {
  const { agent, ctx } = setup({ id: 'retry-skip', config: { turnRecovery: { delaysMs: [1] } } })
  try {
    const onError = ctx.listeners.get('agent/error')[0]
    onError({ agent, error: Object.assign(new Error('unauthorized'), { code: 'AUTH' }), turn: 1, step: 1 })
    onError({ agent, error: Object.assign(new Error('Request aborted'), { code: 'ABORTED' }), turn: 1, step: 1 })
    assert.equal(recoveryStatusOf(agent.id), undefined)
    await tick(20)
    assert.equal(agent.calls.followup.length, 0)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('a goal session is re-armed instead of pushed with an extra turn', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('retry-goal')
  goals.create(agent, { objective: 'work' })
  goals.disarm(agent)
  const ctx = makeFakeContext({ agents: [agent], goals })
  apply(ctx, { turnRecovery: { delaysMs: [1] } }, { settings: settingsStub() })
  try {
    ctx.listeners.get('agent/error')[0](fail(agent))
    await tick(20)
    assert.ok(goals.calls.some((entry) => entry[0] === 'resume'), 'the official driver takes the work back')
    assert.equal(agent.calls.followup.length, 0)
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})
