/**
 * README 图片与链接的自检：图片必须用 Markdown 语法且指向真实文件，相对链接不能断。
 * 之前出现过 README 里写原始 HTML `<img>`、在部分预览器里不显示的问题，这里一并守住。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const READMES = ['README.md', 'README.en.md']

const readmeText = (name) => readFileSync(join(ROOT, name), 'utf8')

/** Markdown 图片目标：![alt](path) */
function imageTargets(text) {
  return [...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1])
}

/** 普通链接目标：[text](path)，排除图片与带协议的 URL。 */
function linkTargets(text) {
  const links = []
  for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) links.push(match[1])
  return links
}

const isLocal = (target) => !/^[a-z][a-z0-9+.-]*:/i.test(target)

/** 去掉锚点与查询串，得到仓库内的相对路径。 */
function localPath(target) {
  return decodeURI(target.split('#')[0].split('?')[0])
}

/** 读 PNG 头里的宽高，用来确认横幅确实是横图。 */
function pngSize(path) {
  const buffer = readFileSync(path)
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${path} 不是 PNG`,
  )
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

for (const name of READMES) {
  test(`${name}：图片指向真实文件`, () => {
    const targets = imageTargets(readmeText(name))
    assert.ok(targets.length > 0, 'README 至少应有一张图片')
    for (const target of targets.filter(isLocal)) {
      const path = join(ROOT, localPath(target))
      assert.ok(existsSync(path), `${name} 引用了不存在的图片：${target}`)
    }
  })

  test(`${name}：相对链接可解析`, () => {
    for (const target of linkTargets(readmeText(name)).filter(isLocal)) {
      const path = join(ROOT, localPath(target))
      assert.ok(existsSync(path), `${name} 引用了不存在的文件：${target}`)
    }
  })

  test(`${name}：图片用 Markdown 语法书写`, () => {
    assert.doesNotMatch(readmeText(name), /<img\b/i, 'README 不要用原始 HTML <img>，部分预览器不渲染')
  })

  test(`${name}：首图是横幅而不是方形图标`, () => {
    const text = readmeText(name)
    assert.match(text, /!\[[^\]]*\]\(docs\/images\/banner(?:\.en)?\.png\)/, 'README 应以横幅作为首图')
    assert.doesNotMatch(text, /docs\/images\/icon\.png/, '方形图标已由横幅取代')
  })
}

test('中英文 README 互相链接', () => {
  assert.match(readmeText('README.md'), /\(README\.en\.md\)/)
  assert.match(readmeText('README.en.md'), /\(README\.md\)/)
})

test('横幅是横向长图', () => {
  for (const file of ['docs/images/banner.png', 'docs/images/banner.en.png']) {
    const { width, height } = pngSize(join(ROOT, file))
    assert.ok(width >= 1000, `${file} 宽度至少 1000px，当前 ${width}`)
    assert.ok(width >= height * 3, `${file} 应是横向长图，当前 ${width}x${height}`)
  }
})
