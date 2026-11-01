/**
 * 保持唤醒与监督的接线：监督开始/结束登记所有权、状态接口、睡醒后的重算与免计失败窗口。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { apply } from '../index.js'
import { makeFakeAgent, makeFakeContext, tick } from './fake-ctx.mjs'

// 设置文件走独立目录，别动本机的真实设置；跑完把这个目录删掉。
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-dont-stop-power-home-'))
process.env.DSH_HOME = TEST_HOME
after(() => rmSync(TEST_HOME, { recursive: true, force: true }))

/** 只记录调用、不碰系统电源的假保持唤醒服务。 */
function makeFakePower() {
  const holds = []
  const releases = []
  const listeners = new Set()
  return {
    holds,
    releases,
    attach: () => () => {},
    hold: (sessionId) => holds.push(sessionId),
    release: (sessionId) => releases.push(sessionId),
    releaseAll: () => {},
    diagnose: () => ({
      mode: 'ac-only',
      holding: holds.length > releases.length,
      backend: 'electron',
      reason: holds.length > releases.length ? 'holding' : 'idle',
    }),
    onResume(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    resume: (info) => {
      for (const listener of [...listeners]) listener(info ?? { at: Date.now(), suspendedMs: 120000 })
    },
  }
}

function setup(t, options = {}) {
  const agent = makeFakeAgent(options.id ?? 'power-session')
  const ctx = makeFakeContext({ agents: [agent] })
  const power = makeFakePower()
  apply(ctx, {}, { power })
  // 监督的截止时间定时器会拖住测试进程：每个用例结束时把插件行拆掉。
  t.after(() => ctx.dispose())
  const command = ctx.registeredCommands.find((entry) => entry.name === 'dont-stop')
  assert.ok(command, 'the command is registered')
  const run = (rawInput) => command.handler({ agent, rawInput, signal: new AbortController().signal, attachments: [] })
  return { agent, ctx, power, run }
}

const routeFor = (ctx, path) => ctx.routes.find((entry) => entry.path === path)

test('starting supervision holds the wake lock, ending it releases', async (t) => {
  const { agent, power, run } = setup(t, { id: 'power-hold' })
  run('2h')
  await tick(10)
  assert.deepEqual(power.holds, ['power-hold'])

  run('stop')
  await tick(10)
  assert.deepEqual(power.releases, ['power-hold'])
  assert.equal(agent.calls.followup.length >= 1, true)
})

test('the power endpoint reports the current keep-awake state', async (t) => {
  const { ctx, run } = setup(t, { id: 'power-route' })
  const route = routeFor(ctx, '/dsh-dont-stop/power')
  assert.ok(route, 'the power endpoint is registered with the settings and recovery ones')
  run('1h')
  await tick(5)
  let body = ''
  route.handler(
    { method: 'GET', headers: {} },
    {
      writeHead() {},
      end(payload) {
        body = String(payload ?? '')
      },
    },
  )
  const payload = JSON.parse(body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.backend, 'electron')
  assert.equal(payload.value.holding, true)
})

test('a resume re-arms the supervision round immediately', async (t) => {
  const { agent, power, run } = setup(t, { id: 'power-resume' })
  run('2h')
  await tick(10)
  const before = agent.calls.followup.length
  power.resume()
  await tick(10)
  assert.equal(agent.calls.followup.length, before + 1, 'a fresh round is injected instead of waiting for the old schedule')
})

test('a failure right after a resume is not counted as a failed round', async (t) => {
  const { agent, ctx, power, run } = setup(t, { id: 'power-resume-grace' })
  run('2h')
  await tick(10)
  power.resume()
  ctx.emit('agent/error', { agent, error: new Error('network reset') })
  await tick(5)
  assert.equal(
    ctx.logs.some(([, message]) => message.includes('not counted as a failed round')),
    true,
    'the suspend window suppresses the error backoff',
  )
})
