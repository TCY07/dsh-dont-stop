import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../core/index.js'
import { dontStopProjection } from '../core/projection.js'
import { userMessage } from '../shared/message.js'
import { makeFakeAgent, makeFakeContext, makeFakeProjections } from './fake-ctx.mjs'

const KEY = 'dontStop'

/** 一条入队公告在会话日志里的样子。 */
const spliced = (message) => ({ type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-step', start: 0, inserted: [message] } })

const fold = (state, message) => dontStopProjection.apply(state, spliced(message))

function setupProjection(options = {}) {
  const agent = makeFakeAgent(options.id ?? 'projection-session')
  const projections = options.projections ?? makeFakeProjections()
  const ctx = makeFakeContext({ agents: options.agents ?? [agent], projections })
  apply(ctx, options.config ?? {})
  const command = ctx.registeredCommands.find((entry) => entry.name === 'dont-stop')
  const run = (rawInput) => command.handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  return { agent, ctx, projections, run }
}

const textOf = (message) => String(message?.content?.[0]?.text ?? '')

test('a start notice folds into a supervised state with its deadline', () => {
  const state = fold(dontStopProjection.init(), userMessage('<dont_stop_supervision kind="start" started="1000" deadline="7200000">\n…\n</dont_stop_supervision>'))
  assert.equal(state.phase, 'supervising')
  assert.equal(state.startedAt, 1000)
  assert.equal(state.deadlineAt, 7200000)
  assert.equal(dontStopProjection.wire.view(state), state, 'the view is the folded state itself')
})

test('an extension moves the deadline without resetting the rounds', () => {
  const start = userMessage('<dont_stop_supervision kind="start" started="1000" deadline="7200000">')
  const round = userMessage('<dont_stop_round round="4" deadline="7200000">')
  const extend = userMessage('<dont_stop_supervision kind="extend" deadline="9000000">')
  const state = [start, round, extend].reduce(fold, dontStopProjection.init())
  assert.equal(state.deadlineAt, 9000000)
  assert.equal(state.rounds, 4)
  assert.equal(state.startedAt, 1000)
})

test('ISO timestamps in the machine attributes fold to the same instants', () => {
  const iso = '2026-10-31T00:24:45+08:00'
  const state = fold(dontStopProjection.init(), userMessage(`<dont_stop_supervision kind="start" started="${iso}" deadline="${iso}">`))
  assert.equal(state.phase, 'supervising')
  assert.equal(state.startedAt, Date.parse(iso))
  assert.equal(state.deadlineAt, Date.parse(iso))
})

test('a round notice only advances the round counter', () => {
  const start = fold(dontStopProjection.init(), userMessage('<dont_stop_supervision kind="start" deadline="5000">'))
  const state = fold(start, userMessage('<dont_stop_round round="2">'))
  assert.equal(state.rounds, 2)
  assert.equal(state.deadlineAt, 5000, 'the deadline keeps coming from the start notice')
  assert.notEqual(state, start, 'a changed fold must return a new state')
})

test('older round notices that carried a deadline still fold', () => {
  const start = fold(dontStopProjection.init(), userMessage('<dont_stop_supervision kind="start" deadline="5000">'))
  const state = fold(start, userMessage('<dont_stop_round round="2" deadline="6000">'))
  assert.equal(state.rounds, 2)
  assert.equal(state.deadlineAt, 6000)
})

test('an end notice clears the supervised state', () => {
  const start = fold(dontStopProjection.init(), userMessage('<dont_stop_supervision kind="start" deadline="5000">'))
  const state = fold(start, userMessage('<dont_stop_supervision kind="end" reason="manual">'))
  assert.equal(state.phase, 'idle')
  assert.equal(dontStopProjection.wire.view(state), null)
  assert.equal(fold(state, userMessage('<dont_stop_supervision kind="end" reason="manual">')), state, 'ending twice is a no-op')
})

test('messages without a marker leave the state untouched', () => {
  const start = fold(dontStopProjection.init(), userMessage('<dont_stop_supervision kind="start" deadline="5000">'))
  const ignored = [
    userMessage('an ordinary queued prompt', 'user'),
    userMessage('the final report prompt'),
    userMessage('<dont_stop_supervision kind="start" deadline="not-a-number">'),
    userMessage('no tags at all'),
  ]
  for (const message of ignored) assert.equal(fold(start, message), start)
  assert.equal(fold(start, { content: 'broken' }), start)
})

test('the notices the command writes fold from the message source, not from the text', async () => {
  const { agent, ctx, run } = setupProjection({ id: 'projection-notices' })
  run('1h')
  const message = agent.calls.inject[0]
  assert.equal(message.source.dontStop.phase, 'start')
  assert.equal(typeof message.source.dontStop.deadlineAt, 'number')
  assert.doesNotMatch(textOf(message), /deadline=|started=|\b1\d{12}\b/, 'no timing data in the model-visible text')
  assert.doesNotMatch(textOf(message), /\d\d:\d\d/, 'not even a clock time')
  const start = fold(dontStopProjection.init(), message)
  assert.equal(start.phase, 'supervising')
  assert.equal(start.deadlineAt, message.source.dontStop.deadlineAt, 'the bar counts down to the same instant')
  run('off')
  const endMessage = agent.calls.inject.at(-1)
  assert.equal(endMessage.source.dontStop.phase, 'end')
  const ended = fold(start, endMessage)
  assert.equal(ended.phase, 'idle')
  assert.equal(dontStopProjection.wire.view(ended), null)
  ctx.dispose()
})

test('machine data in the source folds without any marker in the text', () => {
  const now = Date.now()
  const message = userMessage('plain notice text', 'dont-stop', { dontStop: { phase: 'start', startedAt: now, deadlineAt: now + 3600000 } })
  const state = fold(dontStopProjection.init(), message)
  assert.equal(state.phase, 'supervising')
  assert.equal(state.deadlineAt, now + 3600000)
  assert.equal(state.startedAt, now)
  const extended = fold(state, userMessage('still working', 'dont-stop', { dontStop: { phase: 'extend', deadlineAt: now + 7200000 } }))
  assert.equal(extended.deadlineAt, now + 7200000)
  assert.equal(fold(extended, userMessage('done', 'dont-stop', { dontStop: { phase: 'end', reason: 'manual' } })).phase, 'idle')
})

test('a repeated /dont-stop command resets the deadline from the command log alone', () => {
  const now = Date.now()
  const start = fold(dontStopProjection.init(), userMessage('plain start', 'dont-stop', { dontStop: { phase: 'start', startedAt: now, deadlineAt: now + 3600000 } }))
  const command = (args, time) => ({ type: 'command/run', seq: 2, time, data: { commandId: 'c1', name: 'dont-stop', args, source: { kind: 'user' } } })
  const extended = dontStopProjection.apply(start, command('2h', now))
  assert.equal(extended.phase, 'supervising')
  assert.equal(extended.deadlineAt, now + 7200000, 'the bar counts down to the new deadline')
  assert.equal(extended.startedAt, now, 'the extension does not restart the supervision')
  const shortened = dontStopProjection.apply(extended, command('10m', now))
  assert.equal(shortened.deadlineAt, now + 600000, 'a later command can shorten the deadline too')
  assert.equal(dontStopProjection.apply(start, command('--bogus', now)), start)
  assert.equal(dontStopProjection.apply(start, command('off', now)), start)
})

test('the cycle stop option rides on the start notice and on later commands', () => {
  const now = Date.now()
  const command = (args, time) => ({ type: 'command/run', seq: 2, time, data: { commandId: 'c1', name: 'dont-stop', args, source: { kind: 'user' } } })
  const start = fold(dontStopProjection.init(), userMessage('plain start', 'dont-stop', {
    dontStop: { phase: 'start', startedAt: now, deadlineAt: now + 3600000, stopAtDeadline: false },
  }))
  assert.equal(start.stopAtDeadline, false)
  const kept = dontStopProjection.apply(start, command('2h', now))
  assert.equal(kept.stopAtDeadline, false, 'a plain reset keeps the cycle option')
  assert.equal(kept.deadlineAt, now + 7200000)
  const flipped = dontStopProjection.apply(kept, command('--stop', now))
  assert.equal(flipped.stopAtDeadline, true)
  assert.equal(flipped.deadlineAt, kept.deadlineAt, 'an option-only command never moves the deadline')
  assert.equal(dontStopProjection.apply(start, command('1h --stop', now)).stopAtDeadline, true)
  assert.equal(fold(dontStopProjection.init(), userMessage('old', 'dont-stop', {
    dontStop: { phase: 'start', startedAt: now, deadlineAt: now + 3600000 },
  })).stopAtDeadline, undefined, 'logs without the field stay unknown')
})

test('a command log without supervision does not start one', () => {
  const state = dontStopProjection.apply(dontStopProjection.init(), {
    type: 'command/run',
    time: Date.now(),
    data: { name: 'dont-stop', args: '1h', source: { kind: 'user' } },
  })
  assert.equal(state.phase, 'idle')
})

test('the projection is registered once and dropped with the plugin', () => {
  const { ctx, projections } = setupProjection({ id: 'projection-register' })
  assert.equal(projections.registrations.filter((entry) => entry.key === KEY).length, 1)
  assert.equal(projections.registrations[0].stateVersion, 3)
  ctx.dispose()
  assert.equal(projections.registrations.length, 0)
})

test('a stale supervision left by a restart is closed when the plugin loads', () => {
  const projections = makeFakeProjections()
  projections.states.set(KEY, { phase: 'supervising', startedAt: 1, deadlineAt: Date.now() + 60000, rounds: 3 })
  const agent = makeFakeAgent('projection-stale-load')
  const ctx = makeFakeContext({ agents: [agent], projections })
  apply(ctx, {})
  assert.equal(agent.calls.inject.length, 1)
  assert.match(textOf(agent.calls.inject[0]), /kind="end" reason="stale"/)
  ctx.dispose()
})

test('a stale supervision is closed when the human asks to stop it', () => {
  const { agent, projections, run } = setupProjection({ id: 'projection-stale-command' })
  projections.states.set(KEY, { phase: 'supervising', startedAt: 1, deadlineAt: Date.now() + 60000, rounds: 3 })
  const result = run('stop')
  assert.equal(result.text, 'Dont-Stop is not active.')
  assert.match(textOf(agent.calls.inject.at(-1)), /kind="end" reason="stale"/)
})

test('a session that is not supervised gets no extra notice', () => {
  const { agent, ctx } = setupProjection({ id: 'projection-clean' })
  assert.equal(agent.calls.inject.length, 0)
  ctx.dispose()
})
