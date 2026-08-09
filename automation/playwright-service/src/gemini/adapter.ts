import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { AutomationError, ERROR_MESSAGES } from '../errors.js'
import type { BrowserBehavior } from '../types.js'
import { parseGeminiAuth } from './auth.js'
import { connectGeminiPage, loadGeminiConversation, saveGeminiConversation } from './browser.js'
import type { SharedBrowserLease } from '../browserHub.js'
import {
  GEMINI_UPLOAD_ENDPOINT,
  buildStreamRequest,
  extractConversation,
  extractStreamPayloads,
  extractText,
  isQuotaRefusal,
  nextRequestId,
  type GeminiAsset,
  type GeminiBootstrap,
  type GeminiConversation,
} from './protocol.js'

interface HttpResponse {
  ok: boolean
  status: number
  statusText: string
  text: string
  headers: Record<string, string>
}

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
}

export class GeminiAdapter {
  private browser: Browser | null = null
  private page: Page | null = null
  private bootstrap: GeminiBootstrap | null = null
  private requestId: number | undefined
  private hubLease: SharedBrowserLease | null = null

  constructor(private readonly url: string, private readonly behavior: BrowserBehavior, private readonly log: (message: string) => void) {}

  async init(): Promise<void> {
    const connected = await connectGeminiPage(this.url, this.behavior)
    this.browser = connected.browser
    this.page = connected.page
    this.hubLease = connected.hubLease
    this.log('Browser connected')
    if (connected.closedDuplicates) this.log(`Closed ${connected.closedDuplicates} duplicate Video Reverse Prompt tab(s)`)
  }

  async openGemini(): Promise<void> {
    const page = this.requirePage()
    if (!page.url().includes('gemini.google.com')) await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    this.log('Gemini page opened')
  }

  async checkLogin(): Promise<boolean> {
    await this.throwIfHumanVerification()
    this.bootstrap = await this.readBootstrap()
    if (this.bootstrap.signedIn) this.log('Authenticated Gemini HTTP session detected')
    return this.bootstrap.signedIn
  }

  async hasConversation(): Promise<boolean> {
    return Boolean((await loadGeminiConversation())?.conversationId)
  }

  async analyzeFile(filePath: string, prompt: string): Promise<string> {
    const file = await readFile(filePath)
    const mimeType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'video/mp4'
    const asset = await this.uploadFile({
      fileName: basename(filePath),
      mimeType,
      bodyBase64: file.toString('base64'),
      byteLength: file.length,
    })
    return this.streamGenerate(prompt, [asset], await loadGeminiConversation())
  }

  async refine(prompt: string): Promise<string> {
    const conversation = await loadGeminiConversation()
    if (!conversation?.conversationId) throw new AutomationError('CONVERSATION_REQUIRED', ERROR_MESSAGES.CONVERSATION_REQUIRED)
    return this.streamGenerate(prompt, [], conversation)
  }

  async compatibilityCheck(): Promise<Record<string, boolean>> {
    const bootstrap = this.bootstrap ?? await this.readBootstrap()
    return {
      'Gemini HTTP Session': bootstrap.signedIn && Boolean(bootstrap.at),
      'StreamGenerate Protocol': Boolean(bootstrap.bl && bootstrap.fSid),
      'Media Upload Channel': bootstrap.feedIds.length > 0,
    }
  }

  async disconnect(): Promise<void> {
    await this.browser?.close().catch(() => undefined)
    await this.hubLease?.release().catch(() => undefined)
    this.page = null
    this.browser = null
    this.hubLease = null
    this.bootstrap = null
  }

