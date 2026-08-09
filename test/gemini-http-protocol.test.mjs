import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildStreamPayload,
  extractConversation,
  extractStreamPayloads,
  extractText,
  isQuotaRefusal,
} from '../automation/playwright-service/dist/gemini/protocol.js'

test('Gemini HTTP 请求保留附件和固定会话', () => {
  const payload = buildStreamPayload('分析视频', [{
    resourcePath: '/contrib_service/abc',
    fileName: 'reference.mp4',
    mimeType: 'video/mp4',
  }], {
    conversationId: 'c_12345678',
    responseId: 'r_12345678',
    candidateId: 'rc_12345678',
  })
  assert.deepEqual(payload[0][3], [[['/contrib_service/abc', 1, null, 'video/mp4'], 'reference.mp4']])
  assert.deepEqual(payload[2].slice(0, 3), ['c_12345678', 'r_12345678', 'rc_12345678'])
})

test('只把明确的短额度拒绝识别为额度耗尽', () => {
  assert.equal(isQuotaRefusal('You have reached your daily limit. Please try again tomorrow.'), true)
  assert.equal(isQuotaRefusal('当前视频分析额度已经用尽，请明天再试。'), true)
  assert.equal(isQuotaRefusal('提示词中需要描述 API quota、构图限制和画面边界。'), false)
  assert.equal(isQuotaRefusal(`---VIDEO_OVERVIEW---\n完整结果中提到了额度和 limit reached，但这不是系统拒绝。${'画面描述'.repeat(300)}`), false)
})

test('Gemini StreamGenerate 分帧响应可提取完整文本和续写标识', () => {
  const inner = [[
    'c_abcdef12', 'r_abcdef12',
    ['rc_abcdef12', ['---VIDEO_OVERVIEW---\n一条电影感视频，柔和侧光与真实材质。']],
    'Aw1234567890abcdefghijklmnop',
  ]]
  const frame = JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]])
  const raw = `)]}'\n${Buffer.byteLength(frame)}\n${frame}`
  const payloads = extractStreamPayloads(raw)
  assert.equal(extractText(payloads), '---VIDEO_OVERVIEW---\n一条电影感视频，柔和侧光与真实材质。')
  assert.deepEqual(extractConversation(payloads), {
    conversationId: 'c_abcdef12',
    responseId: 'r_abcdef12',
    candidateId: 'rc_abcdef12',
    contextToken: 'Aw1234567890abcdefghijklmnop',
  })
})
