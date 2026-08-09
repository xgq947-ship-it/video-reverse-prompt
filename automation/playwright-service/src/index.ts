import { access } from 'node:fs/promises'
import { stdin } from 'node:process'
import { AutomationError, ERROR_MESSAGES, normalizeError } from './errors.js'
import { GeminiAdapter } from './gemini/adapter.js'
import { openGeminiLoginWindow } from './gemini/browser.js'
import { resolveAndDownloadVideo } from './media/downloader.js'
import { augmentPromptWithVerbatimSkills } from './prompts/skills.js'
import type { AutomationRequest, AutomationResult, WireMessage } from './types.js'

function emit(message: WireMessage): void { process.stdout.write(`${JSON.stringify(message)}\n`) }
function progress(stage: string, message: string): void { emit({ type: 'progress', stage, message }) }

async function readRequest(): Promise<AutomationRequest> {
  if (process.argv[2]) return JSON.parse(process.argv[2]) as AutomationRequest
  let body = ''
  for await (const chunk of stdin) body += String(chunk)
  return JSON.parse(body) as AutomationRequest
}

async function execute(request: AutomationRequest): Promise<AutomationResult> {
  const url = request.geminiUrl ?? 'https://gemini.google.com/app'
  if (request.command === 'resolve-video') {
    if (!request.mediaInput?.trim() || !request.outputDir) {
      throw new AutomationError('INVALID_MEDIA_URL', '请粘贴有效的视频分享链接或分享文案。')
    }
    const importedVideo = await resolveAndDownloadVideo({
      input: request.mediaInput,
      outputDir: request.outputDir,
      onProgress: progress,
    })
    progress('preparing', '视频已保存，可以开始反推')
    return { ok: true, importedVideo }
  }
  if (request.command === 'open') {
    progress('opening', '正在打开 Gemini 登录窗口')
    await openGeminiLoginWindow(url)
    return { ok: true }
  }

  const behavior = request.command === 'check-login' || request.command === 'compatibility'
    ? 'background'
    : request.browserBehavior ?? 'background'
  const adapter = new GeminiAdapter(url, behavior, (message) => {
    if (request.debug) process.stderr.write(`[Gemini] ${message}\n`)
  })
  try {
    progress('opening', '正在打开 Gemini')
    await adapter.init()
    await adapter.openGemini()

    const loggedIn = await adapter.checkLogin()
    if (request.command === 'check-login') return { ok: true, loggedIn }
    if (!loggedIn) throw new AutomationError('LOGIN_REQUIRED', ERROR_MESSAGES.LOGIN_REQUIRED)
    if (request.command === 'compatibility') return { ok: true, loggedIn, checks: await adapter.compatibilityCheck() }

    if (!request.mediaType || !request.prompt) throw new AutomationError('UNKNOWN', '分析参数不完整。')
    if (request.command === 'refine') {
      if (!await adapter.hasConversation()) throw new AutomationError('CONVERSATION_REQUIRED', ERROR_MESSAGES.CONVERSATION_REQUIRED)
      progress('preparing', '正在继续调整当前结果')
    } else {
      if (!request.filePath) throw new AutomationError('UNKNOWN', '分析参数不完整。')
      await access(request.filePath)
      progress('uploading', '正在通过 HTTP 上传文件')
    }
    const expanded = await augmentPromptWithVerbatimSkills(request.prompt)
    progress('sending', expanded.source === 'verbatim' ? '正在加载完整 Skill 并生成视频提示词包' : '正在使用内置工作流生成视频提示词包')
    const rawResponse = request.command === 'refine'
      ? await adapter.refine(expanded.prompt)
      : await adapter.analyzeFile(request.filePath!, expanded.prompt)
    progress('extracting', '正在整理结果')
    return { ok: true, loggedIn: true, rawResponse }
  } finally {
    await adapter.disconnect()
  }
}

const request = await readRequest().catch((error: unknown) => {
  throw new AutomationError('UNKNOWN', '无法读取自动化请求。', error instanceof Error ? error.message : String(error))
})

try {
  emit({ type: 'result', payload: await execute(request) })
} catch (error) {
  const normalized = normalizeError(error, request.debug ?? false)
  emit({ type: 'result', payload: { ok: false, error: { code: normalized.code, message: normalized.message, detail: normalized.detail } } })
  process.exitCode = 1
}