  private async readBootstrap(): Promise<GeminiBootstrap> {
    const page = this.requirePage()
    await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    const bootstrap = await page.evaluate(async () => {
      const globalData = (window as Window & { WIZ_global_data?: Record<string, unknown> }).WIZ_global_data ?? {}
      let html = document.documentElement?.innerHTML ?? ''
      let fetchedHtml = ''
      if (!globalData.SNlM0e || !globalData.cfb2h || !globalData.FdrFJe || !globalData.S06Grb) {
        try {
          const response = await fetch('https://gemini.google.com/app', { credentials: 'include', headers: { 'cache-control': 'no-cache' } })
          fetchedHtml = await response.text()
          if (fetchedHtml) html = fetchedHtml
        } catch { /* The loaded document remains the primary source. */ }
      }
      const pick = (key: string): string => {
        const direct = globalData[key]
        if (direct !== undefined && direct !== null) return String(direct)
        const patterns = [
          new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`),
          new RegExp(`'${key}'\\s*:\\s*'([^']+)'`),
          new RegExp(`${key}\\\\":\\\\"([^\\\\"]+)`),
        ]
        for (const pattern of patterns) {
          const match = html.match(pattern)
          if (match?.[1]) return match[1]
        }
        return ''
      }
      const at = pick('SNlM0e')
      const bl = pick('cfb2h')
      const fSid = pick('FdrFJe')
      const userId = pick('S06Grb')
      const feedIds = [...new Set((html.match(/feeds\/[a-zA-Z0-9]{6,}/g) ?? []))].slice(0, 8)
      return { at, bl, fSid, userId, feedIds }
    })
    const auth = parseGeminiAuth(JSON.stringify({ S06Grb: bootstrap.userId, SNlM0e: bootstrap.at }))
    return { ...bootstrap, signedIn: auth.status === 'logged-in' }
  }

  private async uploadFile(
    file: { fileName: string; mimeType: string; bodyBase64: string; byteLength: number },
  ): Promise<GeminiAsset> {
    const bootstrap = this.requireBootstrap()
    if (!bootstrap.feedIds.length) throw new AutomationError('UPLOAD_FAILED', 'Gemini HTTP 上传通道不可用，请重新打开 Gemini 后重试。')
    const timeoutMs = 300_000
    const failures: string[] = []
    for (const feedId of bootstrap.feedIds) {
      const start = await this.pageFetch({
        url: GEMINI_UPLOAD_ENDPOINT,
        method: 'POST',
        headers: {
          'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(file.byteLength),
          'x-goog-upload-protocol': 'resumable',
          'x-tenant-id': 'bard-storage',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'push-id': feedId,
        },
        textBody: `File name: ${file.fileName}`,
      }, timeoutMs)
      if (!start.ok) { failures.push(`初始化 HTTP ${start.status}`); continue }
      const uploadUrl = start.headers['x-goog-upload-url'] || start.headers.location
      if (!uploadUrl) { failures.push('未返回续传地址'); continue }
      const finalized = await this.pageFetch({
        url: uploadUrl,
        method: 'POST',
        headers: {
          'x-goog-upload-command': 'upload, finalize',
          'x-goog-upload-offset': '0',
          'x-tenant-id': 'bard-storage',
        },
        bodyBase64: file.bodyBase64,
      }, timeoutMs)
      const resourcePath = finalized.text.trim()
      if (finalized.ok && resourcePath.startsWith('/contrib_service/')) {
        this.log(`HTTP upload complete: ${file.fileName}`)
        return { resourcePath, fileName: file.fileName, mimeType: file.mimeType }
      }
      failures.push(finalized.ok ? '未返回资源路径' : `上传 HTTP ${finalized.status}`)
    }
    throw new AutomationError('UPLOAD_FAILED', ERROR_MESSAGES.UPLOAD_FAILED, failures.join('; '))
  }

  private async streamGenerate(
    prompt: string,
    assets: GeminiAsset[],
    conversation: GeminiConversation | null,
  ): Promise<string> {
    let bootstrap = this.requireBootstrap()
    let response: HttpResponse | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.requestId = nextRequestId(this.requestId)
      const request = buildStreamRequest(bootstrap, prompt, assets, conversation ?? {}, this.requestId)
      response = await this.pageFetch({
        url: request.url,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        textBody: request.body,
      }, 600_000)
      if (response.status !== 429 || attempt > 0) break
      this.log('Gemini HTTP rate limited; refreshing session and retrying once')
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      this.bootstrap = await this.readBootstrap()
      bootstrap = this.requireBootstrap()
    }
    if (!response) throw new AutomationError('GEMINI_UNREACHABLE', ERROR_MESSAGES.GEMINI_UNREACHABLE)
    if (response.status === 401 || response.status === 403) throw new AutomationError('LOGIN_REQUIRED', ERROR_MESSAGES.LOGIN_REQUIRED)
    if (response.status === 429) throw new AutomationError('RATE_LIMITED', ERROR_MESSAGES.RATE_LIMITED)
    if (!response.ok) throw new AutomationError('GEMINI_UNREACHABLE', `Gemini HTTP 请求失败（${response.status || response.statusText}）。`)

    const payloads = extractStreamPayloads(response.text)
    if (!payloads.length) throw new AutomationError('PROTOCOL_CHANGED', 'Gemini HTTP 响应无法解析，网页协议可能已更新。')
    const text = extractText(payloads)
    if (!text) throw new AutomationError('UNKNOWN', 'Gemini 没有返回可读取的回答。')
    if (isQuotaRefusal(text)) throw new AutomationError('QUOTA_EXCEEDED', ERROR_MESSAGES.QUOTA_EXCEEDED)
    const nextConversation = extractConversation(payloads)
    if (nextConversation.conversationId) await saveGeminiConversation(nextConversation)
    this.log('Gemini HTTP response complete')
    return text
  }

  private async pageFetch(
    spec: { url: string; method: string; headers: Record<string, string>; textBody?: string; bodyBase64?: string },
    timeoutMs: number,
  ): Promise<HttpResponse> {
    return this.requirePage().evaluate(async ({ spec: request, timeout }) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        let body: BodyInit | undefined = request.textBody
        if (request.bodyBase64) {
          const binary = atob(request.bodyBase64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          body = bytes.buffer
        }
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body,
          credentials: 'include',
          signal: controller.signal,
        })
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          text: await response.text(),
          headers: Object.fromEntries(response.headers.entries()),
        }
      } catch (error) {
        return { ok: false, status: 0, statusText: error instanceof Error ? error.message : String(error), text: '', headers: {} }
      } finally {
        clearTimeout(timer)
      }
    }, { spec, timeout: timeoutMs })
  }

  private async throwIfHumanVerification(): Promise<void> {
    const page = this.requirePage()
    const url = page.url()
    const text = await page.locator('body').innerText({ timeout: 1200 }).catch(() => '')
    if (/accounts\.google\.com|challenge|captcha/i.test(url) || /verify it.?s you|验证.*身份|验证码|two-step verification/i.test(text)) {
      throw new AutomationError('HUMAN_VERIFICATION', ERROR_MESSAGES.HUMAN_VERIFICATION)
    }
  }

  private requireBootstrap(): GeminiBootstrap {
    if (!this.bootstrap?.signedIn) throw new AutomationError('LOGIN_REQUIRED', ERROR_MESSAGES.LOGIN_REQUIRED)
    if (!this.bootstrap.bl || !this.bootstrap.fSid) throw new AutomationError('LOGIN_REQUIRED', 'Gemini 登录会话不完整，请重新登录后重试。')
    return this.bootstrap
  }

  private requirePage(): Page {
    if (!this.page) throw new AutomationError('GEMINI_UNREACHABLE', ERROR_MESSAGES.GEMINI_UNREACHABLE)
    return this.page
  }
}
