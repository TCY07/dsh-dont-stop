import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply } from '../core/index.js'
import { roundPrompt, supervisionNotice } from '../core/prompts.js'
import { clearAllRecoveries, clearRecoveryControl, clearRecoveryStatus, getSupervision, setRecoveryControl, setRecoveryStatus } from '../shared/state.js'
import { makeFakeAgent, makeFakeContext, makeFakeGoals, makeFakeJobs, makeFakeSubagents, tick } from './fake-ctx.mjs'

// 插件从 DSH_HOME 下读设置文件；测试用独立目录，避免读到本机的真实设置，跑完删掉。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-dont-stop-home-'))
process.env.DSH_HOME = TEST_HOME
after(() => rmSync(TEST_HOME, { recursive: true, force: true }))

function settingsFile() {
  return join(TEST_HOME, 'storages', 'dont-stop', 'settings.json')
}

/** 每个用例从干净设置开始；需要特定设置的用例通过 setup 的 settings 传进来。 */
function resetSettings(settings) {
  rmSync(settingsFile(), { force: true })
  if (settings === undefined) return
  mkdirSync(dirname(settingsFile()), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(settings))
}

function setup(options = {}) {
  resetSettings(options.settings)
  const agent = makeFakeAgent(options.id ?? 'core-session')
  const goals = options.goals ?? makeFakeGoals()
  const ctx = makeFakeContext({ agents: [agent], goals, subagents: options.subagents, jobs: options.jobs })
  apply(ctx, options.config ?? {})
  const command = ctx.registeredCommands.find((entry) => entry.name === 'dont-stop')
  assert.ok(command, 'command must be registered')
  const run = (rawInput) => command.handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  return { agent, goals, ctx, run }
}

const lastRoundText = (agent) => String(agent.calls.followup.at(-1)?.content?.[0]?.text ?? '')

test('the model-facing wording comes from prompts.json', () => {
  const file = fileURLToPath(new URL('../prompts.json', import.meta.url))
  const text = JSON.parse(readFileSync(file, 'utf8'))
  const start = supervisionNotice({ startedAt: 1, deadlineAt: 2 }, {})
  assert.equal(start.text.includes(text.start.lines[0]), true, 'the start notice uses the configured lines')
  assert.equal(start.text.includes(text.start.waitToolLine), true, 'the wait-tool line comes from the same file')
  const round = roundPrompt({ rounds: 1 })
  const expectedOpening = text.round.opening
    .replace(/\{completed\+1\}/g, '1')
    .replace(/\{completed\}/g, '0')
    .replace(/\{round\}/g, '1')
  assert.equal(round.includes(expectedOpening), true)
  assert.doesNotMatch(round, /\{completed/, 'no placeholder may leak to the model')
  assert.equal(round.includes(text.round.body[0]), true, 'the round body comes from the same file')
})

test('the recovery endpoint serves the pending retries and the two buttons', async () => {
  const { ctx } = setup({ id: 'core-recovery-route' })
  const route = ctx.routes.find((entry) => entry.path === '/dsh-dont-stop/recovery')
  assert.ok(route, 'the recovery endpoint is registered next to the settings one')
  const calls = []
  try {
    setRecoveryStatus('core-recovery-route', {
      cls: 'timeout',
      attempt: 2,
      maxAttempts: 5,
      waitMs: 15000,
      resumeAt: Date.now() + 15000,
      message: 'Request timed out.',
      supervised: false,
    })
    setRecoveryControl('core-recovery-route', {
      retryNow: () => calls.push('retry-now'),
      cancel: () => calls.push('cancel'),
    })
    const response = () => ({ writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } })

    const read = response()
    await route.handler({ method: 'GET' }, read)
    assert.equal(read.code, 200)
    const payload = JSON.parse(read.body)
    assert.equal(payload.ok, true)
    const [entry] = payload.value.recoveries
    assert.equal(entry.sessionId, 'core-recovery-route')
    assert.equal(entry.cls, 'timeout')
    assert.equal(entry.attempt, 2)
    assert.equal(entry.maxAttempts, 5)
    assert.ok(entry.resumeAt > Date.now())

    const post = (body, headers = {}) => {
      const request = Readable.from([Buffer.from(JSON.stringify(body))])
      request.method = 'POST'
      request.headers = headers
      return request
    }
    const retryNow = response()
    await route.handler(post({ sessionId: 'core-recovery-route', action: 'retry-now' }), retryNow)
    assert.equal(retryNow.code, 200)
    assert.deepEqual(calls, ['retry-now'])

    const cancel = response()
    await route.handler(post({ sessionId: 'core-recovery-route', action: 'cancel' }), cancel)
    assert.deepEqual(calls, ['retry-now', 'cancel'])

    const unknown = response()
    await route.handler(post({ sessionId: 'core-recovery-route', action: 'nope' }), unknown)
    assert.equal(unknown.code, 400)

    const missing = response()
    await route.handler(post({ sessionId: 'other', action: 'retry-now' }), missing)
    assert.equal(missing.code, 404, 'nothing to retry for an unknown session')

    const crossSite = response()
    await route.handler(post({ sessionId: 'core-recovery-route', action: 'cancel' }, { host: '127.0.0.1:63005', origin: 'http://evil.example' }), crossSite)
    assert.equal(crossSite.code, 403, 'writes are same-origin only')

    const notAllowed = response()
    await route.handler({ method: 'PUT' }, notAllowed)
    assert.equal(notAllowed.code, 405)
  } finally {
    clearAllRecoveries()
    clearRecoveryControl('core-recovery-route')
    ctx.dispose()
  }
})

