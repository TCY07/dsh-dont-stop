/**
 * 包根入口：整个插件只占插件管理器里的一行。
 *
 * 这一行同时做两件事：
 *  - 挂上宿主能力：core（/dont-stop 命令、轮次驱动、等待声明、软着陆）与 retry
 *    （错误分级恢复）。
 *  - 把包根交给 Harness，让 @deepseek-ai/dsh-client-modules 通过这个包根行读到本包的
 *    dsh.client，从而把 client.js（Dont-Stop 状态条、设置界面里的设置页）装进界面。
 *
 * 设置存储在这里创建一次，core 与 retry 共用同一份，界面上的改动对两边即时生效。
 */

import { apply as applyCore } from './core/index.js'
import { createSettingsStore } from './core/settings.js'
import { apply as applyRetry } from './retry/index.js'
import { errorText, logWarn } from './shared/util.js'

export const name = 'dont-stop'
export const inject = ['agents', 'commands', 'tools']

/**
 * @param {object} ctx - 插件上下文。
 * @param {object} [config] - 这一行的配置。
 * @param {{settings?: ReturnType<typeof createSettingsStore>}} [options] - 传入现成的设置存储（测试用）。
 */
export function apply(ctx, config = {}, options = {}) {
  const settings = options.settings ?? createSettingsStore({
    onError: (error) => logWarn(ctx, `could not save the plugin settings: ${errorText(error)}`),
  })
  applyCore(ctx, config, { settings })
  applyRetry(ctx, config, { settings })
}
