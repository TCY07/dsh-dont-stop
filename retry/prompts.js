/**
 * 回合级错误恢复发给模型的文字。
 *
 * 正文在仓库根的 prompts.json（`recovery` 一节），这里只补标签与错误摘要：
 * 一轮以错误结束、又没有监督在接管时，恢复会给会话重新开一轮：
 * 有 goal 的会话先重新武装 goal（不注入文字），没有 goal 的会话注入下面这条提示。
 * 提示里写明来源，避免模型把它当成人类的新指令。
 */

import { promptText } from '../core/prompts.js'
import { fillTemplate } from '../shared/util.js'

const MAX_MESSAGE_LENGTH = 160

/** 把错误压成一行，避免把整段堆栈塞进上下文。 */
function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH)
}

/**
 * @param {{cls: string, attempt: number, message?: string}} info - 错误类别、第几次恢复、原始错误文本。
 * @returns {string} 直接作为一条用户消息发出的提示。
 */
export function recoveryPrompt({ cls, attempt, message }) {
  const text = promptText().recovery
  return [
    `<dont_stop_recovery attempt="${attempt}" class="${cls}">`,
    fillTemplate(text.opening, { cls, message: oneLine(message) }),
    ...text.body,
    '</dont_stop_recovery>',
  ].join('\n')
}