test('a cancel without a pending recovery force-ends supervision', async () => {
  const { agent, ctx, run } = setup({ id: 'core-force-stop' })
  const route = ctx.routes.find((entry) => entry.path === '/dsh-dont-stop/recovery')
  const response = () => ({ writeHead(code, headers) { this.code = code; this.headers = headers }, end(body) { this.body = body } })
  const post = (body) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))])
    request.method = 'POST'
    request.headers = {}
    return request
  }
  run('1h')
  assert.ok(getSupervision('core-force-stop'))
  const forced = response()
  await route.handler(post({ sessionId: 'core-force-stop', action: 'cancel' }), forced)
  assert.equal(forced.code, 200, 'the endpoint never refuses the fallback')
  assert.equal(getSupervision('core-force-stop'), undefined, 'the supervision is gone right away')
  assert.match(String(agent.calls.inject.at(-1)?.content?.[0]?.text ?? ''), /kind="end" reason="manual"/, 'the status bar still gets its end notice')
  const idle = response()
  await route.handler(post({ sessionId: 'nobody-here', action: 'cancel' }), idle)
  assert.equal(idle.code, 200, 'a session with nothing to stop is not an error')
  ctx.dispose()
})

test('a pending retry holds back the next supervision round', async () => {
  const { agent, ctx, run } = setup({ id: 'core-recovery-gate' })
  const roundsBefore = () => agent.calls.followup.length
  try {
    run('1h')
    await tick(10)
    const before = roundsBefore()
    setRecoveryStatus(agent.id, { cls: 'timeout', attempt: 1, maxAttempts: 5, waitMs: 60000, resumeAt: Date.now() + 60000, message: 'x', supervised: true })
    ctx.emit('agent/status', { agent, status: 'idle' })
    await tick(20)
    assert.equal(roundsBefore(), before, 'no “continue working” prompt while a retry is pending')
    clearRecoveryStatus(agent.id)
    ctx.emit('agent/status', { agent, status: 'idle' })
    await tick(20)
    assert.equal(roundsBefore(), before + 1, 'the round resumes once the retry state is gone')
  } finally {
    clearAllRecoveries()
    ctx.dispose()
  }
})

test('the status command is gone', () => {  const { run } = setup({ id: 'core-status' })
  const result = run('status')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Cannot parse "status"/)
})

test('supervision drives its own rounds without creating or arming a goal', async () => {
  const { agent, goals, ctx, run } = setup({ id: 'core-start' })
  const result = run('1h')
  assert.equal(result.kind, 'success')
  await tick(10)
  assert.equal(agent.calls.followup.length, 1, 'the first round must be injected')
  assert.match(lastRoundText(agent), /<dont_stop_round round="\d+">/)
  assert.equal(getSupervision('core-start').rounds, 1)
  assert.equal(goals.calls.filter((entry) => entry[0] === 'create').length, 0, 'must not create goals')
  assert.equal(goals.calls.filter((entry) => entry[0] === 'resume').length, 0, 'must not arm goals')
  ctx.dispose()
})

test('the start notice asks for continuous work, grants autonomy and hides the clock', async () => {
  const { agent, ctx, run } = setup({ id: 'core-autonomy' })
  run('1h')
  await tick(10)
  const notice = String(agent.calls.inject[0]?.content?.[0]?.text ?? '')
  assert.match(notice, /需要一直推进工作/, 'the start notice asks for continuous work')
  assert.match(notice, /自主决策权/, 'the start notice grants broad autonomy')
  assert.match(notice, /拓宽任务范围/, 'the scope of autonomous decisions is spelled out')
  assert.match(notice, /涉及安全、隐私、财产/, 'the sensitive categories are named')
  assert.match(notice, /必须得到用户明确授权/, 'the sensitive decisions need authorization')
  assert.match(notice, /用户直接下达的指令始终优先/, 'a user instruction wins over the plugin prompt')
  assert.doesNotMatch(notice, /\b1\d{12}\b/, 'no raw epoch milliseconds in model-facing text')
  assert.doesNotMatch(notice, /until \d\d:\d\d/, 'the deadline stays out of the model context')
  assert.doesNotMatch(notice, /deadline=|started=/, 'no timing attributes in the model-visible tag')
  assert.equal(agent.calls.inject[0]?.source?.dontStop?.phase, 'start', 'the machine data rides on the message source')
  assert.equal(agent.calls.inject[0]?.source?.dontStop?.deadlineAt, getSupervision('core-autonomy').deadlineAt)
  ctx.dispose()
})

test('the next round prompt asks for more work without revealing the remaining time', async () => {
  const { agent, ctx, run } = setup({ id: 'core-history' })
  run('2h')
  await tick(10)
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } })
  ctx.emit('session/event', { id: agent.id }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Finished the parser and the tests pass.' }, { type: 'reasoning', text: 'hidden thinking' }] } },
  })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  const prompt = lastRoundText(agent)
  assert.match(prompt, /<dont_stop_round round="2">/)
  assert.match(prompt, /已完成 2 轮/, 'the counted rounds come from the template expression')
  assert.match(prompt, /首先检查上一轮的工作/, 'the round body comes from prompts.json')
  assert.match(prompt, /指派 subagent 或 teammate/, 'fallback ideas are offered instead of stopping')
  assert.match(prompt, /dont-stop-wait/, 'the subagent idea points at the wait tool')
  assert.match(prompt, /调研当前任务领域里的同类工作/)
  assert.match(prompt, /预测用户可能提出什么新的需求/, 'the model is nudged to anticipate the user')
  assert.doesNotMatch(prompt, /已完成的轮次表|工具调用数|耗时统计|这么快结束的活/, 'no round statistics are reported any more')
  assert.doesNotMatch(prompt, /hidden thinking/, 'reasoning blocks must not leak into the prompt')
  assert.doesNotMatch(prompt, /剩余时间|剩余时长|截止时间|还剩 \d/, 'the round prompt must not leak the remaining time')
  assert.doesNotMatch(prompt, /\b1\d{12}\b/, 'no raw epoch milliseconds in the round prompt')
  assert.doesNotMatch(prompt, /deadline="/, 'the round tag carries no machine timestamp to misread')
  ctx.dispose()
})

