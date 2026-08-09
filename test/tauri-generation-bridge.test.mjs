import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const rust = await readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))

test('DeepSeek Key 通过标准输入传递，不出现在 Node 命令行参数', () => {
  assert.match(rust, /\.stdin\(Stdio::piped\(\)\)/)
  assert.match(rust, /write_all\(body\.as_bytes\(\)\)/)
  assert.doesNotMatch(rust, /\.arg\(body\)/)
})

test('发布包包含完整 Skill，并为 Codex 提供只读工作目录', () => {
  assert.equal(tauriConfig.bundle.resources['../skills/'], 'skills/')
  assert.match(rust, /VIDEO_REVERSE_PROMPT_SKILL_ROOT/)
  assert.match(rust, /VIDEO_REVERSE_PROMPT_PROJECT_ROOT/)
})
