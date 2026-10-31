/**
 * 客户端半边：composer 上方的 Dont-Stop 状态条、设置界面里的插件设置页。
 *
 * 状态不在客户端自己算：宿主把 Dont-Stop 公告折叠成会话投影 dontStop（见 core/projection.js），
 * 这里只通过 useProjection 读取，倒计时用本地时钟推算。“结束 Dont-Stop”走 /dont-stop stop，
 * 和人在输入框里敲命令是同一条路径。
 *
 * 设置页读写宿主的 /dsh-dont-stop/settings：同一组与页面同源的 JSON 接口，
 * 值立即生效，不用重载插件行。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-dont-stop',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 客户端文案命名空间。 */
    const NS = 'dont-stop'
    /** 宿主侧的监督投影键。 */
    const PROJECTION_KEY = 'dontStop'
    /** 设置页读写宿主设置的路径，与 core/settings.js 里的常量一致。 */
    const SETTINGS_ENDPOINT = '/dsh-dont-stop/settings'
    /** 恢复等待的只读接口：请求级重试不落会话事件，状态条只能靠它显示“恢复中”。 */
    const RECOVERY_ENDPOINT = '/dsh-dont-stop/recovery'
    /** 轮询间隔：重试等待以分钟计，3 秒足够。 */
    const RECOVERY_POLL_MS = 3000
    /** 最短间隔的上限：两小时，与宿主侧一致。 */
    const MAX_INTERVAL_SECONDS = 7200
    /** 提问限时的上限：两小时，与宿主侧一致。 */
    const MAX_QUESTION_LIMIT_SECONDS = 7200
    /** 无限符号的轮廓：与 core/icon.svg 里同一条路径，由 tmp/tools/icon-build.mjs 生成。 */
    const GLYPH_PATH = 'M30.3 33.8L30.62 34.1L30.94 34.4L31.26 34.7L31.58 35L31.9 35.29L32.22 35.59L32.54 35.88L32.86 36.18L33.18 36.47L33.5 36.76L33.83 37.05L34.15 37.34L34.47 37.62L34.8 37.9L35.12 38.18L35.45 38.46L35.77 38.73L36.09 39L36.42 39.26L36.74 39.52L37.07 39.78L37.39 40.03L37.71 40.28L38.04 40.52L38.36 40.76L38.68 41L39.01 41.23L39.33 41.45L39.65 41.67L39.97 41.88L40.3 42.08L40.62 42.28L40.94 42.47L41.26 42.66L41.58 42.84L41.9 43.01L42.22 43.17L42.54 43.33L42.84 43.51L43.13 43.71L43.42 43.9L43.7 44.08L43.99 44.27L44.28 44.44L44.57 44.61L44.86 44.78L45.15 44.94L45.44 45.1L45.73 45.25L46.03 45.39L46.32 45.53L46.62 45.66L46.92 45.79L47.23 45.91L47.53 46.02L47.85 46.12L48.16 46.22L48.48 46.3L48.8 46.38L49.13 46.45L49.46 46.5L49.8 46.54L50.14 46.57L50.48 46.59L50.83 46.59L51.17 46.58L51.52 46.55L51.87 46.51L52.21 46.45L52.56 46.37L52.9 46.28L53.24 46.17L53.57 46.05L53.9 45.9L54.22 45.75L54.53 45.58L54.83 45.39L55.13 45.19L55.41 44.98L55.68 44.76L55.95 44.53L56.2 44.29L56.45 44.04L56.68 43.78L56.9 43.51L57.12 43.24L57.32 42.96L57.51 42.67L57.7 42.38L57.87 42.08L58.04 41.78L58.2 41.48L58.35 41.17L58.49 40.86L58.63 40.54L58.75 40.22L58.87 39.9L58.99 39.57L59.09 39.24L59.19 38.91L59.29 38.58L59.37 38.25L59.45 37.91L59.53 37.57L59.6 37.23L59.66 36.89L59.72 36.55L59.77 36.2L59.82 35.86L59.86 35.51L59.9 35.16L59.93 34.81L59.95 34.46L59.97 34.11L59.99 33.76L60 33.41L60 33.05L60 32.7L59.99 32.35L59.98 32L59.96 31.65L59.94 31.3L59.92 30.95L59.88 30.6L59.85 30.25L59.8 29.9L59.76 29.56L59.7 29.22L59.64 28.87L59.58 28.53L59.51 28.19L59.43 27.86L59.35 27.52L59.26 27.19L59.17 26.86L59.07 26.54L58.97 26.22L58.85 25.9L58.74 25.58L58.61 25.27L58.48 24.96L58.35 24.66L58.2 24.36L58.05 24.06L57.9 23.77L57.73 23.49L57.56 23.21L57.38 22.94L57.2 22.67L57.01 22.42L56.8 22.16L56.6 21.92L56.38 21.68L56.16 21.46L55.93 21.24L55.69 21.03L55.45 20.83L55.2 20.64L54.94 20.47L54.68 20.3L54.41 20.15L54.14 20.01L53.86 19.88L53.58 19.77L53.3 19.67L53.01 19.58L52.77 19.42L52.55 19.22L52.32 19.02L52.08 18.83L51.82 18.65L51.56 18.48L51.28 18.32L51 18.17L50.71 18.03L50.41 17.91L50.1 17.8L49.78 17.7L49.46 17.62L49.13 17.55L48.8 17.5L48.46 17.46L48.13 17.44L47.79 17.42L47.44 17.43L47.1 17.44L46.76 17.47L46.41 17.51L46.07 17.57L45.72 17.63L45.38 17.71L45.04 17.79L44.7 17.89L44.36 18L44.02 18.11L43.68 18.24L43.34 18.37L43 18.52L42.67 18.67L42.33 18.83L42 19L41.66 19.17L41.33 19.35L41 19.54L40.67 19.74L40.34 19.94L40.01 20.14L39.68 20.36L39.35 20.58L39.02 20.8L38.69 21.03L38.36 21.27L38.04 21.5L37.71 21.75L37.38 22L37.05 22.25L36.73 22.51L36.4 22.77L36.08 23.04L35.75 23.3L35.42 23.58L35.1 23.85L34.77 24.13L34.45 24.41L34.12 24.7L33.8 24.98L33.47 25.27L33.15 25.56L32.83 25.85L32.5 26.15L32.18 26.44L31.86 26.74L31.54 27.04L31.21 27.34L30.89 27.64L30.57 27.94L30.25 28.24L29.93 28.54L29.62 28.84L29.3 29.14L28.98 29.43L28.66 29.73L28.35 30.03L28.04 30.33L27.72 30.62L27.41 30.91L27.1 31.2L26.79 31.49L26.48 31.78L26.18 32.06L25.87 32.35L25.57 32.62L25.27 32.9L24.97 33.17L24.67 33.44L24.37 33.71L24.08 33.97L23.79 34.23L23.5 34.48L23.21 34.73L22.92 34.98L22.64 35.22L22.36 35.46L22.08 35.69L21.81 35.91L21.53 36.13L21.26 36.35L21 36.56L20.74 36.76L20.48 36.96L20.22 37.16L19.97 37.34L19.72 37.52L19.48 37.7L19.24 37.87L19 38.03L18.77 38.19L18.54 38.34L18.32 38.48L18.1 38.62L17.89 38.76L17.68 38.88L17.48 39L17.29 39.12L17.09 39.23L16.91 39.34L16.73 39.44L16.56 39.53L16.39 39.62L16.23 39.71L16.07 39.79L15.92 39.87L15.77 39.95L15.63 40.02L15.49 40.09L15.36 40.16L15.23 40.22L15.11 40.29L14.99 40.35L14.87 40.41L14.75 40.47L14.63 40.53L14.51 40.59L14.4 40.64L14.28 40.7L14.15 40.75L14.03 40.79L13.9 40.84L13.77 40.87L13.63 40.91L13.49 40.93L13.35 40.95L13.2 40.96L13.08 40.92L13.01 40.78L12.94 40.65L12.88 40.51L12.82 40.37L12.77 40.24L12.72 40.1L12.67 39.96L12.62 39.81L12.57 39.67L12.52 39.52L12.47 39.37L12.42 39.22L12.38 39.06L12.33 38.91L12.28 38.74L12.24 38.58L12.19 38.41L12.15 38.23L12.1 38.06L12.06 37.87L12.01 37.69L11.97 37.5L11.93 37.3L11.89 37.11L11.85 36.9L11.81 36.7L11.77 36.49L11.74 36.27L11.7 36.06L11.67 35.83L11.64 35.61L11.62 35.38L11.59 35.15L11.57 34.92L11.55 34.69L11.54 34.45L11.52 34.21L11.51 33.97L11.5 33.72L11.5 33.48L11.49 33.24L11.49 32.99L11.5 32.74L11.5 32.49L11.51 32.25L11.53 32L11.54 31.75L11.56 31.51L11.58 31.26L11.61 31.02L11.63 30.77L11.66 30.53L11.7 30.29L11.74 30.06L11.78 29.82L11.82 29.59L11.86 29.36L11.91 29.14L11.96 28.92L12.02 28.7L12.07 28.49L12.13 28.28L12.19 28.07L12.26 27.87L12.32 27.68L12.39 27.49L12.46 27.3L12.53 27.12L12.6 26.95L12.67 26.78L12.74 26.62L12.81 26.47L12.89 26.32L12.96 26.18L13.03 26.05L13.11 25.92L13.18 25.8L13.25 25.68L13.31 25.58L13.38 25.47L13.44 25.38L13.5 25.29L13.56 25.2L13.62 25.12L13.67 25.04L13.72 24.97L13.77 24.9L13.81 24.83L13.85 24.76L13.89 24.7L13.93 24.63L13.96 24.57L14 24.5L14.04 24.43L14.08 24.37L14.12 24.3L14.16 24.23L14.21 24.15L14.26 24.08L14.33 24.01L14.39 23.93L14.47 23.86L14.56 23.79L14.65 23.72L14.75 23.65L14.87 23.59L14.99 23.53L15.13 23.48L15.27 23.43L15.42 23.39L15.59 23.36L15.76 23.33L15.94 23.31L16.13 23.3L16.32 23.3L16.53 23.31L16.74 23.33L16.96 23.36L17.18 23.39L17.41 23.44L17.65 23.5L17.89 23.56L18.13 23.64L18.39 23.72L18.64 23.81L18.9 23.91L19.16 24.02L19.42 24.16L19.66 24.34L19.9 24.52L20.15 24.7L20.4 24.9L20.65 25.09L20.91 25.3L21.17 25.5L21.43 25.72L21.7 25.93L21.96 26.15L22.24 26.38L22.51 26.61L22.78 26.85L23.06 27.09L23.34 27.33L23.63 27.58L23.91 27.84L24.2 28.09L24.49 28.36L24.78 28.62L25.07 28.89L25.37 29.16L25.67 29.43L25.97 29.71L26.27 29.99L26.57 30.27L26.87 30.56L27.18 30.85L27.49 31.14L27.79 31.43L28.1 31.72L28.42 32.01L28.73 32.31L29.04 32.61L29.35 32.9L29.67 33.2L29.98 33.5L33.38 29.9L33.06 29.6L32.74 29.3L32.42 29L32.1 28.71L31.78 28.41L31.46 28.12L31.14 27.82L30.82 27.53L30.5 27.24L30.17 26.95L29.85 26.66L29.53 26.38L29.2 26.1L28.88 25.82L28.55 25.54L28.23 25.27L27.91 25L27.58 24.74L27.26 24.48L26.93 24.22L26.61 23.97L26.29 23.72L25.96 23.48L25.64 23.24L25.32 23L24.99 22.77L24.67 22.55L24.35 22.33L24.03 22.12L23.7 21.92L23.38 21.72L23.06 21.53L22.74 21.34L22.42 21.16L22.1 20.99L21.78 20.83L21.46 20.67L21.16 20.49L20.87 20.29L20.58 20.1L20.3 19.92L20.01 19.73L19.72 19.56L19.43 19.39L19.14 19.22L18.85 19.06L18.56 18.9L18.27 18.75L17.97 18.61L17.68 18.47L17.38 18.34L17.08 18.21L16.77 18.09L16.47 17.98L16.15 17.88L15.84 17.78L15.52 17.7L15.2 17.62L14.87 17.55L14.54 17.5L14.2 17.46L13.86 17.43L13.52 17.41L13.17 17.41L12.83 17.42L12.48 17.45L12.13 17.49L11.79 17.55L11.44 17.63L11.1 17.72L10.76 17.83L10.43 17.95L10.1 18.1L9.78 18.25L9.47 18.42L9.17 18.61L8.87 18.81L8.59 19.02L8.32 19.24L8.05 19.47L7.8 19.71L7.55 19.96L7.32 20.22L7.1 20.49L6.88 20.76L6.68 21.04L6.49 21.33L6.3 21.62L6.13 21.92L5.96 22.22L5.8 22.52L5.65 22.83L5.51 23.14L5.37 23.46L5.25 23.78L5.13 24.1L5.01 24.43L4.91 24.76L4.81 25.09L4.71 25.42L4.63 25.75L4.55 26.09L4.47 26.43L4.4 26.77L4.34 27.11L4.28 27.45L4.23 27.8L4.18 28.14L4.14 28.49L4.1 28.84L4.07 29.19L4.05 29.54L4.03 29.89L4.01 30.24L4 30.59L4 30.95L4 31.3L4.01 31.65L4.02 32L4.04 32.35L4.06 32.7L4.08 33.05L4.12 33.4L4.15 33.75L4.2 34.1L4.24 34.44L4.3 34.78L4.36 35.13L4.42 35.47L4.49 35.81L4.57 36.14L4.65 36.48L4.74 36.81L4.83 37.14L4.93 37.46L5.03 37.78L5.15 38.1L5.26 38.42L5.39 38.73L5.52 39.04L5.65 39.34L5.8 39.64L5.95 39.94L6.1 40.23L6.27 40.51L6.44 40.79L6.62 41.06L6.8 41.33L6.99 41.58L7.2 41.84L7.4 42.08L7.62 42.32L7.84 42.54L8.07 42.76L8.31 42.97L8.55 43.17L8.8 43.36L9.06 43.53L9.32 43.7L9.59 43.85L9.86 43.99L10.14 44.12L10.42 44.23L10.7 44.33L10.99 44.42L11.23 44.58L11.45 44.78L11.68 44.98L11.92 45.17L12.18 45.35L12.44 45.52L12.72 45.68L13 45.83L13.29 45.97L13.59 46.09L13.9 46.2L14.22 46.3L14.54 46.38L14.87 46.45L15.2 46.5L15.54 46.54L15.87 46.56L16.21 46.58L16.56 46.57L16.9 46.56L17.24 46.53L17.59 46.49L17.93 46.43L18.28 46.37L18.62 46.29L18.96 46.21L19.3 46.11L19.64 46L19.98 45.89L20.32 45.76L20.66 45.63L21 45.48L21.33 45.33L21.67 45.17L22 45L22.34 44.83L22.67 44.65L23 44.46L23.33 44.26L23.66 44.06L23.99 43.86L24.32 43.64L24.65 43.42L24.98 43.2L25.31 42.97L25.64 42.73L25.96 42.5L26.29 42.25L26.62 42L26.95 41.75L27.27 41.49L27.6 41.23L27.92 40.96L28.25 40.7L28.58 40.42L28.9 40.15L29.23 39.87L29.55 39.59L29.88 39.3L30.2 39.02L30.53 38.73L30.85 38.44L31.17 38.15L31.5 37.85L31.82 37.56L32.14 37.26L32.46 36.96L32.79 36.66L33.11 36.36L33.43 36.06L33.75 35.76L34.07 35.46L34.38 35.16L34.7 34.86L35.02 34.57L35.34 34.27L35.65 33.97L35.96 33.67L36.28 33.38L36.59 33.09L36.9 32.8L37.21 32.51L37.52 32.22L37.82 31.94L38.13 31.65L38.43 31.38L38.73 31.1L39.03 30.83L39.33 30.56L39.63 30.29L39.92 30.03L40.21 29.77L40.5 29.52L40.79 29.27L41.08 29.02L41.36 28.78L41.64 28.54L41.92 28.31L42.19 28.09L42.47 27.87L42.74 27.65L43 27.44L43.26 27.24L43.52 27.04L43.78 26.84L44.03 26.66L44.28 26.48L44.52 26.3L44.76 26.13L45 25.97L45.23 25.81L45.46 25.66L45.68 25.52L45.9 25.38L46.11 25.24L46.32 25.12L46.52 25L46.71 24.88L46.91 24.77L47.09 24.66L47.27 24.56L47.44 24.47L47.61 24.38L47.77 24.29L47.93 24.21L48.08 24.13L48.23 24.05L48.37 23.98L48.51 23.91L48.64 23.84L48.77 23.78L48.89 23.71L49.01 23.65L49.13 23.59L49.25 23.53L49.37 23.47L49.49 23.41L49.6 23.36L49.72 23.3L49.85 23.25L49.97 23.21L50.1 23.16L50.23 23.13L50.37 23.09L50.51 23.07L50.65 23.05L50.8 23.04L50.92 23.08L50.99 23.22L51.06 23.35L51.12 23.49L51.18 23.63L51.23 23.76L51.28 23.9L51.33 24.04L51.38 24.19L51.43 24.33L51.48 24.48L51.53 24.63L51.58 24.78L51.62 24.94L51.67 25.09L51.72 25.26L51.76 25.42L51.81 25.59L51.85 25.77L51.9 25.94L51.94 26.13L51.99 26.31L52.03 26.5L52.07 26.7L52.11 26.89L52.15 27.1L52.19 27.3L52.23 27.51L52.26 27.73L52.3 27.94L52.33 28.17L52.36 28.39L52.38 28.62L52.41 28.85L52.43 29.08L52.45 29.31L52.46 29.55L52.48 29.79L52.49 30.03L52.5 30.28L52.5 30.52L52.51 30.76L52.51 31.01L52.5 31.26L52.5 31.51L52.49 31.75L52.47 32L52.46 32.25L52.44 32.49L52.42 32.74L52.39 32.98L52.37 33.23L52.34 33.47L52.3 33.71L52.26 33.94L52.22 34.18L52.18 34.41L52.14 34.64L52.09 34.86L52.04 35.08L51.98 35.3L51.93 35.51L51.87 35.72L51.81 35.93L51.74 36.13L51.68 36.32L51.61 36.51L51.54 36.7L51.47 36.88L51.4 37.05L51.33 37.22L51.26 37.38L51.19 37.53L51.11 37.68L51.04 37.82L50.97 37.95L50.89 38.08L50.82 38.2L50.75 38.32L50.69 38.42L50.62 38.53L50.56 38.62L50.5 38.71L50.44 38.8L50.38 38.88L50.33 38.96L50.28 39.03L50.23 39.1L50.19 39.17L50.15 39.24L50.11 39.3L50.07 39.37L50.04 39.43L50 39.5L49.96 39.57L49.92 39.63L49.88 39.7L49.84 39.77L49.79 39.85L49.74 39.92L49.67 39.99L49.61 40.07L49.53 40.14L49.44 40.21L49.35 40.28L49.25 40.35L49.13 40.41L49.01 40.47L48.87 40.52L48.73 40.57L48.58 40.61L48.41 40.64L48.24 40.67L48.06 40.69L47.87 40.7L47.68 40.7L47.47 40.69L47.26 40.67L47.04 40.64L46.82 40.61L46.59 40.56L46.35 40.5L46.11 40.44L45.87 40.36L45.61 40.28L45.36 40.19L45.1 40.09L44.84 39.98L44.58 39.84L44.34 39.66L44.1 39.48L43.85 39.3L43.6 39.1L43.35 38.91L43.09 38.7L42.83 38.5L42.57 38.28L42.3 38.07L42.04 37.85L41.76 37.62L41.49 37.39L41.22 37.15L40.94 36.91L40.66 36.67L40.37 36.42L40.09 36.16L39.8 35.91L39.51 35.64L39.22 35.38L38.93 35.11L38.63 34.84L38.33 34.57L38.03 34.29L37.73 34.01L37.43 33.73L37.13 33.44L36.82 33.15L36.51 32.86L36.21 32.57L35.9 32.28L35.58 31.99L35.27 31.69L34.96 31.39L34.65 31.1L34.33 30.8L34.02 30.5L33.7 30.2Z'
    /** 界面里那枚标志用的是同一套墨色渐变。 */
    const GLYPH_GRADIENT = 'dontStopInk'
    /** 设置侧栏那一行由插件自己认领：壳层只按内置 id 给图标，其余一律给默认齿轮。 */
    const NAV_ICON_MARKER = 'data-dont-stop-nav-icon'
    /** 壳层把每个 settings.section 渲染成设置对话框里 nav 下的一个 button。 */
    const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

    const zh = {
      'status.supervising': 'Dont-Stop 已激活',
      'status.remaining': '剩余 {time}',
      'status.rounds': '已督促 {n} 次',
      'status.until': '截止 {time}',
      'status.stopAtDeadline': '到点停止',
      'status.keepAfterDeadline': '到点继续',
      'recovery.title': '错误恢复',
      'recovery.class': '类型：{cls}',
      'recovery.attempt': '已重试 {n} / {max} 次',
      'recovery.next': '{time}后重试',
      'recovery.imminent': '即将重试',
      'recovery.retryNow': '立即重试',
      'recovery.dismiss': '放弃重试',
      'recovery.failed': '操作失败：{message}',
      'status.class.timeout': '请求超时',
      'status.class.rate-limit': '被限流',
      'status.class.server': '服务端错误',
      'status.class.quota': '额度不足',
      'status.class.transient': '网络错误',
      'duration.underMinute': '不到 1 分钟',
      'duration.seconds': '{s} 秒',
      'duration.now': '马上',
      'duration.days': '{d} 天',
      'duration.hours': '{h} 小时',
      'duration.minutes': '{m} 分',
      'action.stop': '结束',
      'action.stopping': '正在结束',
      'settings.nav': 'Dont-Stop',
      'settings.title': 'Dont-Stop',
      'settings.description': 'Dont-Stop 插件相关设置。',
      'settings.loading': '正在读取设置…',
      'settings.waitTool.label': '允许 agent 发起等待',
      'settings.waitTool.description': '开启后 agent 可以调用工具让 Dont-Stop 在等待期间不督促其继续工作，适用于 agent 需要等待外部资源/定时任务的情况。',
      'settings.errorRecovery.label': '错误恢复',
      'settings.errorRecovery.description': '遇到限流、5小时额度不足、网络、服务商错误时尝试自动恢复，在非 Dont-Stop 状态下也生效。',
      'settings.stopAtDeadline.label': '到点停止',
      'settings.stopAtDeadline.description': '开启后，到点会通知 agent 结束任务并停掉回合；关闭后到点只结束 Dont-Stop，任务继续运行。单个周期的命令里可用 --stop / --no-stop 临时覆盖。',
      'settings.minInterval.label': '提示间隔',
      'settings.minInterval.description': '两条 Dont-Stop 督促消息之间的最短时间间隔；0 表示不限。',
      'settings.minInterval.unit': '秒',
      'settings.invalidInterval': '间隔要填 0 到 7200 之间的秒数。',
      'settings.questionLimitAlways.label': '始终开启提问限时',
      'settings.questionLimitAlways.description': '开启后，即使 Dont-Stop 未激活，也会限制「提问」的等待时长，避免工作卡在「提问」环节。',
      'settings.questionLimit.label': '提问限时',
      'settings.questionLimit.description': '等待用户回答提问的最长时间；超时后关闭提问并要求 agent 自行决定。0 表示不限。',
      'settings.questionLimit.unit': '秒',
      'settings.invalidQuestionLimit': '提问限时要填 0 到 7200 之间的秒数。',
      'settings.saveFailed': '保存失败：{message}',
    }

    const en = {
      'status.supervising': 'Dont-Stop active',
      'status.remaining': '{time} left',
      'status.rounds': 'nudged {n}×',
      'status.until': 'until {time}',
      'status.stopAtDeadline': 'stops at deadline',
      'status.keepAfterDeadline': 'keeps working after',
      'recovery.title': 'Recovering',
      'recovery.class': 'Type: {cls}',
      'recovery.attempt': 'attempt {n} / {max}',
      'recovery.next': 'retrying in {time}',
      'recovery.imminent': 'retrying now',
      'recovery.retryNow': 'Retry now',
      'recovery.dismiss': 'Stop retrying',
      'recovery.failed': 'Action failed: {message}',
      'status.class.timeout': 'Request timed out',
      'status.class.rate-limit': 'Rate limited',
      'status.class.server': 'Server error',
      'status.class.quota': 'Quota exhausted',
      'status.class.transient': 'Network error',
      'duration.underMinute': 'under a minute',
      'duration.seconds': '{s}s',
      'duration.now': 'now',
      'duration.days': '{d}d',
      'duration.hours': '{h}h',
      'duration.minutes': '{m}m',
      'action.stop': 'End',
      'action.stopping': 'Ending',
      'settings.nav': 'Dont-Stop',
      'settings.title': 'Dont-Stop',
      'settings.description': 'Settings for the Dont-Stop plugin.',
      'settings.loading': 'Reading the settings…',
      'settings.waitTool.label': 'Let the agent declare a wait',
      'settings.waitTool.description': 'When on, the agent can call a tool that keeps Dont-Stop from nudging it while it waits; meant for waits on an external resource or a scheduled task.',
      'settings.errorRecovery.label': 'Error recovery',
      'settings.errorRecovery.description': 'Tries to recover automatically from rate limits, exhausted 5-hour quota, network and provider errors; also applies outside Dont-Stop sessions.',
      'settings.stopAtDeadline.label': 'Stop at the deadline',
      'settings.stopAtDeadline.description': 'When on, the deadline tells the agent to finish and stops the turn; when off, Dont-Stop just ends and the task keeps running. Override one cycle with --stop / --no-stop on the command.',
      'settings.minInterval.label': 'Prompt interval',
      'settings.minInterval.description': 'Shortest gap between two Dont-Stop nudges; 0 means no limit.',
      'settings.minInterval.unit': 's',
      'settings.invalidInterval': 'Enter a number of seconds between 0 and 7200.',
      'settings.questionLimitAlways.label': 'Always limit question waits',
      'settings.questionLimitAlways.description': 'When on, question waits are limited even while Dont-Stop is not active, so work never stalls on a question.',
      'settings.questionLimit.label': 'Question wait limit',
      'settings.questionLimit.description': 'Longest wait for the user to answer a question; after that the question is closed and the agent decides on its own. 0 means no limit.',
      'settings.questionLimit.unit': 's',
      'settings.invalidQuestionLimit': 'Enter a number of seconds between 0 and 7200.',
      'settings.saveFailed': 'Could not save: {message}',
    }

    /** 无限符号的遮罩图：遮罩只读 alpha，颜色由 currentColor 决定，跟随主题。 */
    function glyphMaskUrl() {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="#000"><path d="${GLYPH_PATH}"/></svg>`
      return `data:image/svg+xml,${encodeURIComponent(svg)}`
    }

    /**
     * 设置侧栏那一行：盖住壳层的默认齿轮，用遮罩画出无限符号。
     * 尺寸按其他行图标的 16px；符号本身横长，宽度铺满、高度居中。
     */
    const NAV_ICON_CSS = [
      `[${NAV_ICON_MARKER}]>svg{display:none}`,
      `[${NAV_ICON_MARKER}]::before{content:'';flex:none;width:16px;height:16px;background-color:currentColor;` +
        `-webkit-mask-image:url("${glyphMaskUrl()}");mask-image:url("${glyphMaskUrl()}");` +
        `-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;` +
        `-webkit-mask-position:center;mask-position:center;` +
        `-webkit-mask-size:16px 16px;mask-size:16px 16px}`,
    ].join('')

    const CSS = [
      '.dsd_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto}',
      '.dsd_bar{isolation:isolate;box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);height:36px;box-shadow:var(--dsw-elevation-panel);border:0;align-items:center;gap:10px;margin:0 auto;padding:4px 5px 4px 12px;display:flex;position:relative}',
      '.dsd_bar:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}',
      '.dsd_glyph{flex:none;align-items:center;display:inline-flex}',
      '.dsd_glyph_svg{display:block}',
      '.dsd_glyph .dsd_glyph_svg{animation:dsd_pulse 2s ease-in-out infinite}',
      '@keyframes dsd_pulse{0%,100%{opacity:1}50%{opacity:.55}}',
      '.dsd_label{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}',
      '.dsd_meta{min-width:0;color:var(--dsw-alias-label-primary-dimmed);white-space:nowrap;font-size:13px;line-height:20px}',
      '.dsd_sep{flex:none;color:var(--dsw-alias-label-primary-dimmed);opacity:.45;font-size:12px;line-height:20px}',
      '.dsd_actions{margin-left:auto;flex:none;align-items:center;display:flex}',
      '.dsd_action{height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:0 12px}',
      '.dsd_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsd_action:disabled{opacity:.5;cursor:default}',
      '.dsd_page{display:flex;flex-direction:column;gap:16px}',
      '.dsd_page_heading{align-items:center;gap:10px;display:flex}',
      '.dsd_page_glyph{flex:none;align-items:center;display:inline-flex}',
      '.dsd_page_title{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:24px}',
      '.dsd_page_desc{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin-top:6px}',
      '.dsd_rows{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);overflow:hidden;display:flex;flex-direction:column}',
      '.dsd_row{background:var(--dsw-alias-bg-layer-1);align-items:center;gap:16px;padding:14px 16px;display:flex}',
      '.dsd_row+.dsd_row{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsd_row_text{flex:1;flex-direction:column;gap:4px;min-width:0;display:flex}',
      '.dsd_row_label{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}',
      '.dsd_row_desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsd_row_control{flex:none;align-items:center;gap:8px;display:flex}',
      '.dsd_switch{width:36px;height:20px;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;position:relative;transition:background .15s}',
      '.dsd_switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dsd_switch:disabled{opacity:.5;cursor:default}',
      '.dsd_knob{width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-base);display:block;position:absolute;top:2px;left:2px;transition:transform .15s}',
      '.dsd_switch[aria-checked="true"] .dsd_knob{transform:translateX(16px)}',
      '.dsd_input{width:72px;height:28px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;padding:0 8px}',
      '.dsd_input:disabled{opacity:.5}',
      '.dsd_unit{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsd_note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsd_page_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      // 恢复条：单独一行，样式与 Dont-Stop 状态条同构，但用品牌色标出“正在等待重试”。
      '.dsr_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto}',
      '.dsr_bar{isolation:isolate;box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);height:36px;box-shadow:var(--dsw-elevation-panel);border:0;align-items:center;gap:10px;margin:0 auto;padding:4px 5px 4px 12px;display:flex;position:relative}',
      '.dsr_bar:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}',
      '.dsr_glyph{flex:none;align-items:center;display:inline-flex}',
      '.dsr_label{color:var(--dsw-alias-brand-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}',
      '.dsr_meta{min-width:0;color:var(--dsw-alias-label-primary-dimmed);white-space:nowrap;font-size:13px;line-height:20px}',
      '.dsr_sep{flex:none;color:var(--dsw-alias-label-primary-dimmed);opacity:.45;font-size:12px;line-height:20px}',
      '.dsr_error{min-width:0;color:var(--dsw-alias-state-error-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;line-height:20px;overflow:hidden}',
      '.dsr_actions{margin-left:auto;flex:none;align-items:center;gap:6px;display:flex}',
      '.dsr_action{height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1;padding:0 12px}',
      '.dsr_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsr_action:disabled{opacity:.5;cursor:default}',
      '.dsr_close{width:26px;height:26px;border:1px solid transparent;border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:0}',
      '.dsr_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsr_close:disabled{opacity:.5;cursor:default}',
    ].join('') + NAV_ICON_CSS

    /** 用参数替换字典里的 `{name}` 占位符；没有参数的翻译直接返回原文。 */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? params[name] : match))
    }

    /** 本地 24 小时时钟，例如 22:05；跨到明天、后天写成 (+1) 22:05、(+2) 09:30。 */
    function formatClock(at) {
      const date = new Date(at)
      const now = new Date()
      const midnight = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
      const daysAhead = Math.round((midnight(date) - midnight(now)) / 86400000)
      const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      return daysAhead > 0 ? `(+${daysAhead}) ${clock}` : clock
    }

    /** 剩余时间，粒度到分钟：2 天 2 小时、2 小时 13 分。 */
    function formatDuration(ms, t) {
      const totalMinutes = Math.ceil(ms / 60000)
      if (totalMinutes <= 0) return t('duration.underMinute')
      const minutesPerDay = 1440
      const days = Math.floor(totalMinutes / minutesPerDay)
      const restMinutes = totalMinutes % minutesPerDay
      const hours = Math.floor(restMinutes / 60)
      const minutes = restMinutes % 60
      if (days > 0) {
        const head = fill(t('duration.days'), { d: String(days) })
        return hours === 0 ? head : `${head} ${fill(t('duration.hours'), { h: String(hours) })}`
      }
      if (hours === 0) return fill(t('duration.minutes'), { m: String(minutes) })
      const head = fill(t('duration.hours'), { h: String(hours) })
      return minutes === 0 ? head : `${head} ${fill(t('duration.minutes'), { m: String(minutes) })}`
    }

    /** 恢复等待的短写法：不到一分钟按秒说，否则沿用分钟粒度。 */
    function formatWait(ms, t) {
      if (ms <= 1000) return t('duration.now')
      if (ms < 60000) return fill(t('duration.seconds'), { s: String(Math.ceil(ms / 1000)) })
      return formatDuration(ms, t)
    }

    /** 错误类别的人话名字；认不出的类别直接显示类名。 */
    function classLabel(cls, t) {
      const key = `status.class.${cls}`
      const label = t(key)
      return label === key ? String(cls) : label
    }

    /** 宿主设置的安全副本：字段类型不对就用默认值，两个时长夹在允许范围内。 */
    function normalizeSettings(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const interval = Number(source.minRoundIntervalMs)
      const questionLimit = Number(source.questionLimitMs)
      return {
        waitTool: typeof source.waitTool === 'boolean' ? source.waitTool : true,
        errorRecovery: typeof source.errorRecovery === 'boolean' ? source.errorRecovery : true,
        stopAtDeadline: typeof source.stopAtDeadline === 'boolean' ? source.stopAtDeadline : true,
        minRoundIntervalMs: Number.isFinite(interval) && interval > 0
          ? Math.min(Math.round(interval), MAX_INTERVAL_SECONDS * 1000)
          : 0,
        questionLimitAlways: typeof source.questionLimitAlways === 'boolean' ? source.questionLimitAlways : false,
        questionLimitMs: Number.isFinite(questionLimit) && questionLimit > 0
          ? Math.min(Math.round(questionLimit), MAX_QUESTION_LIMIT_SECONDS * 1000)
          : 0,
      }
    }

    /** 设置页的中文/英文翻译兜底：注册时若没拿到 t 就用这里。 */
    let translate = (key) => key

    /** 插件标志：透明底、变宽度的无限符号，颜色取自同一套墨色渐变。 */
    function Glyph({ size = 16 }) {
      return h('svg', {
        className: 'dsd_glyph_svg',
        width: size,
        height: size,
        viewBox: '0 0 64 64',
        focusable: 'false',
        'aria-hidden': 'true',
      },
        h('defs', { key: 'defs' },
          h('linearGradient', { id: GLYPH_GRADIENT, x1: '0.08', y1: '0.22', x2: '0.92', y2: '0.78' },
            h('stop', { offset: '0', stopColor: '#fbbf24' }),
            h('stop', { offset: '0.5', stopColor: '#fb7185' }),
            h('stop', { offset: '1', stopColor: '#e879f9' }))),
        h('path', { key: 'ink', d: GLYPH_PATH, fill: `url(#${GLYPH_GRADIENT})` }))
    }

    /**
     * 状态条。点「结束」必须真的关掉：先走 `/dont-stop stop`（和手敲命令同一条路，
     * 会让 agent 收尾）；命令没打通时改用宿主的强制结束接口；两条都失败也直接收起状态条。
     */
    function SupervisionBar({ useProjection, sessionId, stop, t }) {
      const view = useProjection(PROJECTION_KEY)
      const [now, setNow] = React.useState(() => Date.now())
      const [pending, setPending] = React.useState(false)
      const [dismissed, setDismissed] = React.useState(false)
      const supervising = view !== undefined && view !== null && view.phase === 'supervising' && view.deadlineAt > 0
      const remaining = supervising ? view.deadlineAt - now : 0
      const visible = supervising && remaining > 0 && !dismissed
      React.useEffect(() => {
        if (!visible) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [visible])
      // 强制关闭只对本次点击有效：新一轮监督（开始时间或截止时间变化）重新出现。
      React.useEffect(() => {
        setDismissed(false)
        setPending(false)
      }, [supervising ? view.startedAt : 0, supervising ? view.deadlineAt : 0])

      /** 兜底：绕开命令层，直接请宿主强制结束这条监督。 */
      const forceStop = React.useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return false
        try {
          const response = await window.fetch(RECOVERY_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId, action: 'cancel' }),
          })
          return response.ok
        } catch {
          return false
        }
      }, [sessionId])

      const requestStop = React.useCallback(async () => {
        if (pending) return
        setPending(true)
        try {
          const result = await stop()
          if (result === undefined || result === null || result.ok !== true || result.value === undefined) {
            await forceStop()
          }
        } catch {
          await forceStop()
        } finally {
          setPending(false)
          setDismissed(true)
        }
      }, [forceStop, pending, stop])
      if (!visible) return null

      // 顺序：截止时间 → 剩余时间 → 已督促次数 → 到点行为；各项之间用竖线隔开。
      const meta = [
        h('span', { className: 'dsd_meta', key: 'until', 'data-dont-stop-until': '' },
          fill(t('status.until'), { time: formatClock(view.deadlineAt) })),
        h('span', { className: 'dsd_meta', key: 'remaining', 'data-dont-stop-remaining': '' },
          fill(t('status.remaining'), { time: formatDuration(remaining, t) })),
        view.rounds > 0
          ? h('span', { className: 'dsd_meta', key: 'rounds' }, fill(t('status.rounds'), { n: String(view.rounds) }))
          : null,
        view.stopAtDeadline === undefined || view.stopAtDeadline === null
          ? null
          : h('span', { className: 'dsd_meta', key: 'deadlineMode', 'data-dont-stop-deadline-mode': String(view.stopAtDeadline) },
            t(view.stopAtDeadline ? 'status.stopAtDeadline' : 'status.keepAfterDeadline')),
      ].filter((node) => node !== null)
      const separated = []
      for (const node of meta) {
        if (separated.length > 0) {
          separated.push(h('span', { className: 'dsd_sep', key: `sep-${node.props?.key ?? separated.length}`, 'aria-hidden': true }, '|'))
        }
        separated.push(node)
      }
      return h('div', { className: 'dsd_dock', 'data-dont-stop-bar': '' },
        h('div', { className: 'dsd_bar' },
          h('span', { className: 'dsd_glyph', 'aria-hidden': true }, h(Glyph, { size: 15 })),
          h('span', { className: 'dsd_label' }, t('status.supervising')),
          ...separated,
          h('div', { className: 'dsd_actions' },
            h('button', {
              type: 'button',
              className: 'dsd_action',
              disabled: pending,
              onClick: requestStop,
              'aria-label': t('action.stop'),
            }, pending ? t('action.stopping') : t('action.stop')))))
    }

    /**
     * 恢复条：等待错误恢复时单独占一行，不和 Dont-Stop 状态条挤在一起。
     * 显示上次错误类型、第几次重试、倒计时，并提供「立即重试」和放弃（×）。
     */
    function RecoveryBar({ sessionId, t }) {
      const [entry, setEntry] = React.useState(null)
      const [now, setNow] = React.useState(() => Date.now())
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)

      React.useEffect(() => {
        if (typeof sessionId !== 'string') return undefined
        let cancelled = false
        const load = async () => {
          try {
            const response = await window.fetch(RECOVERY_ENDPOINT, { headers: { accept: 'application/json' } })
            if (!response.ok) return
            const payload = await response.json()
            if (cancelled) return
            const rows = Array.isArray(payload?.value?.recoveries) ? payload.value.recoveries : []
            setEntry(rows.find((row) => row?.sessionId === sessionId) ?? null)
          } catch {
            // 读不到就保持上一次的结果，不影响别的界面。
          }
        }
        load()
        const timer = window.setInterval(load, RECOVERY_POLL_MS)
        return () => {
          cancelled = true
          window.clearInterval(timer)
        }
      }, [sessionId])

      const visible = entry !== null && typeof entry.resumeAt === 'number'
      React.useEffect(() => {
        if (!visible) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [visible])

      const act = React.useCallback(async (action) => {
        if (pending) return
        setPending(true)
        setError(null)
        try {
          const response = await window.fetch(RECOVERY_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ sessionId, action }),
          })
          const payload = await response.json().catch(() => undefined)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          setEntry(null)
        } catch (failure) {
          setError(fill(t('recovery.failed'), { message: String(failure?.message ?? failure) }))
        } finally {
          setPending(false)
        }
      }, [pending, sessionId, t])

      if (!visible) return null
      const wait = Math.max(entry.resumeAt - now, 0)
      // 顺序：类型 → 已重试次数 → 倒计时；各项之间用竖线隔开。
      const meta = [
        h('span', {
          className: 'dsr_meta',
          key: 'class',
          'data-dont-stop-recovery-class': String(entry.cls ?? ''),
          title: entry.message ?? '',
        }, fill(t('recovery.class'), { cls: classLabel(entry.cls, t) })),
        h('span', { className: 'dsr_meta', key: 'attempt' },
          fill(t('recovery.attempt'), { n: String(entry.attempt ?? 1), max: String(entry.maxAttempts ?? 1) })),
        h('span', { className: 'dsr_meta', key: 'next' },
          wait <= 1000 ? t('recovery.imminent') : fill(t('recovery.next'), { time: formatWait(wait, t) })),
      ]
      const separated = []
      for (const node of meta) {
        if (separated.length > 0) {
          separated.push(h('span', { className: 'dsr_sep', key: `sep-${node.props?.key ?? separated.length}`, 'aria-hidden': true }, '|'))
        }
        separated.push(node)
      }
      return h('div', { className: 'dsr_dock', 'data-dont-stop-recovery-bar': '' },
        h('div', { className: 'dsr_bar' },
          h('span', { className: 'dsr_glyph', 'aria-hidden': true }, h(Glyph, { size: 15 })),
          h('span', { className: 'dsr_label' }, t('recovery.title')),
          ...separated,
          error !== null && h('span', { className: 'dsr_error', role: 'alert' }, error),
          h('div', { className: 'dsr_actions' },
            h('button', {
              type: 'button',
              className: 'dsr_action',
              disabled: pending,
              onClick: () => act('retry-now'),
            }, t('recovery.retryNow')),
            h('button', {
              type: 'button',
              className: 'dsr_close',
              disabled: pending,
              onClick: () => act('cancel'),
              'aria-label': t('recovery.dismiss'),
              title: t('recovery.dismiss'),
            }, '×'))))
    }

    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'dsd_switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        disabled,
        onClick: () => onChange(!checked),
      }, h('span', { className: 'dsd_knob', 'aria-hidden': true }))
    }

    function SettingsPage({ t: providedT }) {
      const t = typeof providedT === 'function' ? providedT : translate
      const [settings, setSettings] = React.useState(() => normalizeSettings(undefined))
      const [status, setStatus] = React.useState('loading')
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [secondsDraft, setSecondsDraft] = React.useState(null)
      const [questionDraft, setQuestionDraft] = React.useState(null)

      React.useEffect(() => {
        let cancelled = false
        window.fetch(SETTINGS_ENDPOINT, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((payload) => {
            if (cancelled) return
            setSettings(normalizeSettings(payload?.value))
            setStatus('ready')
            setError(null)
          })
          .catch((failure) => {
            if (cancelled) return
            setStatus('error')
            setError(String(failure?.message ?? failure))
          })
        return () => {
          cancelled = true
        }
      }, [])

      const save = React.useCallback(async (patch) => {
        setSaving(true)
        setError(null)
        try {
          const response = await window.fetch(SETTINGS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(patch),
          })
          const payload = await response.json().catch(() => undefined)
          if (!response.ok || payload?.ok !== true) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          setSettings(normalizeSettings(payload.value))
          setStatus('ready')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setSaving(false)
        }
      }, [])

      const commitSeconds = () => {
        const draft = secondsDraft
        setSecondsDraft(null)
        if (draft === null) return
        const parsed = Number(draft)
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError(t('settings.invalidInterval'))
          return
        }
        const seconds = Math.min(Math.round(parsed), MAX_INTERVAL_SECONDS)
        save({ minRoundIntervalMs: seconds * 1000 })
      }

      const commitQuestionLimit = () => {
        const draft = questionDraft
        setQuestionDraft(null)
        if (draft === null) return
        const parsed = Number(draft)
        if (!Number.isFinite(parsed) || parsed < 0) {
          setError(t('settings.invalidQuestionLimit'))
          return
        }
        const seconds = Math.min(Math.round(parsed), MAX_QUESTION_LIMIT_SECONDS)
        save({ questionLimitMs: seconds * 1000 })
      }

      const editable = status !== 'loading' && !saving
      const row = (key, label, description, control) => h('div', { className: 'dsd_row', key },
        h('div', { className: 'dsd_row_text' },
          h('div', { className: 'dsd_row_label' }, label),
          h('div', { className: 'dsd_row_desc' }, description)),
        h('div', { className: 'dsd_row_control' }, control))

      const intervalControl = [
        h('input', {
          className: 'dsd_input',
          type: 'number',
          inputMode: 'numeric',
          key: 'seconds',
          min: 0,
          max: MAX_INTERVAL_SECONDS,
          step: 5,
          value: secondsDraft !== null ? secondsDraft : String(Math.round(settings.minRoundIntervalMs / 1000)),
          disabled: !editable,
          'aria-label': t('settings.minInterval.label'),
          onChange: (event) => setSecondsDraft(event.target.value),
          onBlur: commitSeconds,
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commitSeconds()
          },
        }),
        h('span', { className: 'dsd_unit', key: 'unit' }, fill(t('settings.minInterval.unit'), {})),
      ]

      const questionLimitControl = [
        h('input', {
          className: 'dsd_input',
          type: 'number',
          inputMode: 'numeric',
          key: 'seconds',
          min: 0,
          max: MAX_QUESTION_LIMIT_SECONDS,
          step: 30,
          value: questionDraft !== null ? questionDraft : String(Math.round(settings.questionLimitMs / 1000)),
          disabled: !editable,
          'aria-label': t('settings.questionLimit.label'),
          onChange: (event) => setQuestionDraft(event.target.value),
          onBlur: commitQuestionLimit,
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commitQuestionLimit()
          },
        }),
        h('span', { className: 'dsd_unit', key: 'unit' }, fill(t('settings.questionLimit.unit'), {})),
      ]

      return h('div', { className: 'dsd_page', 'data-dont-stop-settings': '' },
        h('div', { className: 'dsd_page_head' },
          h('div', { className: 'dsd_page_heading' },
            h('span', { className: 'dsd_page_glyph', 'aria-hidden': true }, h(Glyph, { size: 30 })),
            h('div', { className: 'dsd_page_title' }, t('settings.title'))),
          h('div', { className: 'dsd_page_desc' }, t('settings.description'))),
        h('div', { className: 'dsd_rows' },
          row('waitTool', t('settings.waitTool.label'), t('settings.waitTool.description'),
            h(Switch, {
              checked: settings.waitTool,
              disabled: !editable,
              label: t('settings.waitTool.label'),
              onChange: (next) => save({ waitTool: next }),
            })),
          row('errorRecovery', t('settings.errorRecovery.label'), t('settings.errorRecovery.description'),
            h(Switch, {
              checked: settings.errorRecovery,
              disabled: !editable,
              label: t('settings.errorRecovery.label'),
              onChange: (next) => save({ errorRecovery: next }),
            })),
          row('stopAtDeadline', t('settings.stopAtDeadline.label'), t('settings.stopAtDeadline.description'),
            h(Switch, {
              checked: settings.stopAtDeadline,
              disabled: !editable,
              label: t('settings.stopAtDeadline.label'),
              onChange: (next) => save({ stopAtDeadline: next }),
            })),
          row('minRoundInterval', t('settings.minInterval.label'), t('settings.minInterval.description'), intervalControl),
          row('questionLimitAlways', t('settings.questionLimitAlways.label'), t('settings.questionLimitAlways.description'),
            h(Switch, {
              checked: settings.questionLimitAlways,
              disabled: !editable,
              label: t('settings.questionLimitAlways.label'),
              onChange: (next) => save({ questionLimitAlways: next }),
            })),
          row('questionLimit', t('settings.questionLimit.label'), t('settings.questionLimit.description'), questionLimitControl)),
        status === 'loading' ? h('div', { className: 'dsd_note' }, t('settings.loading')) : null,
        error !== null ? h('div', { className: 'dsd_page_error', role: 'alert' }, fill(t('settings.saveFailed'), { message: error })) : null)
    }

    return {
      // `remote` 是宿主远程服务本身，`remote.commands` 是它的命令命名空间：两个都要声明，
      // 少了 `remote` 访问 ctx.remote 会直接抛 “cannot get property "remote" without inject”。
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dont-stop: 中文文案')
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dont-stop: 英文文案')
        if (typeof ctx.locale.bind === 'function') translate = ctx.locale.bind(NS)
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/dsh-dont-stop'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'dont-stop: 状态条与设置页样式')
        // 壳层只按内置 section id 给侧栏图标（models / agent-presets / plugins），
        // 其余一律给默认齿轮：这里认领文字等于本插件标题的那一行，换成无限符号。
        ctx.effect(() => {
          if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return undefined
          const rows = () => Array.from(document.querySelectorAll(NAV_ROW_SELECTOR))
          const wanted = () => String(translate('settings.nav') ?? '').trim()
          let disposed = false
          let scheduled = false
          const sync = () => {
            scheduled = false
            if (disposed) return
            const label = wanted()
            for (const row of rows()) {
              if (label !== '' && String(row.textContent ?? '').trim() === label) row.setAttribute(NAV_ICON_MARKER, '')
              else row.removeAttribute(NAV_ICON_MARKER)
            }
          }
          const schedule = () => {
            if (scheduled || disposed) return
            scheduled = true
            queueMicrotask(sync)
          }
          sync()
          const observer = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : undefined
          if (observer !== undefined && document.body) {
            observer.observe(document.body, { childList: true, subtree: true, characterData: true })
          }
          return () => {
            disposed = true
            observer?.disconnect()
            for (const row of rows()) row.removeAttribute(NAV_ICON_MARKER)
          }
        }, 'dont-stop: 设置侧栏图标')
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dont-stop',
          order: 5,
          locale: NS,
          inject: (sessionId) => ({
            sessionId: String(sessionId),
            stop: () => ctx.remote.commands.execute(sessionId, '/dont-stop stop', []),
          }),
        }, SupervisionBar))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dont-stop-recovery',
          order: 4,
          locale: NS,
          inject: (sessionId) => ({ sessionId: String(sessionId) }),
        }, RecoveryBar))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dont-stop',
          order: 35,
          label: () => translate('settings.nav'),
          locale: NS,
        }, SettingsPage))
      },
    }
  },
})