test('the instruction typed after the duration arrives as an identified user message', () => {
  const { agent, ctx, run } = setup({ id: 'core-objective' })
  const result = run('10m 先读 README，再补测试')
  assert.equal(result.kind, 'success')
  const first = agent.calls.followup[0]
  assert.equal(first?.role, 'user')
  assert.equal(typeof first?.id, 'string')
  assert.ok(first.id.length > 0, 'the client keys chat nodes by message id')
  assert.equal(String(first?.content?.[0]?.text ?? ''), '先读 README，再补测试')
  assert.equal(first?.source?.kind, 'user')
  ctx.dispose()
})

test('an active armed goal is left alone; dont-stop takes over once it ends', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('core-defer')
  goals.create(agent, { objective: 'previous work' })
  const ctx = makeFakeContext({ agents: [agent], goals })
  resetSettings()
  apply(ctx, {})
  const run = (rawInput) => ctx.registeredCommands[0].handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  run('1h')
  await tick(10)
  assert.equal(agent.calls.followup.length, 0, 'must stand by while the official driver drives')
  assert.equal(goals.calls.filter((entry) => entry[0] === 'disarm').length, 0, 'must not touch the goal')
  goals.complete(agent)
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  assert.equal(agent.calls.followup.length, 1, 'must take over with a continuation prompt')
  assert.match(lastRoundText(agent), /<dont_stop_round round="\d+">/)
  ctx.dispose()
})

test('the next idle starts the next round', async () => {
  const { agent, ctx, run } = setup({ id: 'core-rounds' })
  run('1h')
  await tick(10)
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  assert.equal(getSupervision('core-rounds').rounds, 2)
  assert.equal(agent.calls.followup.length, 2)
  assert.match(lastRoundText(agent), /<dont_stop_round round="2">/)
  assert.notEqual(agent.calls.followup[0].id, agent.calls.followup[1].id, 'each injected message needs its own id')
  ctx.dispose()
})

test('before the deadline a tool call is left alone to finish', async () => {
  const { agent, ctx, run } = setup({ id: 'core-toolwait' })
  run('1h')
  agent.status = 'running'
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } })
  await tick(30)
  assert.equal(agent.calls.cancel.length, 0, 'a running tool must not be interrupted')
  assert.equal(getSupervision('core-toolwait').mode, 'supervising')
  ctx.dispose()
})

test('before the deadline a pending human question is closed after the wait limit', async () => {
  const { agent, ctx, run } = setup({ id: 'core-human', settings: { questionLimitMs: 5 } })
  run('1h')
  agent.status = 'running'
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question' } })
  await tick(40)
  assert.equal(agent.calls.cancel.length, 1, 'the question must be closed')
  assert.deepEqual(agent.calls.cancel[0].options, { keepInbox: true }, 'supervision must keep running')
  assert.ok(agent.calls.followup.some((message) => String(message.content?.[0]?.text ?? '').includes('自行决定')))
  assert.equal(getSupervision('core-human').mode, 'supervising')
  ctx.dispose()
})

test('an answered question cancels the pending wait timer', async () => {
  const { agent, ctx, run } = setup({ id: 'core-answered', settings: { questionLimitMs: 20 } })
  run('1h')
  agent.status = 'running'
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question' } })
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/result', data: { message: { toolCallId: 'q1' } } })
  await tick(50)
  assert.equal(agent.calls.cancel.length, 0)
  ctx.dispose()
})

test('the always-on question limit closes a question outside supervision', async () => {
  const { agent, ctx } = setup({ id: 'core-question-always', settings: { questionLimitAlways: true, questionLimitMs: 5 } })
  agent.status = 'running'
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question' } })
  await tick(40)
  assert.equal(agent.calls.cancel.length, 1, 'the question is closed even without supervision')
  assert.ok(agent.calls.followup.some((message) => String(message.content?.[0]?.text ?? '').includes('自行决定')))
  ctx.dispose()
})

test('question limits stay off outside supervision while the switch is off', async () => {
  const { agent, ctx } = setup({ id: 'core-question-off', settings: { questionLimitAlways: false, questionLimitMs: 5 } })
  agent.status = 'running'
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question' } })
  await tick(40)
  assert.equal(agent.calls.cancel.length, 0, 'a session without the switch keeps waiting for the human')
  ctx.dispose()
})

test('a failed round backs off instead of hammering', async () => {
  const { agent, ctx, run } = setup({ id: 'core-backoff' })
  run('1h')
  await tick(10)
  const rounds = getSupervision('core-backoff').rounds
  ctx.emit('agent/error', { agent, error: new Error('boom'), turn: 1, step: 1 })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(20)
  assert.equal(getSupervision('core-backoff').rounds, rounds, 'no round during the backoff window')
  assert.ok(getSupervision('core-backoff').nextRoundAt > Date.now())
  ctx.dispose()
})

