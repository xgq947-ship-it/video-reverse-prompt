import { access } from 'node:fs/promises'
import { stdin } from 'node:process'
import { AutomationError, ERROR_MESSAGES, normalizeError } from './errors.js'
import { GeminiAdapter } from './gemini/adapter.js'
import { openGeminiLoginWindow } from './gemini/browser.js'
import { generateProductionPackage } from './generation/pipeline.js'
import { createGenerationProvider, generatorStatus } from './generation/providers.js'
import { resolveAndDownloadVideo } from './media/downloader.js'
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
  if (request.command === 'generator-status') {
    const config = request.generator ?? { provider: 'deepseek' }
    return { ok: true, generatorStatus: await generatorStatus(config) }
  }
  if (request.command === 'generate-production') {
    if (!request.reverseResponse?.trim()) throw new AutomationError('UNKNOWN', '缺少 Gemini 视频反推结果。')
    const config = request.generator ?? { provider: 'deepseek' }
    try {
      const generated = await generateProductionPackage({
        reverseResponse: request.reverseResponse,
        duration: request.duration,
        filename: request.filename,
        provider: createGenerationProvider(config),
        onProgress: progress,
      })
      return { ok: true, rawResponse: generated.rawResponse }
    } catch (error) {
      if (error instanceof AutomationError) throw error
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new AutomationError('PRODUCTION_GENERATION_FAILED', message ? `生成流程失败：${message}` : '短视频剧本生成失败，请重试。', request.debug ? detail : undefined)
    }
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
    progress('sending', request.command === 'refine' ? '正在发送调整要求' : '正在发送原版视频反推提示词')
    const rawResponse = request.command === 'refine'
      ? await adapter.refine(request.prompt)
      : await adapter.analyzeFile(request.filePath!, request.prompt)
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
