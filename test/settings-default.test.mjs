import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/types/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { DEFAULT_SETTINGS } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('浏览器默认在后台执行', () => {
  assert.equal(DEFAULT_SETTINGS.browserBehavior, 'background')
})

test('第二步默认 DeepSeek V4 Flash MAX 且只需填写 Key', () => {
  assert.equal(DEFAULT_SETTINGS.generationProvider, 'deepseek')
  assert.equal(DEFAULT_SETTINGS.deepseekApiKey, '')
})