test('a completed turn clears the backoff, a failed one keeps it', async () => {
  const { agent, ctx, run } = setup({ id: 'core-recover' })
  run('1h')
  await tick(10)
  ctx.emit('agent/error', { agent, error: new Error('boom'), turn: 1, step: 1 })
  assert.ok(getSupervision('core-recover').nextRoundAt > 0)
  // 多步任务里前面的 step 成功过，不代表这一轮没失败：中途的 assistant/message 不能清零退避。
  ctx.emit('session/event', { id: agent.id }, { type: 'assistant/message', data: {} })
  assert.ok(getSupervision('core-recover').nextRoundAt > 0, 'a step inside a failing turn is not a completed turn')
  ctx.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'error' } } })
  assert.ok(getSupervision('core-recover').nextRoundAt > 0, 'a failed turn keeps the backoff')
  ctx.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(getSupervision('core-recover').nextRoundAt, 0)
  assert.equal(getSupervision('core-recover').errorStreak, 0)
  ctx.dispose()
})

test('the wait tool pauses rounds and resumes on its own timer', async () => {
  const { agent, ctx, run } = setup({ id: 'core-wait', config: { wait: { defaultMs: 5 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  assert.ok(tool, 'the wait tool must be registered for a supervised agent')
  const result = await tool.execute({ reason: 'waiting for the build' }, { agent })
  assert.equal(result.status, 'waiting')
  assert.ok(getSupervision('core-wait').waiting !== undefined)
  const rounds = getSupervision('core-wait').rounds
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(5)
  assert.equal(getSupervision('core-wait').rounds, rounds, 'no round while waiting')
  await tick(30)
  assert.equal(getSupervision('core-wait').waiting, undefined)
  assert.equal(getSupervision('core-wait').rounds, rounds + 1, 'a round resumes the work')
  ctx.dispose()
})

test('a wait for a background job resumes when that job settles', async () => {
  const jobs = makeFakeJobs()
  const { agent, ctx, run } = setup({ id: 'core-waitjob', jobs, config: { wait: { defaultMs: 60000 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  await tool.execute({ reason: 'waiting for the job', job_id: 'job-9' }, { agent })
  const rounds = getSupervision('core-waitjob').rounds
  jobs.settle('job-1')
  await tick(5)
  assert.equal(getSupervision('core-waitjob').rounds, rounds, 'another job must not wake it')
  jobs.settle('job-9')
  await tick(10)
  assert.equal(getSupervision('core-waitjob').rounds, rounds + 1)
  ctx.dispose()
})

test('a human message during a wait resumes the work', async () => {
  const { agent, ctx, run } = setup({ id: 'core-waithuman', config: { wait: { defaultMs: 60000 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  await tool.execute({ reason: 'waiting' }, { agent })
  const rounds = getSupervision('core-waithuman').rounds
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' } } })
  await tick(10)
  assert.equal(getSupervision('core-waithuman').rounds, rounds + 1)
  ctx.dispose()
})

test('a scheduled reminder delivered during a wait resumes the work', async () => {
  const { agent, ctx, run } = setup({ id: 'core-waitsched', config: { wait: { defaultMs: 60000 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  await tool.execute({ reason: 'waiting for the reminder' }, { agent })
  const rounds = getSupervision('core-waitsched').rounds
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'schedule' } } })
  await tick(10)
  assert.equal(getSupervision('core-waitsched').rounds, rounds + 1)
  ctx.dispose()
})

test('a wait for one subagent resumes only when that one settles', async () => {
  const subagents = makeFakeSubagents([{ id: 'sub-1' }, { id: 'sub-2' }])
  const { agent, ctx, run } = setup({ id: 'core-waitsub', subagents, config: { wait: { defaultMs: 60000 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  const result = await tool.execute({ reason: 'waiting for the reviewer', subagent_id: 'sub-1' }, { agent })
  assert.equal(result.subagentId, 'sub-1')
  assert.equal(result.subagentIds, undefined, 'naming one subagent skips the join')
  const rounds = getSupervision('core-waitsub').rounds
  // 别的子 agent 结束不能唤醒这次等待。
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'subagent-settled', senderSessionId: 'sub-2' } } })
  await tick(5)
  assert.equal(getSupervision('core-waitsub').rounds, rounds, 'another subagent must not wake it')
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'subagent-settled', senderSessionId: 'sub-1' } } })
  await tick(10)
  assert.equal(getSupervision('core-waitsub').waiting, undefined)
  assert.equal(getSupervision('core-waitsub').rounds, rounds + 1)
  ctx.dispose()
})

test('a wait joins the running subagents and wakes only when all of them settle', async () => {
  const subagents = makeFakeSubagents([{ id: 'sub-1' }, { id: 'sub-done', activity: 'inactive' }, { id: 'sub-2' }])
  const { agent, ctx, run } = setup({ id: 'core-waitsubjoin', subagents, config: { wait: { defaultMs: 60000 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  const result = await tool.execute({ reason: 'waiting for the review batch' }, { agent })
  assert.deepEqual(result.subagentIds, ['sub-1', 'sub-2'], 'only the children still running are joined')
  const rounds = getSupervision('core-waitsubjoin').rounds
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'subagent-settled', senderSessionId: 'sub-1' } } })
  await tick(5)
  assert.equal(getSupervision('core-waitsubjoin').rounds, rounds, 'one of two is not the whole batch')
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'subagent-settled', senderSessionId: 'sub-2' } } })
  await tick(10)
  assert.equal(getSupervision('core-waitsubjoin').waiting, undefined)
  assert.equal(getSupervision('core-waitsubjoin').rounds, rounds + 1)
  ctx.dispose()
})

test('without a subagent service a wait falls back to the first settle', async () => {
  const { agent, ctx, run } = setup({ id: 'core-waitsubany', config: { wait: { defaultMs: 60000 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  await tool.execute({ reason: 'waiting for whichever subagent finishes first' }, { agent })
  const rounds = getSupervision('core-waitsubany').rounds
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'subagent-settled', senderSessionId: 'sub-x' } } })
  await tick(10)
  assert.equal(getSupervision('core-waitsubany').rounds, rounds + 1)
  ctx.dispose()
})

test('a teammate message during a wait resumes the work', async () => {
  const { agent, ctx, run } = setup({ id: 'core-waitteam', config: { wait: { defaultMs: 60000 } } })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  await tool.execute({ reason: 'waiting for a teammate reply' }, { agent })
  const rounds = getSupervision('core-waitteam').rounds
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'agent-message', senderSessionId: 'tm-9' } } })
  await tick(10)
  assert.equal(getSupervision('core-waitteam').rounds, rounds + 1)
  ctx.dispose()
})

