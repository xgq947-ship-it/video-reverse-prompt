export type GeminiAuthStatus = 'logged-in' | 'logged-out' | 'expired'

export interface GeminiAuthResult {
  status: GeminiAuthStatus
  reason?: 'NO_ACCOUNT_ID' | 'NO_BOOTSTRAP_TOKEN'
  userId?: string
}

/**
 * 直接复用 AI-Video-Canvas 已在线验证的 Gemini 登录判定：
 * S06Grb 是 Google 账号标识，SNlM0e 是可调用页面协议的 bootstrap token。
 * FdrFJe 在未登录页面也存在，绝不能参与登录判断。
 */
export function readWizField(html: string, key: string): string | null {
  const source = String(html || '')
  const patterns = [
    new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`),
    new RegExp(`'${key}'\\s*:\\s*'([^']*)'`),
    new RegExp(`${key}\\\\":\\\\"([^\\\\"]*)`),
  ]
  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (match) return match[1]
  }
  return null
}

export function parseGeminiAuth(html: string): GeminiAuthResult {
  const userId = readWizField(html, 'S06Grb')
  const at = readWizField(html, 'SNlM0e')
  if (!userId) return { status: 'logged-out', reason: 'NO_ACCOUNT_ID' }
  if (!at) return { status: 'expired', reason: 'NO_BOOTSTRAP_TOKEN', userId }
  return { status: 'logged-in', userId }
}
