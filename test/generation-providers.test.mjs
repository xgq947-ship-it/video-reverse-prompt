import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCodexExecArgs,
  DeepSeekProvider,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  DEEPSEEK_MODEL,
} from '../automation/playwright-service/dist/generation/providers.js'

test('DeepSeek 固定使用 V4 Flash、Thinking 与 MAX 推理配置', async () => {
  const calls = []
  const provider = new DeepSeekProvider({ provider: 'deepseek', deepseekApiKey: 'sk-local-test' }, async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const response = await provider.generateJson('系统', '任务')
  assert.equal(response.content, '{"ok":true}')
  assert.equal(calls[0].url, `${DEEPSEEK_BASE_URL}/chat/completions`)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-local-test')
  assert.equal(calls[0].body.model, DEEPSEEK_MODEL)
  assert.equal(calls[0].body.model, 'deepseek-v4-flash')
  assert.deepEqual(calls[0].body.thinking, { type: 'enabled' })
  assert.equal(calls[0].body.reasoning_effort, 'max')
  assert.equal(calls[0].body.max_tokens, DEEPSEEK_MAX_OUTPUT_TOKENS)
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' })
  assert.equal(calls[0].body.temperature, undefined)
})

test('Codex CLI 采用 HotStory 同源且只读的非交互参数', () => {
  assert.deepEqual(buildCodexExecArgs('/tmp/output.txt', '/tmp/project'), [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    '/tmp/project',
    '--output-last-message',
    '/tmp/output.txt',
    '-',
  ])
})