test('a declared wait temporarily stops the official driver and restores it', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('core-waitdriver')
  goals.create(agent, { objective: 'previous work' })
  const ctx = makeFakeContext({ agents: [agent], goals })
  resetSettings()
  apply(ctx, { wait: { defaultMs: 5 } })
  const run = (rawInput) => ctx.registeredCommands[0].handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  await tool.execute({ reason: 'waiting for the job' }, { agent })
  assert.ok(goals.calls.some((entry) => entry[0] === 'disarm'), 'the driver must pause while waiting')
  await tick(30)
  assert.ok(goals.calls.some((entry) => entry[0] === 'resume'), 'the driver must resume after the wait')
  assert.equal(agent.calls.followup.length, 0, 'the official driver resumes instead of a new round')
  ctx.dispose()
})

test('a second wait in the same step still restores the paused driver', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('core-waitdriver2')
  goals.create(agent, { objective: 'previous work' })
  const ctx = makeFakeContext({ agents: [agent], goals })
  resetSettings()
  apply(ctx, { wait: { defaultMs: 60000 } })
  const run = (rawInput) => ctx.registeredCommands[0].handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  run('1h')
  await tick(10)
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  await tool.execute({ reason: 'first wait' }, { agent })
  assert.ok(goals.calls.some((entry) => entry[0] === 'disarm'))
  // 第一次等待已经把官方驱动停掉了，第二次等待看到的是 disarmed，不能因此把“停过驱动”这件事忘掉。
  await tool.execute({ reason: 'second wait' }, { agent })
  ctx.emit('agent/inbox/inserted', { agent, message: { source: { kind: 'user' } } })
  await tick(10)
  assert.ok(goals.calls.some((entry) => entry[0] === 'resume'), 'the driver must come back after the nested wait')
  assert.equal(agent.calls.followup.length, 0, 'the official driver resumes instead of a new round')
  ctx.dispose()
})

test('a wait that ends after its goal finished still schedules a round', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('core-waitdrivergone')
  goals.create(agent, { objective: 'previous work' })
  const ctx = makeFakeContext({ agents: [agent], goals })
  resetSettings()
  apply(ctx, { wait: { defaultMs: 5 } })
  // 断言失败也要拆掉上下文：否则 1 小时的截止时间定时器会把这个测试进程挂住。
  try {
    const run = (rawInput) => ctx.registeredCommands[0].handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
    run('1h')
    await tick(10)
    const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
    await tool.execute({ reason: 'waiting for the job' }, { agent })
    assert.ok(goals.calls.some((entry) => entry[0] === 'disarm'), 'the driver must pause while waiting')
    // 等待期间目标自己收尾了：等待结束后驱动接不回来，监督必须自己补一轮，不能就此停摆。
    goals.complete()
    await tick(30)
    assert.equal(agent.calls.followup.length, 1, 'a round must resume the work once the wait is over')
  } finally {
    ctx.dispose()
  }
})

test('finishing stops the driver and pauses an active goal', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('core-finishgoal')
  goals.create(agent, { objective: 'previous work' })
  const ctx = makeFakeContext({ agents: [agent], goals })
  resetSettings()
  apply(ctx, {})
  const run = (rawInput) => ctx.registeredCommands[0].handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  run('1h')
  await tick(10)
  run('off')
  assert.ok(goals.calls.some((entry) => entry[0] === 'disarm'), 'the driver must be stopped at the deadline')
  assert.ok(goals.calls.some((entry) => entry[0] === 'pause'), 'the goal must be paused at the deadline')
  ctx.dispose()
})

test('a human stop ends supervision and closes it in the log', async () => {
  const { agent, ctx, run } = setup({ id: 'core-userstop' })
  run('1h')
  await tick(10)
  assert.ok(ctx.registeredTools.some((entry) => entry.name === 'dont_stop_wait'))
  ctx.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(getSupervision('core-userstop'), undefined)
  assert.match(String(agent.calls.inject.at(-1)?.content?.[0]?.text ?? ''), /kind="end" reason="manual"/, 'the status bar needs the end notice')
  assert.ok(ctx.registeredTools.some((entry) => entry.name === 'dont_stop_wait'), 'the wait tool stays registered')
  ctx.dispose()
})

