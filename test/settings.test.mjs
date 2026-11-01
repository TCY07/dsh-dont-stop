/**
 * 设置存储与设置接口的离线测试：默认值、非法输入、落盘、GET/POST、同源检查。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test, { after } from 'node:test'

import {
  DEFAULT_SETTINGS,
  MAX_MIN_ROUND_INTERVAL_MS,
  MAX_QUESTION_LIMIT_MS,
  SETTINGS_ROUTE_PATH,
  createSettingsStore,
  handleSettingsRequest,
  normalizeSettings,
  registerSettingsRoute,
} from '../core/settings.js'
import { makeFakeContext } from './fake-ctx.mjs'

// 用例之间用不同的设置文件；整个文件的临时目录在结束时删掉，别把 %TEMP% 堆满。
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'dsh-dont-stop-settings-'))
after(() => rmSync(TEMP_ROOT, { recursive: true, force: true }))
let tempSequence = 0
const tempPath = () => join(TEMP_ROOT, `settings-${(tempSequence += 1)}.json`)

function makeRequest({ method = 'GET', body, headers = {} } = {}) {
  const request = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))])
  request.method = method
  request.headers = headers
  return request
}

function makeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(payload) {
      this.body = payload === undefined ? '' : String(payload)
    },
  }
}

test('normalizeSettings falls back to defaults for unknown values', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ waitTool: 'yes', stopAtDeadline: 1 }), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({ waitTool: false, errorRecovery: false, stopAtDeadline: false, minRoundIntervalMs: 0 }), {
    waitTool: false,
    errorRecovery: false,
    stopAtDeadline: false,
    minRoundIntervalMs: 0,
    questionLimitAlways: false,
    questionLimitMs: 300000,
    keepAwake: 'ac-only',
  })
})

test('normalizeSettings keeps the error recovery switch boolean', () => {
  assert.equal(normalizeSettings({ errorRecovery: false }).errorRecovery, false)
  assert.equal(normalizeSettings({ errorRecovery: true }).errorRecovery, true)
  assert.equal(normalizeSettings({ errorRecovery: 'off' }).errorRecovery, true, 'unknown values fall back to on')
})

test('normalizeSettings clamps the interval to the allowed range', () => {
  assert.equal(normalizeSettings({ minRoundIntervalMs: 90000 }).minRoundIntervalMs, 90000)
  assert.equal(normalizeSettings({ minRoundIntervalMs: -5 }).minRoundIntervalMs, 0)
  assert.equal(normalizeSettings({ minRoundIntervalMs: 9e9 }).minRoundIntervalMs, MAX_MIN_ROUND_INTERVAL_MS)
  assert.equal(normalizeSettings({ minRoundIntervalMs: 1500.6 }).minRoundIntervalMs, 1501)
})

test('normalizeSettings clamps the question limit and keeps the always-on switch', () => {
  assert.equal(normalizeSettings({ questionLimitAlways: true }).questionLimitAlways, true)
  assert.equal(normalizeSettings({ questionLimitAlways: 'yes' }).questionLimitAlways, false, 'unknown values fall back to off')
  assert.equal(normalizeSettings({ questionLimitMs: 600000 }).questionLimitMs, 600000)
  assert.equal(normalizeSettings({ questionLimitMs: 0 }).questionLimitMs, 0, '0 means no limit')
  assert.equal(normalizeSettings({ questionLimitMs: -1000 }).questionLimitMs, 0)
  assert.equal(normalizeSettings({ questionLimitMs: 9e9 }).questionLimitMs, MAX_QUESTION_LIMIT_MS, 'at most two hours')
  assert.equal(normalizeSettings({ questionLimitMs: 90000.4 }).questionLimitMs, 90000)
})

test('normalizeSettings keeps only the three keep-awake modes', () => {
  assert.equal(normalizeSettings({ keepAwake: 'off' }).keepAwake, 'off')
  assert.equal(normalizeSettings({ keepAwake: 'always' }).keepAwake, 'always')
  assert.equal(normalizeSettings({ keepAwake: 'ac-only' }).keepAwake, 'ac-only')
  assert.equal(normalizeSettings({ keepAwake: 'sometimes' }).keepAwake, 'ac-only', 'unknown values fall back to ac-only')
  assert.equal(normalizeSettings({ keepAwake: true }).keepAwake, 'ac-only')
})

test('a fresh store starts from defaults and persists updates', () => {
  const path = tempPath()
  const store = createSettingsStore({ path })
  assert.deepEqual(store.get(), DEFAULT_SETTINGS)
  store.update({ waitTool: false, minRoundIntervalMs: 30000 })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    waitTool: false,
    errorRecovery: true,
    stopAtDeadline: true,
    minRoundIntervalMs: 30000,
    questionLimitAlways: false,
    questionLimitMs: 300000,
    keepAwake: 'ac-only',
  })
  const reopened = createSettingsStore({ path })
  assert.deepEqual(reopened.get(), { waitTool: false, errorRecovery: true, stopAtDeadline: true, minRoundIntervalMs: 30000, questionLimitAlways: false, questionLimitMs: 300000, keepAwake: 'ac-only' })
})

test('subscribers hear only real changes', () => {
  const store = createSettingsStore({ path: tempPath() })
  const seen = []
  const unsubscribe = store.subscribe((value) => seen.push(value))
  store.update({ waitTool: true })
  store.update({ stopAtDeadline: false })
  unsubscribe()
  store.update({ waitTool: false })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].stopAtDeadline, false)
})

test('a broken settings file does not stop the plugin from starting', () => {
  const path = tempPath()
  writeFileSync(path, '{ not json')
  assert.deepEqual(createSettingsStore({ path }).get(), DEFAULT_SETTINGS)
})

test('GET answers the current values', async () => {
  const store = createSettingsStore({ path: tempPath() })
  const response = makeResponse()
  await handleSettingsRequest(makeRequest(), response, store)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, value: DEFAULT_SETTINGS })
})

test('POST merges the supplied fields', async () => {
  const store = createSettingsStore({ path: tempPath() })
  const response = makeResponse()
  await handleSettingsRequest(makeRequest({
    method: 'POST',
    body: { stopAtDeadline: false },
    headers: { host: '127.0.0.1:63005', origin: 'http://127.0.0.1:63005' },
  }), response, store)
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body).value, { waitTool: true, errorRecovery: true, stopAtDeadline: false, minRoundIntervalMs: 0, questionLimitAlways: false, questionLimitMs: 300000, keepAwake: 'ac-only' })
})

test('a cross-site write is refused', async () => {
  const store = createSettingsStore({ path: tempPath() })
  const response = makeResponse()
  await handleSettingsRequest(makeRequest({
    method: 'POST',
    body: { waitTool: false },
    headers: { host: '127.0.0.1:63005', origin: 'http://evil.example' },
  }), response, store)
  assert.equal(response.status, 403)
  assert.equal(store.get().waitTool, true)
})

test('a malformed body is refused without changing anything', async () => {
  const store = createSettingsStore({ path: tempPath() })
  const response = makeResponse()
  const request = Readable.from([Buffer.from('not json')])
  request.method = 'POST'
  request.headers = { host: 'h', origin: 'http://h' }
  await handleSettingsRequest(request, response, store)
  assert.equal(response.status, 400)
  assert.deepEqual(store.get(), DEFAULT_SETTINGS)
})

test('the route is registered as one exact host path', () => {
  const ctx = makeFakeContext()
  const store = createSettingsStore({ path: tempPath() })
  const release = registerSettingsRoute(ctx, ctx.webServer, store)
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].kind, 'exact')
  assert.equal(ctx.routes[0].path, SETTINGS_ROUTE_PATH)
  release()
  assert.equal(ctx.routes.length, 0)
  ctx.dispose()
})
