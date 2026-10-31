/**
 * 注入消息的唯一构造点。
 *
 * DSH 的会话日志校验要求 user/message 事件携带「有身份的消息」：`id`、`role`、
 * `source.kind`、`content` 缺一不可。早期版本只写 content/source，这样的记录在重新
 * 打开会话时会被判为损坏（"lacks an identified message"）。客户端也会按 kind + id
 * 归并会话节点，没有 id 时所有注入消息会挤进同一个节点。因此所有注入路径都必须走
 * 这里，不要在其他地方手拼消息对象。
 *
 * `extraSource` 是给界面/投影看的机器数据（比如 Dont-Stop 的截止时间）。它挂在
 * `source` 上而不是正文里：发给模型的只有 `content`，source 不参与模型输入，
 * 所以时间戳不会泄漏进模型上下文。
 */

import { randomUUID } from 'node:crypto'

export function userMessage(text, kind = 'dont-stop', extraSource = {}) {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text }],
    source: { kind, ...extraSource },
  }
}
