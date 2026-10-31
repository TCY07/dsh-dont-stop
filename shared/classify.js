/**
 * 模型请求失败分类（纯函数）。
 * 类别决定等待阶梯与是否重试；opencode-go 路由拿不到 HTTP status/Retry-After，
 * 因此 code 与 message 文本两条线都要用。
 */

export const TRANSIENT = 'transient'
export const TIMEOUT = 'timeout'
export const RATE_LIMIT = 'rate-limit'
export const QUOTA = 'quota'
export const SERVER = 'server'
export const AUTH = 'auth'
export const CONTEXT = 'context'
export const UNKNOWN = 'unknown'

/** 回合级恢复等待阶梯（毫秒）：按类别递增，末档半小时。 */
export const DEFAULT_RECOVERY_DELAYS = {
  [RATE_LIMIT]: [60000, 300000, 900000, 1800000],
  [QUOTA]: [600000, 1200000, 2400000, 3600000, 5400000],
  [TIMEOUT]: [60000, 300000, 1800000],
  [TRANSIENT]: [30000, 300000, 1800000],
  [SERVER]: [60000, 300000, 1800000],
}

const CODE_CLASS = {
  EMPTY_RESPONSE: TRANSIENT,
  TRANSPORT: TRANSIENT,
  TIMEOUT: TIMEOUT,
  RATE_LIMIT: RATE_LIMIT,
  SERVER: SERVER,
  QUOTA: QUOTA,
  ACCOUNT_QUOTA: QUOTA,
  AUTH: AUTH,
  INVALID_CREDENTIAL: AUTH,
  MISSING_CREDENTIAL: AUTH,
  CONTEXT_WINDOW_EXCEEDED: CONTEXT,
  INVALID_REQUEST: UNKNOWN,
}

const QUOTA_TEXT = /usage limit|quota|insufficient balance|额度|限额|5\s*-?\s*hour|五小时|余额不足|exceeded your (current )?(plan|limit)/i
const AUTH_TEXT = /unauthorized|forbidden|invalid api key|invalid_api_key|api key|credential|authentication|401|403/i
const CONTEXT_TEXT = /context (window|length)|maximum context|too many tokens|prompt is too long|413/i
const RATE_TEXT = /rate[\s_-]?limit|too many requests|slow down|429/i
const SERVER_TEXT = /overloaded|internal server error|bad gateway|service unavailable|gateway timeout|502|503|504|5\d\d/i
// 请求超时（如 "Request timed out." / TIMEOUT）：单独一类，等待阶梯比普通抖动长。
const TIMEOUT_TEXT = /timed?\s*out|timeout|apiconnectiontimeout|econnaborted/i
const TRANSIENT_TEXT = /econnreset|econnrefused|etimedout|socket hang up|stream ended|network|fetch failed|aborted|empty response|terminated/i

function classifyText(message, status) {
  const text = String(message ?? '')
  if (QUOTA_TEXT.test(text)) return QUOTA
  if (AUTH_TEXT.test(text)) return AUTH
  if (CONTEXT_TEXT.test(text)) return CONTEXT
  if (RATE_TEXT.test(text)) return RATE_LIMIT
  if (SERVER_TEXT.test(text)) return SERVER
  if (TIMEOUT_TEXT.test(text)) return TIMEOUT
  if (TRANSIENT_TEXT.test(text)) return TRANSIENT
  if (Number.isFinite(status)) {
    if (status === 402) return QUOTA
    if (status === 401 || status === 403) return AUTH
    if (status === 413) return CONTEXT
    if (status === 429) return RATE_LIMIT
    if (status >= 500) return SERVER
  }
  return UNKNOWN
}

/** 分类一个 LlmFailure（agent/request-error 的 payload.failure）。 */
export function classifyFailure(failure) {
  if (!failure || typeof failure !== 'object') return UNKNOWN
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : ''
  if (code !== '') {
    const mapped = CODE_CLASS[code]
    if (mapped !== undefined) return mapped
    if (/^HTTP_5\d\d$/.test(code)) return SERVER
    if (code === 'HTTP_402') return QUOTA
    if (code === 'HTTP_429') return RATE_LIMIT
    if (code === 'HTTP_401' || code === 'HTTP_403') return AUTH
    if (code === 'HTTP_413') return CONTEXT
  }
  return classifyText(failure.message, Number(failure.status))
}

/** 分类一个 agent/error 抛出的错误对象（可能是 LlmError，也可能是普通 Error）。 */
export function classifyError(error) {
  if (!error || typeof error !== 'object') return classifyText(String(error))
  const failure = error.failure ?? error.cause?.failure
  if (failure && typeof failure === 'object') return classifyFailure(failure)
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : ''
  if (code !== '') {
    const mapped = CODE_CLASS[code]
    if (mapped !== undefined) return mapped
    if (/^HTTP_5\d\d$/.test(code)) return SERVER
    if (code === 'HTTP_429') return RATE_LIMIT
    if (code === 'HTTP_402') return QUOTA
  }
  return classifyText(error.message)
}
