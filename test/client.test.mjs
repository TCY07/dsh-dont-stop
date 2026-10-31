/**
 * 客户端半边的离线冒烟测试：按页面的模块加载方式求值 client.js，
 * 再用最小 React 桩调用一次组件，确认注册项和渲染内容都对。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 设置侧栏里的一行：只要够 client.js 认领图标用。 */
class FakeNavRow {
  constructor(text) {
    this.textContent = text
    this.attributes = new Map()
  }

  setAttribute(name, value) {
    this.attributes.set(name, value)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }
}

/** 用最小的 window/React/ctx 桩加载客户端模块，并把注册结果收集起来。 */
function loadClient(options = {}) {
  let definition
  const styleTags = []
  const rows = (options.navRows ?? []).map((text) => new FakeNavRow(text))
  const document = {
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: {},
    createElement: () => {
      const tag = { dataset: {}, textContent: '', remove() {} }
      return tag
    },
    querySelectorAll: (selector) => {
      if (selector === '[role="dialog"] nav button') return rows
      const attribute = selector.match(/^\[([\w-]+)\]$/)?.[1]
      return attribute === undefined ? [] : rows.filter((row) => row.attributes.has(attribute))
    },
  }
  const React = options.React ?? {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (callback) => callback,
  }
  const fetchCalls = []
  const window = {
    __ModuleLoader__: {
      load: (loaded) => {
        definition = loaded
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (url, init) => {
      fetchCalls.push({ url, init })
      if (typeof options.fetch === 'function') return options.fetch(url, init)
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { waitTool: true, stopAtDeadline: true, minRoundIntervalMs: 0 } }),
      }
    },
  }
  const context = { window, document, React, console }
  new Function('window', 'document', 'console', SOURCE)(window, document, console)
  assert.ok(definition, 'client.js must register a module definition')
  const dictionaries = new Map()
  const registrations = []
  const commands = []
  const ctx = {
    effect: (callback) => {
      callback()
      return () => {}
    },
    locale: {
      register: (ns, locale, dictionary) => {
        dictionaries.set(`${ns}/${locale}`, dictionary)
        return () => {}
      },
      bind: (ns) => (key) => dictionaries.get(`${ns}/zh`)?.[key] ?? key,
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    remote: {
      commands: {
        execute: async (...args) => {
          commands.push(args)
          return { ok: true, value: { result: { kind: 'success' } } }
        },
      },
    },
  }
  const plugin = definition.factory((name) => {
    assert.equal(name, 'react', 'the module may only require react')
    return React
  })
  plugin.apply(ctx)
  return { plugin, definition, registrations, dictionaries, commands, context, React, document, rows, styleTags, fetchCalls }
}

/** 按名字取出一个注册项。 */
const registrationFor = (registrations, name) => registrations.find((entry) => entry.options.name === name)

/** 在渲染结果里按条件找第一个节点。 */
const findNode = (node, predicate) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (node === null || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  return findNode(node.children, predicate)
}

/** 按文档顺序取出所有文字节点。 */
const leafTexts = (node, out = []) => {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) leafTexts(child, out)
    return out
  }
  if (node !== null && typeof node === 'object') leafTexts(node.children, out)
  return out
}

/** 按文档顺序取出所有满足条件的节点。 */
const nodesWhere = (node, predicate, out = []) => {
  if (Array.isArray(node)) {
    for (const child of node) nodesWhere(child, predicate, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  nodesWhere(node.children, predicate, out)
  return out
}

/**
 * 带状态与副作用的最小 React：挂载后执行一次 effect，setState 触发重渲染，
 * 用来验证靠异步数据才出现的界面（恢复条）。
 */
function makeHookReact() {
  const slots = []
  let cursor = 0
  let mounted = false
  const scheduled = []
  let renderCurrent = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        const next = typeof value === 'function' ? value(slots[index]) : value
        if (Object.is(next, slots[index])) return
        slots[index] = next
        renderCurrent?.()
      }
      return [slots[index], set]
    },
    useEffect(effect) {
      cursor += 1
      if (!mounted) scheduled.push(effect)
    },
    useCallback(callback) {
      cursor += 1
      return callback
    },
  }
  const render = (component, props) => {
    renderCurrent = () => {
      cursor = 0
      return component(props)
    }
    const tree = renderCurrent()
    if (!mounted) {
      mounted = true
      for (const effect of scheduled.splice(0)) effect()
    }
    return tree
  }
  return { React, render, current: () => renderCurrent() }
}

test('the client module is registered under the package name', () => {
  const { definition } = loadClient()
  assert.equal(definition.id, 'dsh-dont-stop')
})

