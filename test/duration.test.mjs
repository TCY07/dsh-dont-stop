import assert from 'node:assert/strict'
import test from 'node:test'

import { USAGE, parseClock, parseDuration, parseSpec } from '../shared/duration.js'

const NOW = new Date(2026, 9, 30, 20, 0, 0, 0).getTime()

test('parseDuration accepts unit spellings and rejects junk', () => {
  assert.equal(parseDuration('6h'), 6 * 3600000)
  assert.equal(parseDuration('90m'), 90 * 60000)
  assert.equal(parseDuration('2d'), 2 * 86400000)
  assert.equal(parseDuration('1.5h'), 1.5 * 3600000)
  assert.equal(parseDuration('6 hours'), 6 * 3600000)
  assert.equal(parseDuration('8min'), 8 * 60000)
  assert.equal(parseDuration('8 mins'), 8 * 60000)
  assert.equal(parseDuration('8minute'), 8 * 60000)
  assert.equal(parseDuration('8minutes'), 8 * 60000)
  assert.equal(parseDuration('8 hour'), 8 * 3600000)
  assert.equal(parseDuration('8hours'), 8 * 3600000)
  assert.equal(parseDuration('8 hrs'), 8 * 3600000)
  assert.equal(parseDuration('8分钟'), 8 * 60000)
  assert.equal(parseDuration('8 分钟'), 8 * 60000)
  assert.equal(parseDuration('8个小时'), 8 * 3600000)
  assert.equal(parseDuration('8小时'), 8 * 3600000)
  assert.equal(parseDuration('2天'), 2 * 86400000)
  assert.equal(parseDuration('30秒'), 30000)
  assert.equal(parseDuration('1h30m'), 90 * 60000)
  assert.equal(parseDuration('1小时30分钟'), 90 * 60000)
  assert.equal(parseDuration('８分钟'), 8 * 60000, 'full-width digits')
  assert.equal(parseDuration('8months'), null, 'unknown suffix must not degrade to 8m')
  assert.equal(parseDuration('8'), null)
  assert.equal(parseDuration('h'), null)
  assert.equal(parseDuration('0h'), null)
  assert.equal(parseDuration('6h extra'), null)
  assert.equal(parseDuration(''), null)
})

test('parseClock rolls past times to tomorrow', () => {
  const future = parseClock('22:30', NOW)
  assert.equal(new Date(future).getHours(), 22)
  assert.equal(new Date(future).getDate(), 30)
  const past = parseClock('08:00', NOW)
  assert.equal(new Date(past).getDate(), 31)
  assert.equal(parseClock('22：30', NOW), future, 'full-width colon')
  assert.equal(parseClock('22点', NOW), new Date(2026, 9, 30, 22, 0, 0, 0).getTime())
  assert.equal(parseClock('22点30分', NOW), future)
  assert.equal(parseClock('22时', NOW), new Date(2026, 9, 30, 22, 0, 0, 0).getTime(), '时 also means the hour')
  assert.equal(parseClock('22时30分', NOW), future)
  assert.equal(parseClock('22時30', NOW), future, 'traditional 時 and a bare minute')
  assert.equal(parseClock('22时60分', NOW), null)
  assert.equal(parseClock('24:00', NOW), null)
  assert.equal(parseClock('22:75', NOW), null)
})

test('parseSpec accepts the 时 forms for until', () => {
  const spec = parseSpec('until 22时 收尾', { now: NOW })
  assert.equal(spec.kind, 'start')
  assert.equal(new Date(spec.deadlineAt).getHours(), 22)
  assert.equal(spec.objective, '收尾')
  assert.equal(new Date(parseSpec('until 22时30分', { now: NOW }).deadlineAt).getMinutes(), 30)
  assert.equal(parseSpec('--no-stop until 8时', { now: NOW }).stopAtDeadline, false)
})