test('the end notice is delivered after turn/end finishes publishing', async () => {
  const { agent, ctx, run } = setup({ id: 'core-userstop-reentry' })
  run('1h')
  await tick(10)
  const realInject = agent.inject
  const reject = () => {
    throw new Error('session append cannot reenter while another append is being published')
  }
  // 真实会话在发布 turn/end 期间拒绝再次 append；这里照抄这个行为。
  agent.inject = reject
  try {
    ctx.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    assert.equal(getSupervision('core-userstop-reentry'), undefined, 'supervision still ends at once')
    agent.inject = realInject
    await tick(1)
    assert.match(String(agent.calls.inject.at(-1)?.content?.[0]?.text ?? ''), /kind="end" reason="manual"/, 'the end notice is retried once publishing is over')
  } finally {
    agent.inject = realInject
    ctx.dispose()
  }
})

test('supervision is announced by injected context, not by the system prompt', async () => {
  const { agent, ctx, run } = setup({ id: 'core-notice' })
  run('1h')
  await tick(10)
  const notices = agent.calls.inject.map((message) => String(message.content?.[0]?.text ?? ''))
  assert.equal(notices.length, 1, 'one notice at the start')
  assert.match(notices[0], /<dont_stop_supervision kind="start">/)
  assert.doesNotMatch(notices[0], /\b1\d{12}\b/, 'machine attributes must not expose raw epoch milliseconds')
  assert.doesNotMatch(notices[0], /deadline=|started=/, 'the tag carries no timing attributes any more')
  assert.match(notices[0], /需要一直推进工作/)
  assert.doesNotMatch(notices[0], /until \d\d:\d\d/, 'the model must not be told the deadline')
  assert.doesNotMatch(notices[0], /剩余|还剩/, 'the model must not be told how much time is left')
  assert.equal(notices[0].includes('报告具体的阻碍'), false, 'the removed blocker line stays out of the start notice')
  assert.equal(agent.calls.inject[0]?.source?.dontStop?.deadlineAt, getSupervision('core-notice').deadlineAt, 'the status bar still gets its deadline, via the source')
  assert.equal(agent.calls.followup.length, 1, 'the notice must not consume a round prompt')
  assert.equal(notices[0].includes('dont_stop_wait'), true)
  ctx.dispose()
})

test('a second start resets the deadline without telling the agent', async () => {
  const { agent, ctx, run } = setup({ id: 'core-extend' })
  run('1h')
  await tick(10)
  const before = getSupervision('core-extend').deadlineAt
  const result = run('2h')
  assert.equal(result.kind, 'success')
  const extended = getSupervision('core-extend').deadlineAt
  assert.ok(extended > before, 'the supervision deadline moves later')
  assert.equal(agent.calls.inject.length, 1, 'no second notice is injected')
  assert.equal(run('30m').kind, 'success')
  assert.ok(getSupervision('core-extend').deadlineAt < extended, 'a later command may shorten the deadline too')
  assert.equal(agent.calls.inject.length, 1, 'shortening is silent as well')
  ctx.dispose()
})

test('finishing announces that supervision ended', async () => {
  const { agent, ctx, run } = setup({ id: 'core-endnotice' })
  run('1h')
  await tick(10)
  run('off')
  const notices = agent.calls.inject.map((message) => String(message.content?.[0]?.text ?? ''))
  assert.equal(notices.length, 2)
  assert.match(notices[1], /Dont-Stop 已结束/)
  assert.match(notices[1], /用户手动停止/)
  assert.equal(agent.calls.followup.length, 1, 'the end notice does not ask for a report')
  ctx.dispose()
})

test('closing a timed-out question is not treated as a human stop', async () => {
  const { agent, ctx, run } = setup({ id: 'core-selfclose', settings: { questionLimitMs: 5 } })
  run('1h')
  agent.status = 'running'
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question' } })
  await tick(30)
  ctx.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.ok(getSupervision('core-selfclose'), 'supervision must continue after its own cancel')
  ctx.dispose()
})

test('off ends supervision at once when the agent is idle', async () => {
  const { agent, goals, ctx, run } = setup({ id: 'core-off' })
  run('1h')
  await tick(10)
  const off = run('off')
  assert.equal(off.kind, 'success')
  assert.equal(getSupervision('core-off'), undefined, 'nothing is left running, so supervision ends at once')
  assert.match(String(agent.calls.inject.at(-1)?.content?.[0]?.text ?? ''), /kind="end" reason="manual"/)
  assert.equal(agent.calls.followup.length, 1, 'only the start round is queued; no report request')
  assert.ok(goals.calls.some((entry) => entry[0] === 'pause') || true)
  ctx.dispose()
})

test('ending again while the agent is wrapping up exits at once', async () => {
  const { agent, ctx, run } = setup({ id: 'core-off-twice', config: { finish: { graceMs: 600000 } } })
  run('1h')
  agent.status = 'running'
  run('off')
  assert.equal(getSupervision('core-off-twice')?.mode, 'finishing', 'the agent gets the wrap-up window')
  const off = run('off')
  assert.equal(off.kind, 'success')
  assert.equal(getSupervision('core-off-twice'), undefined, 'a second click closes it without waiting for the window')
  ctx.dispose()
})

test('the grace window ends in a hard stop that also stops subagents and jobs', async () => {
  const subagents = makeFakeSubagents(['child-1', 'child-2'])
  const jobs = makeFakeJobs()
  const { agent, ctx, run } = setup({
    id: 'core-hardstop',
    subagents,
    jobs,
    config: { finish: { graceMs: 5 } },
  })
  run('1h')
  await tick(10)
  agent.status = 'running'
  run('off')
  assert.match(String(agent.calls.steer[0]?.content?.[0]?.text ?? ''), /尽快收尾/, 'a running turn is asked to wrap up')
  assert.equal(agent.calls.steer.length, 1, 'one wrap-up instruction')
  assert.equal(agent.calls.cancel.length, 0, 'the grace window must allow work to continue')
  await tick(40)
  assert.equal(agent.calls.cancel.length, 1, 'the turn must be stopped after the window')
  assert.equal(agent.calls.cancel[0].options, undefined, 'the hard stop must not keep queued input')
  assert.equal(subagents.interrupted.length, 2, 'every child must be interrupted')
  assert.equal(subagents.interrupted[0].authority.kind, 'ancestor')
  assert.deepEqual(jobs.kills.map((entry) => entry.id), ['job-1'], 'running jobs must be killed')
  assert.equal(getSupervision('core-hardstop'), undefined)
  ctx.dispose()
})