test('the client module declares the remote service it calls', () => {
  const { plugin } = loadClient()
  // ctx.remote 本身要在 inject 里；只写 remote.commands 会在点“结束”时抛 without inject。
  assert.ok(plugin.inject.includes('remote'), 'the remote namespace itself must be injected')
  assert.ok(plugin.inject.includes('remote.commands'), 'the command namespace is injected too')
})

test('the dock entry, the settings page, dictionaries and styles are installed', () => {
  const { registrations, dictionaries } = loadClient()
  assert.deepEqual(registrations.map((entry) => entry.options.name).sort(), ['conversation.input.dock', 'conversation.input.dock', 'settings.section'])
  const recovery = registrations.find((entry) => entry.options.id === 'dont-stop-recovery')
  assert.ok(recovery, 'the recovery strip is its own dock entry')
  assert.equal(recovery.options.name, 'conversation.input.dock')
  const dock = registrationFor(registrations, 'conversation.input.dock')
  assert.equal(dock.options.id, 'dont-stop')
  assert.equal(typeof dock.options.order, 'number')
  const settings = registrationFor(registrations, 'settings.section')
  assert.equal(settings.options.id, 'dont-stop')
  assert.equal(typeof settings.options.order, 'number')
  assert.equal(settings.options.label(), 'Dont-Stop')
  assert.equal(dictionaries.get('dont-stop/zh')['action.stop'], '结束')
  assert.equal(dictionaries.get('dont-stop/en')['action.stop'], 'End')
  assert.deepEqual([...dictionaries.keys()].sort(), ['dont-stop/en', 'dont-stop/zh'])
})

test('the settings page renders every setting', () => {
  const { registrations, dictionaries } = loadClient()
  const settings = registrationFor(registrations, 'settings.section')
  const zh = dictionaries.get('dont-stop/zh')
  const tree = settings.component({ t: (key) => zh[key] ?? key })
  const text = JSON.stringify(tree)
  assert.match(text, /data-dont-stop-settings/)
  assert.match(text, /允许 agent 发起等待/)
  assert.match(text, /错误恢复/)
  assert.match(text, /到点停止/)
  assert.match(text, /提示间隔/)
  assert.match(text, /始终开启提问限时/)
  assert.match(text, /提问限时/)
  assert.match(text, /dsd_input/)
  // 组件以函数形式嵌在树里，按函数渲染一遍才能看它们的输出。
  const rendered = []
  const collect = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) collect(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.type === 'function') rendered.push(node.type({ ...node.props, children: node.children }))
    collect(node.children)
  }
  collect(tree)
  const switches = rendered.filter((node) => node?.props?.role === 'switch')
  assert.equal(switches.length, 4, 'one switch per boolean setting')
  for (const node of switches) {
    assert.match(node.props.className, /dsd_switch/)
    assert.equal(typeof node.props['aria-checked'], 'string')
  }
  const numbers = []
  const collectInputs = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) collectInputs(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (node.props?.type === 'number') numbers.push(node)
    collectInputs(node.children)
  }
  collectInputs(tree)
  assert.equal(numbers.length, 2, 'both durations take seconds')
  for (const node of numbers) {
    assert.equal(node.props.min, 0)
    assert.equal(node.props.max, 7200)
  }
})

test('a failed stop request falls back to the host force-stop', async () => {
  const { registrations, dictionaries, fetchCalls } = loadClient()
  const { options, component } = registrationFor(registrations, 'conversation.input.dock')
  const zh = dictionaries.get('dont-stop/zh')
  const deadlineAt = Date.now() + 3600000
  const tree = component({
    ...options.inject('session-9'),
    useProjection: () => ({ phase: 'supervising', startedAt: deadlineAt - 3600000, deadlineAt, rounds: 1 }),
    t: (key) => zh[key] ?? key,
    stop: async () => {
      throw new Error('command failed')
    },
  })
  const button = findNode(tree, (node) => node?.props?.className === 'dsd_action')
  assert.ok(button, 'the bar renders the stop button')
  await button.props.onClick()
  const post = fetchCalls.find((call) => call.url === '/dsh-dont-stop/recovery' && call.init?.method === 'POST')
  assert.ok(post, 'the fallback hits the host endpoint')
  assert.match(String(post.init.body), /"sessionId":"session-9"/)
  assert.match(String(post.init.body), /"action":"cancel"/)
})

