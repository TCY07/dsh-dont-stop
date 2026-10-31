/**
 * 插件内共用的小工具：日志、可取消 sleep、时间格式化、配置合并、goal 引用。
 * 本文件只依赖标准 JS，不 import 任何 DSH 包。
 */

export const LOG_PREFIX = 'dont-stop'

export function logInfo(ctx, message) {
  try {
    ctx.logger.info(`${LOG_PREFIX}: ${message}`)
  } catch {
    /* 日志失败不能影响监听器 */
  }
}

export function logWarn(ctx, message) {
  try {
    ctx.logger.warn(`${LOG_PREFIX}: ${message}`)
  } catch {
    /* 同上 */
  }
}

export function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

const MAX_TIMEOUT = 2147483647

/**
 * 可取消等待。返回 true 表示等满了 delay，false 表示被 signal 取消。
 */
export function sleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(!signal?.aborted)
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(onTimeout, Math.min(ms, MAX_TIMEOUT))
    function cleanup() {
      try {
        signal?.removeEventListener('abort', onAbort)
      } catch {
        /* signal 已失效 */
      }
    }
    function onTimeout() {
      cleanup()
      resolve(!signal?.aborted)
    }
    function onAbort() {
      clearTimeout(timer)
      cleanup()
      resolve(false)
    }
    try {
      signal?.addEventListener('abort', onAbort, { once: true })
    } catch {
      /* 非标准 AbortSignal：退化为不可取消 */
    }
  })
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 浅层递归合并（只合并普通对象），用于把用户 config 叠到默认值上。 */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : value
  }
  return out
}

/** 把模板里的 `{name}` 换成 values 里的值；没给的占位符原样保留。 */
export function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole))
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.round(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`)
  if (parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}

export function formatClock(timestamp) {
  const date = new Date(timestamp)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function goalRef(goal) {
  return { id: goal.id, revision: goal.revision }
}

export function isLiveAgent(ctx, agent) {
  try {
    return ctx.agents.get(agent.id) === agent
  } catch {
    return false
  }
}
