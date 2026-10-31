import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUTH,
  CONTEXT,
  DEFAULT_RECOVERY_DELAYS,
  QUOTA,
  RATE_LIMIT,
  SERVER,
  TIMEOUT,
  TRANSIENT,
  UNKNOWN,
  classifyError,
  classifyFailure,
} from '../shared/classify.js'

test('classifyFailure maps known codes', () => {
  assert.equal(classifyFailure({ code: 'RATE_LIMIT', message: '' }), RATE_LIMIT)
  assert.equal(classifyFailure({ code: 'QUOTA', message: '' }), QUOTA)
  assert.equal(classifyFailure({ code: 'ACCOUNT_QUOTA', message: '' }), QUOTA)
  assert.equal(classifyFailure({ code: 'TRANSPORT', message: '' }), TRANSIENT)
  assert.equal(classifyFailure({ code: 'EMPTY_RESPONSE', message: '' }), TRANSIENT)
  assert.equal(classifyFailure({ code: 'SERVER', message: '' }), SERVER)
  assert.equal(classifyFailure({ code: 'HTTP_503', message: '' }), SERVER)
  assert.equal(classifyFailure({ code: 'AUTH', message: '' }), AUTH)
  assert.equal(classifyFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: '' }), CONTEXT)
})

test('classifyFailure falls back to message text for the pi-ai route', () => {
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: '429 Too Many Requests' }), RATE_LIMIT)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: '5-hour usage limit reached, resets in 20 min' }), QUOTA)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'insufficient balance' }), QUOTA)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'upstream overloaded, retry later' }), SERVER)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'socket hang up' }), TRANSIENT)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'maximum context length exceeded' }), CONTEXT)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'invalid api key' }), AUTH)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'something odd happened' }), UNKNOWN)
})

test('classifyFailure uses status when code is opaque', () => {
  assert.equal(classifyFailure({ code: 'HTTP_UNKNOWN', message: 'x', status: 503 }), SERVER)
  assert.equal(classifyFailure({ code: 'HTTP_UNKNOWN', message: 'x', status: 429 }), RATE_LIMIT)
  assert.equal(classifyFailure({ code: 'HTTP_UNKNOWN', message: 'x', status: 402 }), QUOTA)
})

test('classifyError unwraps LlmError-style failures', () => {
  const error = new Error('boom')
  error.failure = { code: 'RATE_LIMIT', message: 'slow down' }
  assert.equal(classifyError(error), RATE_LIMIT)
  assert.equal(classifyError(new Error('ECONNRESET')), TRANSIENT)
  assert.equal(classifyError(new Error('read ECONNREFUSED')), TRANSIENT)
  assert.equal(classifyError(new Error('totally unknown')), UNKNOWN)
})

test('request timeouts get their own class and the recovery ladder covers them', () => {
  const failure = { message: 'Request timed out.', code: 'TIMEOUT' }
  assert.equal(classifyFailure(failure), TIMEOUT)
  assert.equal(classifyFailure({ message: 'Request timed out.' }), TIMEOUT, 'no code still classified by text')
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'Request timed out.' }), TIMEOUT)
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'APIConnectionTimeoutError: ETIMEDOUT' }), TIMEOUT)
  assert.equal(classifyError(Object.assign(new Error('Request timed out.'), { code: 'TIMEOUT' })), TIMEOUT)
  assert.equal(classifyError(new Error('Request timed out.')), TIMEOUT)

  assert.deepEqual(DEFAULT_RECOVERY_DELAYS[TIMEOUT], [60000, 300000, 1800000], 'timeouts wait a minute, then five, then half an hour')
  for (const cls of ['rate-limit', 'quota', 'timeout', 'transient', 'server']) {
    const delays = DEFAULT_RECOVERY_DELAYS[cls]
    assert.ok(delays[delays.length - 1] >= 1800000, `${cls} must be able to wait half an hour before its last retry`)
    assert.ok(delays[delays.length - 1] <= 5400000, `${cls} must not exceed ninety minutes`)
    assert.ok(delays[0] <= 600000, `${cls} must still retry within ten minutes the first time`)
  }
  assert.equal(classifyFailure({ code: 'PI_AI_ERROR', message: 'gateway timeout' }), SERVER, 'HTTP gateway timeouts stay server errors')
})