test('the bar renders the remaining time and the stop button', () => {
  const { registrations, dictionaries } = loadClient()
  const { options, component } = registrationFor(registrations, 'conversation.input.dock')
  const zh = dictionaries.get('dont-stop/zh')
  const deadlineAt = Date.now() + 2 * 60 * 60 * 1000 + 13 * 60 * 1000
  const props = options.inject('session-1')
  const render = (projection) => component({
    ...props,
    useProjection: () => projection,
    t: (key) => zh[key] ?? key,
  })
  const tree = render({ phase: 'supervising', startedAt: deadlineAt - 3600000, deadlineAt, rounds: 3, stopAtDeadline: true })
  assert.ok(tree, 'a supervised session must render the bar')
  const text = JSON.stringify(tree)
  assert.match(text, /dont-stop-bar/)
  assert.match(text, /Dont-Stop 已激活/)
  assert.match(text, /剩余/)
  assert.match(text, /已督促 3 次/)
  assert.match(text, /到点停止/)
  assert.match(text, /结束/)
  assert.match(text, /dsd_action/)
  assert.ok(text.indexOf('截止') < text.indexOf('剩余'), 'the deadline comes before the remaining time')
  assert.equal((text.match(/"dsd_sep"/g) ?? []).length, 3, 'four parts, three separators')
  assert.match(text, /\|/, 'the separator is a vertical bar')
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(2, 0, 0, 0)
  const overnight = JSON.stringify(render({ phase: 'supervising', startedAt: Date.now(), deadlineAt: tomorrow.getTime(), rounds: 0 }))
  assert.match(overnight, /截止 \(\+1\) 02:00/, 'the day offset sits in parentheses before the clock')
  assert.match(JSON.stringify(render({ phase: 'supervising', startedAt: deadlineAt - 3600000, deadlineAt, rounds: 0, stopAtDeadline: false })), /到点继续/)
  const longRun = JSON.stringify(render({ phase: 'supervising', startedAt: Date.now(), deadlineAt: Date.now() + 50 * 3600000, rounds: 0 }))
  assert.match(longRun, /2 天/, 'multi-day deadlines show days')
  assert.doesNotMatch(JSON.stringify(render({ phase: 'supervising', startedAt: deadlineAt - 3600000, deadlineAt, rounds: 0 })), /到点(停止|继续)/, 'an old log without the field shows no mode')
})

test('the component owns the clock it counts down with', () => {
  const { registrations } = loadClient()
  const { options, component } = registrationFor(registrations, 'conversation.input.dock')
  assert.ok(component({ useProjection: () => undefined, t: (key) => key, ...options.inject('session-1') }) === null, 'an unsupervised session renders nothing')
  assert.ok(component({ useProjection: () => ({ phase: 'idle', startedAt: 0, deadlineAt: 0, rounds: 0 }), t: (key) => key, ...options.inject('session-1') }) === null, 'an idle projection renders nothing')
  assert.ok(component({ useProjection: () => ({ phase: 'supervising', startedAt: 1, deadlineAt: 2, rounds: 1 }), t: (key) => key, ...options.inject('session-1') }) === null, 'a passed deadline renders nothing')
})

test('the stop button runs the supervision command for its session', async () => {
  const { registrations, commands } = loadClient()
  const { options } = registrationFor(registrations, 'conversation.input.dock')
  const props = options.inject('session-42')
  const result = await props.stop()
  assert.deepEqual(commands, [['session-42', '/dont-stop stop', []]])
  assert.equal(result.ok, true)
})

/** 把树里的函数组件展开，收集所有 svg 节点。 */
function svgNodes(tree) {
  const found = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.type === 'function') walk(node.type({ ...node.props, children: node.children }))
    if (node.type === 'svg') found.push(node)
    walk(node.children)
  }
  walk(tree)
  return found
}

