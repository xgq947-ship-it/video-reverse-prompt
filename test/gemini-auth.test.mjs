import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGeminiAuth, readWizField } from '../automation/playwright-service/dist/gemini/auth.js'

test('S06Grb 与 SNlM0e 同时存在才判定 Gemini 已登录', () => {
  const status = parseGeminiAuth('<script>window.WIZ_global_data={"S06Grb":"123456","SNlM0e":"secret-at"}</script>')
  assert.deepEqual(status, { status: 'logged-in', userId: '123456' })
})

test('空账号标识始终判定未登录，FdrFJe 不能作为登录依据', () => {
  const status = parseGeminiAuth('{"S06Grb":"","SNlM0e":"secret-at","FdrFJe":"visitor-session"}')
  assert.deepEqual(status, { status: 'logged-out', reason: 'NO_ACCOUNT_ID' })
})

test('只有 FdrFJe 的访客页面不会误判为已登录', () => {
  const status = parseGeminiAuth('{"FdrFJe":"visitor-session"}')
  assert.deepEqual(status, { status: 'logged-out', reason: 'NO_ACCOUNT_ID' })
})

test('账号存在但缺少 bootstrap token 时判定会话过期', () => {
  const status = parseGeminiAuth('{"S06Grb":"123456","SNlM0e":""}')
  assert.deepEqual(status, { status: 'expired', reason: 'NO_BOOTSTRAP_TOKEN', userId: '123456' })
})

test('登录检测结果不会带出 Gemini bootstrap token', () => {
  const status = parseGeminiAuth('{"S06Grb":"123456","SNlM0e":"secret-at"}')
  assert.doesNotMatch(JSON.stringify(status), /secret-at/)
})

test('readWizField 兼容页面中的转义 WIZ_global_data', () => {
  assert.equal(readWizField('S06Grb\\\":\\\"123456', 'S06Grb'), '123456')
})
