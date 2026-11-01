/**
 * 包根入口：整个插件只占插件管理器里的一行。
 *
 * 这一行同时做三件事：
 *  - 挂上宿主能力：core（/dont-stop 命令、轮次驱动、等待声明、软着陆）、retry（错误分级恢复）
 *    与 power（监督期间保持系统唤醒、睡醒后重算定时器）。
 *  - 把包根交给 Harness，让 @deepseek-ai/dsh-client-modules 通过这个包根行读到本包的
 *    dsh.client，从而把 client.js（Dont-Stop 状态条、设置界面里的设置页）装进界面。
 *  - 保持唤醒服务在这里创建一次：core 用它登记“监督进行中”，retry 用它获得系统恢复事件，
 *    设置页的改动对三者即时生效。
 */

import { apply as applyCore } from './core/index.js'
import { createSettingsStore } from './core/settings.js'
import { createKeepAwake } from './power/index.js'
import { apply as applyRetry } from './retry/index.js'
import { errorText, logInfo, logWarn } from './shared/util.js'

export const name = 'dont-stop'
export const inject = ['agents', 'commands', 'tools']

/**
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 这一行的配置。
 * @param {{settings?: ReturnType<typeof createSettingsStore>, power?: ReturnType<typeof createKeepAwake>}} [options] - 传入现成的设置存储与保持唤醒服务（测试用）。
 */
export function apply(ctx, config = {}, options = {}) {
  const settings = options.settings ?? createSettingsStore({
    onError: (error) => logWarn(ctx, `could not save the plugin settings: ${errorText(error)}`),
  })
  const power = options.power ?? createKeepAwake({
    settings,
    log: {
      info: (message) => logInfo(ctx, message),
      warn: (message) => logWarn(ctx, message),
    },
  })
  // 保持唤醒只是锦上添花：它自己出问题不能连累监督和错误恢复。
  ctx.effect(() => {
    try {
      return power.attach()
    } catch (error) {
      logWarn(ctx, `could not start the wake-lock service: ${errorText(error)}`)
      return () => {}
    }
  }, 'dont-stop power lifecycle')
  applyCore(ctx, config, { settings, power })
  applyRetry(ctx, config, { settings, power })
}