test('the bar and the settings page both show the plugin glyph', () => {
  const { registrations, dictionaries } = loadClient()
  const zh = dictionaries.get('dont-stop/zh')
  const t = (key) => zh[key] ?? key
  const dock = registrationFor(registrations, 'conversation.input.dock')
  const bar = dock.component({
    ...dock.options.inject('session-1'),
    useProjection: () => ({ phase: 'supervising', startedAt: Date.now(), deadlineAt: Date.now() + 3600000, rounds: 0 }),
    t,
  })
  const page = registrationFor(registrations, 'settings.section').component({ t })
  for (const tree of [bar, page]) {
    const nodes = svgNodes(tree)
    assert.equal(nodes.length, 1, 'exactly one glyph per view')
    assert.equal(nodes[0].props.className, 'dsd_glyph_svg')
    assert.equal(nodes[0].props['aria-hidden'], 'true', 'the mark is decorative next to the label')
    const json = JSON.stringify(nodes[0])
    assert.match(json, /url\(#dontStopInk\)/, 'the glyph is filled with the ink gradient')
    assert.match(json, /<path|"path"/)
  }
})

test('the settings nav row is claimed and wears the glyph mask', () => {
  const { rows, styleTags } = loadClient({ navRows: ['Dont-Stop', '通知'] })
  const [mine, other] = rows
  assert.equal(mine.attributes.has('data-dont-stop-nav-icon'), true, 'the row with our label is marked')
  assert.equal(other.attributes.has('data-dont-stop-nav-icon'), false, 'other rows are left alone')
  const css = styleTags.map((tag) => tag.textContent).join('\n')
  assert.match(css, /\[data-dont-stop-nav-icon\]>svg\{display:none\}/, 'the shell gear is hidden on the marked row')
  assert.match(css, /mask-image:url\("data:image\/svg\+xml/, 'the mark is drawn through a mask')
  assert.match(css, /background-color:currentColor/, 'the mask takes its colour from the row, so it follows the theme')
})

test('the recovery strip is wired to the host endpoint', () => {
  const { registrations, dictionaries } = loadClient()
  const recovery = registrations.find((entry) => entry.options.id === 'dont-stop-recovery')
  assert.equal(recovery.options.inject('session-7').sessionId, 'session-7', 'the strip polls per session')
  assert.match(SOURCE, /\/dsh-dont-stop\/recovery/, 'the status bar reads pending retries from the host')
  for (const locale of ['zh', 'en']) {
    const dictionary = dictionaries.get(`dont-stop/${locale}`)
    assert.match(dictionary['recovery.class'], /\{cls\}/)
    assert.match(dictionary['recovery.next'], /\{time\}/)
    assert.match(dictionary['recovery.attempt'], /\{n\}/)
    assert.equal(dictionary['recovery.retryNow'].length > 0, true)
    assert.equal(dictionary['recovery.dismiss'].length > 0, true)
    for (const cls of ['timeout', 'rate-limit', 'server', 'quota', 'transient']) {
      assert.equal(typeof dictionary[`status.class.${cls}`], 'string', `${locale} labels ${cls}`)
    }
  }
})

test('the recovery strip wears the glyph, separators and no hard frame', () => {
  const { styleTags, dictionaries } = loadClient()
  const css = styleTags.map((tag) => tag.textContent).join('\n')
  assert.match(css, /\.dsr_glyph\{[^}]*display:inline-flex/, 'the strip shows the plugin mark')
  assert.match(css, /\.dsr_sep\{/, 'the fields are separated by a rule')
  assert.doesNotMatch(css, /\.dsr_bar\{[^}]*border:1px/, 'the strip keeps the quiet panel frame of the status bar')
  assert.match(SOURCE, /className: 'dsr_glyph'/, 'the mark is rendered in the strip')
  assert.match(SOURCE, /className: 'dsr_sep'/, 'the separators are rendered in the strip')
  const zh = dictionaries.get('dont-stop/zh')
  assert.equal(zh['recovery.class'], '类型：{cls}')
  assert.equal(zh['status.class.transient'], '网络错误')
})

test('the recovery strip renders mark, label and fields in that order', async () => {
  const hooks = makeHookReact()
  const resumeAt = Date.now() + 22000
  const { registrations, dictionaries } = loadClient({
    React: hooks.React,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          recoveries: [{
            sessionId: 'session-7',
            cls: 'transient',
            attempt: 1,
            maxAttempts: 5,
            resumeAt,
            supervised: false,
            message: 'Connection error.',
          }],
        },
      }),
    }),
  })
  const zh = dictionaries.get('dont-stop/zh')
  const t = (key) => zh[key] ?? key
  const recovery = registrations.find((entry) => entry.options.id === 'dont-stop-recovery')
  hooks.render(recovery.component, { sessionId: 'session-7', t })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const tree = hooks.current()

  const marker = findNode(tree, (node) => typeof node.type === 'function')
  assert.equal(marker?.type?.name, 'Glyph', 'the strip shows the plugin mark next to the label')
  assert.equal(marker?.props?.size, 15, 'the mark is drawn at the same size as the status bar')
  assert.equal(nodesWhere(tree, (node) => node.props?.className === 'dsr_sep').length, 2)
  const texts = leafTexts(tree)
  assert.deepEqual(texts.slice(0, 5), ['错误恢复', '类型：网络错误', '|', '已重试 1 / 5 次', '|'])
  assert.match(texts[5], /^\d+ 秒后重试$/, 'the countdown says when the retry runs')
  assert.deepEqual(texts.slice(6), ['立即重试', '×'])
  const meta = nodesWhere(tree, (node) => node.props?.['data-dont-stop-recovery-class'] !== undefined)
  assert.equal(meta[0].props.title, 'Connection error.', 'the raw error stays available as a tooltip')
})

test('the in-app glyph and the package icon are one artwork', () => {
  const icon = readFileSync(new URL('../core/icon.svg', import.meta.url), 'utf8')
  const fromIcon = icon.match(/<path d="([^"]+)"/)?.[1]
  const fromClient = SOURCE.match(/const GLYPH_PATH = '([^']+)'/)?.[1]
  assert.ok(fromIcon, 'core/icon.svg draws one path')
  assert.ok(fromClient, 'client.js carries the same path')
  assert.equal(fromClient, fromIcon, 'the glyph must not drift from the package icon')
  assert.doesNotMatch(icon, /<rect/, 'the icon has no background tile')
})
