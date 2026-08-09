export class AutomationError extends Error {
  constructor(public readonly code: string, message: string, public readonly detail?: string) {
    super(message)
    this.name = 'AutomationError'
  }
}

export const ERROR_MESSAGES: Record<string, string> = {
  CHROME_NOT_FOUND: '未找到 Google Chrome，请先安装后重试。',
  CHROME_LAUNCH_FAILED: 'Gemini 专用浏览器启动失败，请检查 Chrome Profile 是否被其他进程占用。',
  BROWSER_UNAVAILABLE: 'Gemini 专用浏览器不可用，请检查 Chrome 是否正常运行。',
  GEMINI_UNREACHABLE: '无法访问 Gemini，请检查网络后重试。',
  LOGIN_REQUIRED: '需要登录 Gemini，请在浏览器中完成登录。',
  HUMAN_VERIFICATION: 'Gemini 需要人工验证，请在浏览器完成验证。',
  UPLOAD_FAILED: '文件上传失败，请重试。',
  CONVERSATION_REQUIRED: '找不到本项目的 Gemini 固定对话，请先重新分析一次。',
  RATE_LIMITED: 'Gemini 当前请求较频繁，请稍等片刻后重试。',
  QUOTA_EXCEEDED: 'Gemini 当前额度已用尽，请稍后重试。',
  UNKNOWN: '自动化执行失败，请重试。',
}

export function normalizeError(error: unknown, debug: boolean): AutomationError {
  if (error instanceof AutomationError) return error
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (error instanceof Error && ['MediaResolverError', 'VideoDownloadError'].includes(error.name)) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'MEDIA_IMPORT_FAILED'
    return new AutomationError(code, error.message, debug ? detail : undefined)
  }
  return new AutomationError('UNKNOWN', ERROR_MESSAGES.UNKNOWN, debug ? detail : undefined)
}
