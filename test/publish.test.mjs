/**
 * 发布清单自检：package.json 的 files 白名单必须覆盖全部运行时代码，
 * exports 与 dsh 字段指向真实文件，README 里的图片也随包发布。
 * 之前吃过「加了一个模块但忘了写进 files」的亏，打包后才知道缺文件。
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** files 里的 glob：`*` 只跨一段目录，`**` 跨任意层。 */
function globToRegExp(pattern) {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else if ('\\^$+?.()|[]{}'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`${source}$`)
}

const shipped = manifest.files.map(globToRegExp)

const isShipped = (path) => shipped.some((pattern) => pattern.test(path))

/** 仓内所有运行时代码与资源（测试与临时目录除外）。 */
function runtimeFiles() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        walk(path)
      } else {
        files.push(path)
      }
    }
  }
  walk('core')
  walk('power')
  walk('retry')
  walk('shared')
  walk('locale')
  walk('docs/images')
  for (const file of ['index.js', 'client.js', 'prompts.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'README.en.md']) {
    files.push(file)
  }
  return files
}

test('the manifest describes this package', () => {
  assert.equal(manifest.name, 'dsh-dont-stop')
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, '版本号应当是稳定的三段式')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.type, 'module')
  assert.match(manifest.description, /\S/)
  assert.match(manifest.repository?.url ?? '', /dsh-dont-stop/)
})

test('every runtime file is covered by the files whitelist', () => {
  const missing = runtimeFiles().filter((file) => !isShipped(file))
  assert.deepEqual(missing, [], `这些文件不会进发布包：${missing.join(', ')}`)
})

test('the whitelist never reaches tests or scratch space', () => {
  for (const pattern of manifest.files) {
    assert.doesNotMatch(pattern, /^\.?\.?\//, `${pattern} 不该以相对前缀开头`)
    const sample = pattern
      .replaceAll('**', 'x')
      .replaceAll('*', 'x')
    assert.ok(!sample.startsWith('test/'), `${pattern} 会把测试打进包里`)
    assert.ok(!sample.startsWith('tmp/'), `${pattern} 会把临时目录打进包里`)
    assert.ok(!sample.includes('..'), `${pattern} 指到了仓库外`)
  }
})

test('the exports map points at real files', () => {
  for (const [key, entry] of Object.entries(manifest.exports)) {
    assert.equal(typeof entry, 'string', `${key} 的出口应当是一个路径`)
    const target = entry.replace(/^\.\//, '')
    if (target.includes('*')) {
      const prefix = target.slice(0, target.indexOf('*'))
      const dir = join(ROOT, dirname(prefix))
      assert.ok(existsSync(dir), `${key} 指向的目录不存在：${dir}`)
      assert.ok(readdirSync(dir).some((name) => target.endsWith(`.${name.split('.').pop()}`)), `${key} 没有任何匹配文件`)
      continue
    }
    assert.ok(existsSync(join(ROOT, target)), `${key} 指向的文件不存在：${target}`)
    // package.json 由 npm 无条件带上，不需要写进 files 白名单。
    if (target !== 'package.json') {
      assert.ok(isShipped(target), `${key} 指向的文件不在发布包里：${target}`)
    }
  }
})

test('the bundle patch and the client entry are declared', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(ROOT, 'cordis.patch.yml')), 'bundle 补丁文件缺失')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(manifest.dsh?.client?.immediately, true)
  const inject = manifest.dsh?.client?.inject
  assert.ok(Array.isArray(inject) && inject.length > 0, 'client 需要声明它依赖的界面包')
  for (const name of inject) assert.match(name, /^@deepseek-ai\//, `${name} 不是 Harness 的界面包`)
})

test('relative imports resolve inside the package', () => {
  const specs = []
  for (const file of runtimeFiles().filter((path) => /\.(js|mjs)$/.test(path))) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)) {
      specs.push({ file, spec: match[1] })
    }
  }
  assert.ok(specs.length > 10, '应当能扫到模块之间的相对引用')
  for (const { file, spec } of specs) {
    const target = resolve(ROOT, dirname(file), spec)
    assert.ok(existsSync(target), `${file} 引用了不存在的模块：${spec}`)
    assert.ok(isShipped(relative(ROOT, target).replaceAll('\\', '/')), `${file} 引用的模块不会进发布包：${spec}`)
  }
})

test('the changelog has an entry for this version', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, new RegExp(`\\*\\*${manifest.version.replaceAll('.', '\\.')}\\*\\*`), 'README 的更新记录里应当有当前版本')
})

test('README images ship with the package', () => {
  for (const name of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      const target = decodeURI(match[1].split('#')[0].split('?')[0])
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
      assert.ok(existsSync(join(ROOT, target)), `${name} 引用了不存在的图片：${target}`)
      assert.ok(isShipped(target), `${name} 的图片不会随包发布：${target}`)
      assert.equal(statSync(join(ROOT, target)).size > 0, true, `${target} 是空文件`)
    }
  }
})
