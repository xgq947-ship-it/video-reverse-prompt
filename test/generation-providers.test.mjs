import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCodexExecArgs,
  deepSeekApiKeyValidationMessage,
  DeepSeekProvider,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  DEEPSEEK_MODEL,
  generatorStatus,
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

test('DeepSeek Key 含中文或空格时在发起网络请求前给出明确错误', async () => {
  let calls = 0
  const provider = new DeepSeekProvider({ provider: 'deepseek', deepseekApiKey: 'sk-valid-part中文' }, async () => {
    calls += 1
    throw new Error('不应发起请求')
  })
  assert.match(deepSeekApiKeyValidationMessage('sk-valid-part中文'), /包含中文、空格/)
  await assert.rejects(
    provider.generateText('系统', '任务'),
    (error) => error.code === 'DEEPSEEK_INVALID_KEY_FORMAT' && /重新复制完整 Key/.test(error.message),
  )
  assert.equal(calls, 0)
})

test('DeepSeek 鉴权失败会显示可操作的 Key 错误', async () => {
  const provider = new DeepSeekProvider({ provider: 'deepseek', deepseekApiKey: 'sk-valid-local-key' }, async () => (
    new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  ))
  await assert.rejects(
    provider.generateText('系统', '任务'),
    (error) => error.code === 'DEEPSEEK_INVALID_KEY' && /API Key 无效或已失效/.test(error.message),
  )
})

test('生成模型确认会在线验证 Key 与 V4 Flash 可用性', async () => {
  const calls = []
  const status = await generatorStatus({ provider: 'deepseek', deepseekApiKey: 'sk-valid-local-key' }, async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  assert.equal(status.available, true)
  assert.match(status.message, /API Key 已验证/)
  assert.equal(calls[0].url, `${DEEPSEEK_BASE_URL}/models`)
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-valid-local-key')
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
