/**
 * 插件自己的运行时设置，以及设置页读写它用的宿主 HTTP 接口。
 *
 * 这些设置与 Cordis config 分开存放：它们改完立即生效，不重载插件行，
 * 正在进行的那次监督不受影响。值存在 $DSH_HOME/storages/dont-stop/settings.json。
 *
 *   waitTool            是否注册 dont_stop_wait（让 agent 声明自己在等外部事情）
 *   errorRecovery       出错后是否按类别等待并恢复（关闭时按普通失败处理）
 *   stopAtDeadline      到点后是否要求任务停止（关闭时只结束监督，不催收尾、不强停）
 *   minRoundIntervalMs  两条监督消息之间的最短间隔
 *   questionLimitAlways 没在监督时也限制“提问”的等待时长
 *   questionLimitMs     等待用户回答提问的上限，0 表示不限
 *   keepAwake           监督期间是否阻止系统空闲睡眠：off / ac-only / always
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { normalizeKeepAwakeMode } from '../power/platform.js'
import { errorText, logWarn } from '../shared/util.js'

export const DEFAULT_SETTINGS = {
  waitTool: true,
  errorRecovery: true,
  stopAtDeadline: true,
  minRoundIntervalMs: 0,
  questionLimitAlways: false,
  questionLimitMs: 300000,
  keepAwake: 'ac-only',
}

/** 最短间隔的上限：两小时。 */
export const MAX_MIN_ROUND_INTERVAL_MS = 7200000

/** 提问限时的上限：两小时；0 表示不限。 */
export const MAX_QUESTION_LIMIT_MS = 7200000

/** 设置页读写的路径；精确注册在 webServer 上，页面同源请求。 */
export const SETTINGS_ROUTE_PATH = '/dsh-dont-stop/settings'

const MAX_BODY_BYTES = 4096

/** 设置文件路径：优先 DSH_HOME，没有就用 ~/.dsh。 */
export function defaultSettingsPath() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = configured === '' ? join(homedir(), '.dsh') : configured
  return join(home, 'storages', 'dont-stop', 'settings.json')
}

/**
 * 只接受已知字段的合法值：认不出来的退回默认值，两个时长夹在 0 到两小时之间。
 * @param {unknown} raw - 从文件或请求体读到的值。
 * @returns {{waitTool: boolean, errorRecovery: boolean, stopAtDeadline: boolean, minRoundIntervalMs: number, questionLimitAlways: boolean, questionLimitMs: number, keepAwake: 'off'|'ac-only'|'always'}}
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const interval = Number(source.minRoundIntervalMs)
  const questionLimit = Number(source.questionLimitMs)
  return {
    waitTool: typeof source.waitTool === 'boolean' ? source.waitTool : DEFAULT_SETTINGS.waitTool,
    errorRecovery: typeof source.errorRecovery === 'boolean' ? source.errorRecovery : DEFAULT_SETTINGS.errorRecovery,
    stopAtDeadline: typeof source.stopAtDeadline === 'boolean' ? source.stopAtDeadline : DEFAULT_SETTINGS.stopAtDeadline,
    minRoundIntervalMs: Number.isFinite(interval) && interval > 0
      ? Math.min(Math.round(interval), MAX_MIN_ROUND_INTERVAL_MS)
      : 0,
    questionLimitAlways: typeof source.questionLimitAlways === 'boolean'
      ? source.questionLimitAlways
      : DEFAULT_SETTINGS.questionLimitAlways,
    questionLimitMs: Number.isFinite(questionLimit)
      ? (questionLimit > 0 ? Math.min(Math.round(questionLimit), MAX_QUESTION_LIMIT_MS) : 0)
      : DEFAULT_SETTINGS.questionLimitMs,
    keepAwake: normalizeKeepAwakeMode(source.keepAwake),
  }
}

/**
 * 设置存储：启动时读文件，改一次写一次，并把新值推给订阅者。
 * @param {{path?: string, onError?: (error: unknown) => void}} options
 */
export function createSettingsStore({ path = defaultSettingsPath(), onError } = {}) {
  let value = { ...DEFAULT_SETTINGS }
  try {
    value = normalizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(path, 'utf8')) })
  } catch {
    // 文件不存在或内容坏了都退回默认值，不能因此挡住插件启动。
  }

  const listeners = new Set()

  function persist() {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
    } catch (error) {
      onError?.(error)
    }
  }

  return {
    path,
    get: () => value,
    /** 合并一部分字段；值真的变了才落盘并通知订阅者。 */
    update(patch) {
      const next = normalizeSettings({ ...value, ...(patch !== null && typeof patch === 'object' ? patch : {}) })
      const changed = next.waitTool !== value.waitTool
        || next.errorRecovery !== value.errorRecovery
        || next.stopAtDeadline !== value.stopAtDeadline
        || next.minRoundIntervalMs !== value.minRoundIntervalMs
        || next.questionLimitAlways !== value.questionLimitAlways
        || next.questionLimitMs !== value.questionLimitMs
        || next.keepAwake !== value.keepAwake
      value = next
      if (!changed) return value
      persist()
      for (const listener of [...listeners]) {
        try {
          listener(value)
        } catch (error) {
          onError?.(error)
        }
      }
      return value
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

function writeJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * 写操作只接受同源请求：页面自己发的一定同源，别的站点发来的 Origin 对不上。
 * 没有 Origin 的请求不是页面发的（桌面版的代理会剥掉它），放行。
 */
export function sameOrigin(request) {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** 读 JSON 请求体，超过上限就报错。 */
export function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body over ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * 处理一次设置请求：GET 读当前值，POST 合并一部分字段。
 * @param {object} request - Node IncomingMessage。
 * @param {object} response - Node ServerResponse。
 * @param {ReturnType<typeof createSettingsStore>} store
 */
export async function handleSettingsRequest(request, response, store) {
  const method = request.method ?? 'GET'
  if (method === 'GET') {
    writeJson(response, 200, { ok: true, value: store.get() })
    return
  }
  if (method !== 'POST') {
    response.writeHead(405, { allow: 'GET, POST' })
    response.end()
    return
  }
  if (!sameOrigin(request)) {
    writeJson(response, 403, { ok: false, error: 'untrusted origin' })
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(request))
  } catch (error) {
    writeJson(response, 400, { ok: false, error: `invalid JSON body: ${errorText(error)}` })
    return
  }
  writeJson(response, 200, { ok: true, value: store.update(body) })
}

/**
 * 把设置接口挂到宿主 HTTP 服务上；没有 webServer 的组成（比如纯 CLI）就直接跳过。
 * @returns {() => void} 注销函数。
 */
export function registerSettingsRoute(ctx, webServer, store) {
  if (!webServer || typeof webServer.register !== 'function') return () => {}
  try {
    return webServer.register({
      kind: 'exact',
      path: SETTINGS_ROUTE_PATH,
      handler: (request, response) => handleSettingsRequest(request, response, store),
    })
  } catch (error) {
    logWarn(ctx, `could not register the settings endpoint: ${errorText(error)}`)
    return () => {}
  }
}