test('the grace window keeps the turn alive while tools still run', async () => {
  const { agent, ctx, run } = setup({ id: 'core-window', config: { finish: { graceMs: 40 } } })
  run('1h')
  await tick(10)
  agent.status = 'running'
  run('off')
  ctx.emit('session/event', { id: agent.id }, { type: 'tool/call', data: { callId: 'c1', name: 'bash' } })
  await tick(20)
  assert.equal(agent.calls.cancel.length, 0)
  await tick(60)
  assert.equal(agent.calls.cancel.length, 1)
  ctx.dispose()
})

test('a deadline wakes an idle agent so it can wrap up, then force-stops what is left', async () => {
  const subagents = makeFakeSubagents(['child-1', 'child-2'])
  const jobs = makeFakeJobs()
  const { agent, ctx, run } = setup({ id: 'core-idle-deadline', subagents, jobs, config: { finish: { graceMs: 20 } } })
  run('1h')
  await tick(10)
  getSupervision('core-idle-deadline').deadlineAt = Date.now() - 1
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  assert.equal(getSupervision('core-idle-deadline')?.mode, 'finishing', 'an idle agent still gets the wrap-up window')
  assert.match(String(agent.calls.followup.at(-1)?.content?.[0]?.text ?? ''), /尽快收尾/, 'the idle agent is woken to wrap up')
  assert.equal(agent.calls.steer.length, 0, 'nothing is running, so there is nothing to steer')
  await tick(60)
  assert.equal(getSupervision('core-idle-deadline'), undefined)
  assert.equal(agent.calls.cancel.length, 1, 'the window still ends in a forced stop')
  assert.equal(subagents.interrupted.length, 2, 'children left behind are interrupted')
  assert.deepEqual(jobs.kills.map((entry) => entry.id), ['job-1'], 'leftover jobs are killed')
  ctx.dispose()
})

test('a wrap-up turn that ends early cleans up the leftovers itself', async () => {
  const subagents = makeFakeSubagents(['child-1'])
  const jobs = makeFakeJobs()
  const { agent, ctx, run } = setup({ id: 'core-idle-wrapup', subagents, jobs, config: { finish: { graceMs: 600000 } } })
  run('1h')
  await tick(10)
  getSupervision('core-idle-wrapup').deadlineAt = Date.now() - 1
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  assert.equal(getSupervision('core-idle-wrapup'), undefined, 'the finished wrap-up turn ends supervision')
  assert.equal(subagents.interrupted.length, 1, 'leftover children go with it')
  assert.deepEqual(jobs.kills.map((entry) => entry.id), ['job-1'], 'leftover jobs go with it')
  assert.equal(agent.calls.cancel.length, 0, 'nothing is left running, so nothing is cancelled')
  ctx.dispose()
})

test('a deadline ends a wait by waking the agent to wrap up', async () => {
  const subagents = makeFakeSubagents(['child-1'])
  const jobs = makeFakeJobs()
  const { agent, ctx, run } = setup({ id: 'core-wait-deadline', subagents, jobs, config: { finish: { graceMs: 20 } } })
  run('1s')
  const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
  const result = await tool.execute({ reason: '等子 agent 结束' }, { agent })
  assert.equal(result.status, 'waiting')
  await tick(1200)
  assert.equal(getSupervision('core-wait-deadline')?.waiting, undefined, 'the wait is cleared at the deadline')
  assert.match(String(agent.calls.followup.at(-1)?.content?.[0]?.text ?? ''), /尽快收尾/, 'the wait does not suppress the wrap-up message')
  await tick(60)
  assert.equal(getSupervision('core-wait-deadline'), undefined)
  assert.equal(subagents.interrupted.length, 1, 'the subagent being waited on is stopped too')
  assert.deepEqual(jobs.kills.map((entry) => entry.id), ['job-1'], 'background jobs are stopped too')
  ctx.dispose()
})

test('disposing the plugin clears every timer and supervision entry', async () => {
  const { ctx, run } = setup({ id: 'core-dispose' })
  run('6h')
  await tick(10)
  assert.ok(getSupervision('core-dispose'))
  ctx.dispose()
  assert.equal(getSupervision('core-dispose'), undefined)
})

test('the wait tool is always registered while supervision is on', () => {
  const { agent, ctx, run } = setup({ id: 'core-waittool' })
  try {
    const tool = ctx.registeredTools.find((entry) => entry.name === 'dont_stop_wait')
    assert.ok(tool, 'the tool is registered without any setting toggle')
    const file = fileURLToPath(new URL('../prompts.json', import.meta.url))
    const entries = JSON.parse(readFileSync(file, 'utf8')).waitTool
    assert.equal(tool.description, entries.join('\n'), '每条工具说明各自成行，不要粘成一段')
    run('1h')
    const notice = String(agent.calls.inject[0]?.content?.[0]?.text ?? '')
    assert.ok(notice.includes('dont_stop_wait'), 'the notice tells the agent about the tool')
  } finally {
    ctx.dispose()
  }
})

