/**
 * 插件发给模型的全部文字：正文都在仓库根的 prompts.json，这里只负责读取、挑选和拼装。
 *
 * prompts.json 里的段落按实际使用顺序排列：开始 → 进行中 → 结束，改措辞只动那一个文件。
 * 取值按需读取：每次取用先看文件的修改时间与大小，变了才重读，所以改完措辞不用重载插件，
 * 下一条消息就用新文案。唯一的例外是 dont_stop_wait 的工具说明——它在插件加载、注册工具时固化。
 *
 * 标签（`<dont_stop_supervision>` / `<dont_stop_round>`）留在代码里：它们不是文案，
 * 界面投影靠 `kind` 与消息 `source.dontStop` 上的机器数据读状态，时间等数据不进正文。
 *
 * 措辞原则：对模型说的是“用户希望你持续工作”，而不是“你被监督”；
 * 不把截止时间、剩余时间写进正文：实测一旦给了时间预算，模型会高估任务耗时、
 * 挑更小的活来“用掉”这段时间。规模由任务本身决定，到点由收尾通知让它停下。
 */

import { readFileSync, statSync } from 'node:fs'

import { fillTemplate, formatClock } from '../shared/util.js'

const PROMPTS_URL = new URL('../prompts.json', import.meta.url)

let loadedStamp = null
let loadedText = null

/**
 * 模型文案；core 与 retry 两边的提示都从这里取。
 * 解析失败时保留上一份可用文案，下一次取用再试，避免写盘瞬间读到半个文件就整轮报错。
 * @returns {object} prompts.json 的内容。
 */
export function promptText() {
  let stamp
  try {
    const stat = statSync(PROMPTS_URL)
    stamp = `${stat.mtimeMs}:${stat.size}`
  } catch (error) {
    throw new Error(`dont-stop: could not stat prompts.json (${PROMPTS_URL.pathname}): ${error.message}`)
  }
  if (stamp === loadedStamp) return loadedText
  let text
  try {
    text = JSON.parse(readFileSync(PROMPTS_URL, 'utf8'))
  } catch (error) {
    if (loadedText) return loadedText
    throw new Error(`dont-stop: could not load prompts.json (${PROMPTS_URL.pathname}): ${error.message}`)
  }
  loadedText = text
  loadedStamp = stamp
  return loadedText
}

/**
 * 公告：正文包在开标签与闭标签之间，属性只放界面要用的枚举值，时间等数据放进 machine。
 * @returns {{text:string, machine:object}}
 */
function notice(text, attrs, machine) {
  const pairs = Object.entries(attrs).map(([name, value]) => ` ${name}="${value}"`).join('')
  return {
    text: [`<dont_stop_supervision${pairs}>`, text, '</dont_stop_supervision>'].join('\n'),
    machine,
  }
}

/* ───────────── 开始 ───────────── */

/** 开始监督的公告；等待工具被关掉时不提它（模型不该看到自己调不了的工具）。 */
export function supervisionNotice(state, options = {}) {
  const text = promptText().start
  const body = [...text.lines, ...(options.waitTool === false ? [] : [text.waitToolLine])].join('\n')
  const machine = { phase: 'start', startedAt: state.startedAt, deadlineAt: state.deadlineAt }
  // 到点是否强停：状态条要靠它显示本周期行为，模型看不到 machine。
  if (typeof options.stopAtDeadline === 'boolean') machine.stopAtDeadline = options.stopAtDeadline
  return notice(body, { kind: 'start' }, machine)
}

/* ───────────── 进行中 ───────────── */

/**
 * 每轮自主推进的提示。
 *
 * 这条消息总是在模型把手上的活干完、空闲下来时才投递，也就是“又一次提前结束”的时刻。
 * 正文只说要继续工作，不给截止时间或剩余时间，也不带过去轮次的统计。
 */
export function roundPrompt(state) {
  const text = promptText().round
  const completed = Math.max(state.rounds - 1, 0)
  // 正文由人维护，允许直接写 `{completed+1}`（已完成轮次 + 1 = 当前这轮）——模板不做算术。
  const opening = fillTemplate(text.opening.replace(/\{completed\+1\}/g, String(completed + 1)), {
    round: state.rounds,
    completed,
  })
  return [
    `<dont_stop_round round="${state.rounds}">`,
    opening,
    '',
    ...text.body,
    '</dont_stop_round>',
  ].join('\n')
}

/** dont_stop_wait 的工具说明；工具在插件加载时注册，改这段要重载插件。 */
export const WAIT_TOOL_DESCRIPTION = promptText().waitTool.join('')

/** 等人类回答超时后，要求模型自行决定。 */
export function humanTimeoutPrompt() {
  return promptText().humanTimeout
}

/* ───────────── 结束 ───────────── */

/** 结束公告；reason 决定说明里的理由与收尾说法。 */
export function endNotice(reason) {
  const text = promptText().end
  const why = text.reasons[reason] ?? text.reasons.deadline
  const closing = text.closing[reason] ?? text.closing.default
  const opening = fillTemplate(text.opening, { clock: formatClock(Date.now()), reason: why })
  return notice([opening, ...closing].join('\n'), { kind: 'end', reason }, { phase: 'end', reason })
}

/** 需要停止且回合正在跑时的收尾要求；只要求尽快结束手上这一步。 */
export function finishSteer() {
  return promptText().finishSteer
}