test('parseSpec handles commands', () => {
  assert.deepEqual(parseSpec('off', { now: NOW }), { kind: 'off' })
  assert.deepEqual(parseSpec('off now', { now: NOW }), { kind: 'off' })
  assert.equal(parseSpec('status', { now: NOW }).kind, 'error', 'the status command is gone')

  const def = parseSpec('', { now: NOW, defaultMs: 6 * 3600000 })
  assert.equal(def.kind, 'start')
  assert.equal(def.deadlineAt, NOW + 6 * 3600000)

  const withObjective = parseSpec('2h finish the tests', { now: NOW })
  assert.equal(withObjective.kind, 'start')
  assert.equal(withObjective.deadlineAt, NOW + 2 * 3600000)
  assert.equal(withObjective.objective, 'finish the tests')

  const spelled = parseSpec('8 hours finish the tests', { now: NOW })
  assert.equal(spelled.kind, 'start')
  assert.equal(spelled.deadlineAt, NOW + 8 * 3600000)
  assert.equal(spelled.objective, 'finish the tests')

  const chinese = parseSpec('8分钟 把日志翻一遍', { now: NOW })
  assert.equal(chinese.kind, 'start')
  assert.equal(chinese.deadlineAt, NOW + 8 * 60000)
  assert.equal(chinese.objective, '把日志翻一遍')

  const compound = parseSpec('1小时30分钟 收个尾', { now: NOW })
  assert.equal(compound.deadlineAt, NOW + 90 * 60000)
  assert.equal(compound.objective, '收个尾')

  const numberedObjective = parseSpec('2h 3个测试还红着', { now: NOW })
  assert.equal(numberedObjective.deadlineAt, NOW + 2 * 3600000, 'objective starting with a number is not eaten')
  assert.equal(numberedObjective.objective, '3个测试还红着')

  const until = parseSpec('until 22:00', { now: NOW })
  assert.equal(until.kind, 'start')
  assert.equal(new Date(until.deadlineAt).getHours(), 22)
  assert.equal(until.objective, '')

  const untilWithObjective = parseSpec('until 22:00 check the deploy log', { now: NOW })
  assert.equal(untilWithObjective.kind, 'start')
  assert.equal(new Date(untilWithObjective.deadlineAt).getHours(), 22)
  assert.equal(untilWithObjective.objective, 'check the deploy log')

  assert.equal(parseSpec('tomorrow', { now: NOW }).kind, 'error')
  assert.equal(parseSpec('until', { now: NOW }).kind, 'error')
  assert.equal(parseSpec('until nope', { now: NOW }).kind, 'error')
  assert.equal(parseSpec('30h', { now: NOW, maxMs: 24 * 3600000 }).kind, 'error', 'a configured cap still applies')
  assert.equal(parseSpec('6h30', { now: NOW }).kind, 'error', 'trailing number without unit is not an objective')
})

test('durations are uncapped by default and days are accepted', () => {
  for (const [text, hours] of [['2天', 48], ['3 天', 72], ['1.5天', 36], ['2day', 48], ['2 days', 48], ['2日', 48], ['48h', 48], ['100h', 100]]) {
    const spec = parseSpec(text, { now: NOW })
    assert.equal(spec.kind, 'start', `${text} must parse`)
    assert.equal(spec.deadlineAt, NOW + hours * 3600000, `${text} is ${hours} hours`)
  }
  assert.equal(parseSpec('2天 干到后天', { now: NOW }).objective, '干到后天')
  assert.equal(parseSpec('1h30m', { now: NOW }).deadlineAt, NOW + 90 * 60000)
})

test('parseSpec reads the per-cycle stop options', () => {
  const forced = parseSpec('2h --stop 补测试', { now: NOW })
  assert.equal(forced.kind, 'start')
  assert.equal(forced.stopAtDeadline, true)
  assert.equal(forced.deadlineAt, NOW + 2 * 3600000)
  assert.equal(forced.objective, '补测试')

  const kept = parseSpec('--no-stop 2h 补测试', { now: NOW })
  assert.equal(kept.kind, 'start')
  assert.equal(kept.stopAtDeadline, false, 'options may come before the duration')
  assert.equal(kept.deadlineAt, NOW + 2 * 3600000)
  assert.equal(kept.objective, '补测试')

  const untilKept = parseSpec('until 22:00 --no-stop', { now: NOW })
  assert.equal(untilKept.stopAtDeadline, false)
  assert.equal(untilKept.objective, '')

  const untilForced = parseSpec('until 22:00 --stop 收个尾', { now: NOW })
  assert.equal(untilForced.stopAtDeadline, true)
  assert.equal(untilForced.objective, '收个尾')

  const untilBefore = parseSpec('--no-stop until 22点', { now: NOW })
  assert.equal(untilBefore.kind, 'start')
  assert.equal(untilBefore.stopAtDeadline, false, 'options may come before until as well')

  assert.match(USAGE, /until 22:00 .*\[--stop\|--no-stop\]/, 'the hint states the flags work for until too')

  const only = parseSpec('--stop', { now: NOW, defaultMs: 3600000 })
  assert.deepEqual(only, { kind: 'option', stopAtDeadline: true }, 'flags alone only adjust the running cycle')
  assert.deepEqual(parseSpec('--no-stop', { now: NOW }), { kind: 'option', stopAtDeadline: false })

  assert.equal(parseSpec('2h 补测试', { now: NOW }).stopAtDeadline, undefined, 'no option means follow the settings')

  const inline = parseSpec('2h 把 --no-stop 写进说明里', { now: NOW })
  assert.equal(inline.stopAtDeadline, undefined, 'options are only read at the start')
  assert.equal(inline.objective, '把 --no-stop 写进说明里')
  assert.equal(parseSpec('2h --sto 补测试', { now: NOW }).kind, 'error', 'a misspelled option is an error, not an objective')
})
