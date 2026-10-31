/**
 * 插件行的组成：整个插件只有包根这一行，宿主能力由它同时挂载 core 与 retry。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as rootPlugin from '../index.js'
import * as corePlugin from '../core/index.js'
import { apply as applyRetry } from '../retry/index.js'
import { makeFakeAgent, makeFakeContext } from './fake-ctx.mjs'

/** apply 只读 get()/subscribe()；写路径由设置页与设置存储的测试覆盖。 */
function settingsStub(value = { errorRecovery: true, minRoundIntervalMs: 0, waitTool: true, stopAtDeadline: true }) {
  return {
    get: () => value,
    subscribe: () => () => {},
  }
}

test('the bundle exposes one plugin entry', () => {
  assert.equal(typeof rootPlugin.apply, 'function')
  assert.equal(rootPlugin.name, 'dont-stop')
  assert.deepEqual([...rootPlugin.inject].sort(), ['agents', 'commands', 'tools'])
})

test('the root entry mounts supervision and error recovery together', () => {
  const agent = makeFakeAgent('entry-session')
  const ctx = makeFakeContext({ agents: [agent] })
  rootPlugin.apply(ctx, {}, { settings: settingsStub() })
  assert.equal(ctx.registeredCommands.filter((entry) => entry.name === 'dont-stop').length, 1, 'one /dont-stop command')
  assert.equal(ctx.registeredTools.filter((entry) => entry.name === 'dont_stop_wait').length, 1, 'one wait tool')
  assert.equal(ctx.listeners.get('agent/error')?.length, 2, 'core and retry both watch turn errors')
  assert.equal(ctx.listeners.get('agent/request-error'), undefined, 'the plugin no longer intercepts request errors')
  ctx.dispose()
  assert.equal(ctx.registeredCommands.length, 0, 'disposing the row unregisters its command')
  assert.equal(ctx.registeredTools.length, 0, 'disposing the row unregisters its tool')
})

test('the internal modules stay importable on their own', () => {
  assert.equal(typeof corePlugin.apply, 'function')
  assert.equal(typeof applyRetry, 'function')
})
