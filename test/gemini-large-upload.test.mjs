import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const adapterSource = await readFile(
  new URL('../automation/playwright-service/src/gemini/adapter.ts', import.meta.url),
  'utf8',
)

test('Gemini video upload does not serialize large files through page.evaluate', () => {
  assert.doesNotMatch(adapterSource, /bodyBase64|toString\(['"]base64['"]\)|atob\(/)
  assert.match(adapterSource, /context\(\)\.request\.fetch/)
  assert.match(adapterSource, /binaryBody:\s*body/)
})

test('Gemini large-video upload uses an extended timeout', () => {
  assert.match(adapterSource, /const timeoutMs = 900_000/)
})
