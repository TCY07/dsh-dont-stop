/**
 * 回归测试：注入的消息必须带身份（id / role / source / content）。
 *
 * DSH 的会话日志校验会拒绝缺少身份的用户消息，旧版本插件曾因此写出无法再次
 * 打开的会话。这里锁住 shared/message.js 的契约，防止以后改动手拼消息对象。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { userMessage } from '../shared/message.js'

test('userMessage produces an identified user message', () => {
  const message = userMessage('hello')

  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.match(message.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(message.source, { kind: 'dont-stop' })
})

test('userMessage keeps an explicit source kind', () => {
  const message = userMessage('objective', 'user')

  assert.equal(message.source.kind, 'user')
})

test('each message carries a unique identity', () => {
  const ids = new Set()
  for (let index = 0; index < 100; index += 1) ids.add(userMessage(`text ${index}`).id)

  assert.equal(ids.size, 100)
})

test('userMessage is losslessly persistable as session event data', () => {
  const message = userMessage('persist me')
  const event = { type: 'user/message', seq: 0, time: 0, data: message, surfaceOp: 'append' }

  assert.deepEqual(JSON.parse(JSON.stringify(event)), event)
})