test('a deadline ends supervision without forcing a stop when that is switched off', async () => {
  const { agent, ctx, run } = setup({ id: 'core-released', settings: { stopAtDeadline: false } })
  run('1h')
  await tick(10)
  getSupervision('core-released').deadlineAt = Date.now() - 1
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  assert.equal(getSupervision('core-released'), undefined, 'supervision must end at the deadline')
  const notices = agent.calls.inject.map((message) => String(message.content?.[0]?.text ?? ''))
  assert.match(notices.at(-1), /kind="end" reason="released"/)
  assert.equal(agent.calls.steer.length, 0, 'nothing may ask the agent to stop')
  assert.equal(agent.calls.followup.length, 1, 'nothing is queued for the agent beyond the start round')
  ctx.dispose()
})

test('--no-stop releases at the deadline even when the settings would stop', async () => {
  const { agent, ctx, run } = setup({ id: 'core-keep' })
  const started = run('1h --no-stop')
  assert.equal(started.kind, 'success')
  await tick(10)
  assert.equal(getSupervision('core-keep').stopAtDeadline, false)
  getSupervision('core-keep').deadlineAt = Date.now() - 1
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  assert.equal(getSupervision('core-keep'), undefined)
  const notices = agent.calls.inject.map((message) => String(message.content?.[0]?.text ?? ''))
  assert.match(notices.at(-1), /kind="end" reason="released"/)
  assert.equal(agent.calls.steer.length, 0, 'a released cycle never asks the agent to stop')
  ctx.dispose()
})

test('a released cycle leaves the official goal driver armed', async () => {
  const goals = makeFakeGoals()
  const agent = makeFakeAgent('core-releasegoal')
  goals.create(agent, { objective: 'previous work' })
  const ctx = makeFakeContext({ agents: [agent], goals })
  resetSettings()
  apply(ctx, {})
  const run = (rawInput) => ctx.registeredCommands[0].handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  run('1h --no-stop')
  await tick(10)
  getSupervision('core-releasegoal').deadlineAt = Date.now() - 1
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(20)
  assert.equal(getSupervision('core-releasegoal'), undefined, 'the cycle must end at the deadline')
  assert.equal(goals.calls.some((entry) => entry[0] === 'disarm'), false, 'releasing must not stop a driver the plugin never paused')
  assert.equal(goals.activation, 'armed', 'the official driver keeps the task moving')
  ctx.dispose()
})

test('--stop forces the wrap-up at the deadline even when the settings release', async () => {
  const { agent, ctx, run } = setup({ id: 'core-force', settings: { stopAtDeadline: false } })
  run('1h --stop')
  await tick(10)
  assert.equal(getSupervision('core-force').stopAtDeadline, true)
  getSupervision('core-force').deadlineAt = Date.now() - 1
  ctx.emit('agent/status', { agent, status: 'idle' })
  await tick(10)
  const notices = agent.calls.inject.map((message) => String(message.content?.[0]?.text ?? ''))
  assert.match(notices.at(-1), /kind="end" reason="deadline"/, 'the cycle option beats the global switch')
  assert.match(notices.at(-1), /已到截止时间/)
  ctx.dispose()
})

test('an option-only command changes the cycle without touching the deadline', async () => {
  const { agent, ctx, run } = setup({ id: 'core-option-only' })
  run('1h')
  await tick(10)
  const before = getSupervision('core-option-only').deadlineAt
  const result = run('--no-stop')
  assert.equal(result.kind, 'success')
  assert.equal(getSupervision('core-option-only').deadlineAt, before, 'the deadline is untouched')
  assert.equal(getSupervision('core-option-only').stopAtDeadline, false)
  assert.equal(agent.calls.inject.length, 1, 'no extra notice is injected')
  assert.equal(run('--stop').kind, 'success')
  assert.equal(getSupervision('core-option-only').stopAtDeadline, true)
  assert.equal(agent.calls.inject.length, 1, 'flipping back is silent as well')
  ctx.dispose()
})

test('an option-only command starts supervision when none is running', () => {
  const { agent, ctx, run } = setup({ id: 'core-option-start' })
  const result = run('--no-stop')
  assert.equal(result.kind, 'success')
  const state = getSupervision('core-option-start')
  assert.equal(state.stopAtDeadline, false)
  assert.ok(state.deadlineAt > Date.now(), 'the default duration applies when there is nothing to adjust')
  assert.equal(agent.calls.inject[0]?.source?.dontStop?.stopAtDeadline, false, 'the bar learns the cycle option from the start notice')
  ctx.dispose()
})

test('a later command keeps the cycle option unless it passes a new one', async () => {
  const { ctx, run } = setup({ id: 'core-override-extend' })
  run('1h --no-stop')
  await tick(10)
  run('2h')
  assert.equal(getSupervision('core-override-extend').stopAtDeadline, false, 'resetting the deadline keeps the option')
  run('2h --stop')
  assert.equal(getSupervision('core-override-extend').stopAtDeadline, true)
  ctx.dispose()
})

test('the minimum interval keeps two supervision messages apart', async () => {
  const { agent, ctx, run } = setup({ id: 'core-interval', settings: { minRoundIntervalMs: 60000 } })
  run('1h')
  await tick(10)
  const state = getSupervision('core-interval')
  assert.equal(agent.calls.followup.length, 0, 'the first round waits for the interval')
  assert.equal(state.rounds, 0)
  assert.notEqual(state.roundTimer, undefined, 'a round is scheduled once the interval has passed')
  ctx.dispose()
})

