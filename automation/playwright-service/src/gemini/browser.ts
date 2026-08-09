import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { AutomationError, ERROR_MESSAGES } from '../errors.js'
import type { BrowserBehavior } from '../types.js'
import { acquireSharedBrowser, openSharedBrowserLogin, type SharedBrowserLease } from '../browserHub.js'
import type { GeminiConversation } from './protocol.js'
const PAGE_MARKER = 'video-reverse-prompt:gemini'
const PAGE_HASH = '#video-reverse-prompt'
const SESSION_MARKER_KEY = 'video-reverse-prompt-owner'
const STATE_PATH = process.platform === 'win32'
  ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'VideoReversePrompt', 'gemini-conversation.json')
  : join(homedir(), 'Library', 'Application Support', 'VideoReversePrompt', 'gemini-conversation.json')

interface ConversationState {
  conversationUrl?: string
  conversation?: GeminiConversation
}

function normalizeConversationUrl(value: string): string | null {
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.hostname !== 'gemini.google.com' || parts[0] !== 'app' || parts.length < 2) return null
    return `${url.origin}${url.pathname}`
  } catch {
    return null
  }
}

function projectBaseUrl(value: string): string {
  const url = new URL(value)
  url.hash = PAGE_HASH
  return url.toString()
}

function isProjectPageUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === 'gemini.google.com' && url.hash === PAGE_HASH
  } catch {
    return false
  }
}

async function readConversationUrl(): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8')) as Partial<ConversationState>
    return normalizeConversationUrl(state.conversationUrl ?? '')
  } catch {
    return null
  }
}

export async function loadGeminiConversation(): Promise<GeminiConversation | null> {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8')) as ConversationState
    return state.conversation?.conversationId ? state.conversation : null
  } catch {
    return null
  }
}

export async function saveGeminiConversation(conversation: GeminiConversation): Promise<void> {
  let state: ConversationState = {}
  try { state = JSON.parse(await readFile(STATE_PATH, 'utf8')) as ConversationState } catch { /* First HTTP conversation. */ }
  await mkdir(dirname(STATE_PATH), { recursive: true })
  await writeFile(STATE_PATH, `${JSON.stringify({ ...state, conversation }, null, 2)}\n`, 'utf8')
}

async function clearConversationUrl(): Promise<void> {
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf8')) as ConversationState
    if (state.conversation) {
      delete state.conversationUrl
      await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    } else {
      await rm(STATE_PATH, { force: true })
    }
  } catch {
    await rm(STATE_PATH, { force: true }).catch(() => undefined)
  }
}

export async function rememberGeminiConversation(page: Page): Promise<boolean> {
  const conversationUrl = normalizeConversationUrl(page.url())
  if (!conversationUrl) return false
  try {
    await mkdir(dirname(STATE_PATH), { recursive: true })
    let state: ConversationState = {}
    try { state = JSON.parse(await readFile(STATE_PATH, 'utf8')) as ConversationState } catch { /* First browser conversation. */ }
    await writeFile(STATE_PATH, `${JSON.stringify({ ...state, conversationUrl }, null, 2)}\n`, 'utf8')
  } catch {
    // 浏览器标签页标记仍可在当前 CDP 会话中保证复用；状态文件下次再尝试写入。
  }
  return true
}

async function pageMarker(page: Page): Promise<string | null> {
  return page.evaluate(({ marker, sessionKey }) => {
    const sessionMarker = sessionStorage.getItem(sessionKey) || ''
    return window.name === marker || sessionMarker === marker ? marker : window.name || sessionMarker
  }, { marker: PAGE_MARKER, sessionKey: SESSION_MARKER_KEY }).catch(() => null)
}

async function markProjectPage(page: Page): Promise<void> {
  await page.evaluate(({ marker, sessionKey, hash }) => {
    window.name = marker
    sessionStorage.setItem(sessionKey, marker)
    if (location.hostname === 'gemini.google.com' && location.hash !== hash) {
      history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
    }
  }, { marker: PAGE_MARKER, sessionKey: SESSION_MARKER_KEY, hash: PAGE_HASH }).catch(() => undefined)
}

async function pageTargetId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page)
  try {
    const result = await session.send('Target.getTargetInfo') as {
      targetInfo?: { targetId?: string }
    }
    const targetId = String(result.targetInfo?.targetId || '').trim()
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(targetId)) {
      throw new AutomationError('BROWSER_UNAVAILABLE', '无法登记 Video Reverse Prompt 浏览器标签。')
    }
    return targetId
  } finally {
    await session.detach().catch(() => undefined)
  }
}

async function isVideoReversePromptConversation(page: Page): Promise<boolean> {
  if (!normalizeConversationUrl(page.url())) return false
  const text = await page.locator('body').innerText({ timeout: 1200 }).catch(() => '')
  return /---VIDEO_OVERVIEW---|---REVERSE_PROMPT---|---SHOT_PROMPTS---|本次调整要求：/.test(text)
}

interface ProjectPageResult {
  page: Page | null
  closedDuplicates: number
}

function lastPage(pages: Page[]): Page | null {
  return pages.length ? pages[pages.length - 1] : null
}

async function findProjectPage(browser: Browser, conversationUrl: string | null): Promise<ProjectPageResult> {
  const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed())
  const geminiPages = pages.filter((page) => page.url().includes('gemini.google.com'))
  const markerByPage = new Map<Page, string | null>()
  const markedPages: Page[] = []
  for (const page of geminiPages) {
    const marker = await pageMarker(page)
    markerByPage.set(page, marker)
    if (marker === PAGE_MARKER) markedPages.push(page)
  }

  const projectUrlPages = geminiPages.filter((page) => isProjectPageUrl(page.url()))
  const responsiveProjectUrlPages = projectUrlPages.filter((page) => markerByPage.get(page) !== null)
  const savedPage = conversationUrl
    ? geminiPages.find((page) => normalizeConversationUrl(page.url()) === conversationUrl && markerByPage.get(page) !== null) ?? null
    : null
  const markedConversation = markedPages.find((page) => normalizeConversationUrl(page.url())) ?? null
  let page = savedPage
    ?? markedConversation
    ?? lastPage(markedPages)
    ?? lastPage(responsiveProjectUrlPages)

  // 优先复用已经打开的已保存对话；其次才使用带项目标记的对话或空白项目页。
  // 这样浏览器重启恢复多个标签页时，不会被后来创建的空白页抢占。
  if (!page) {
    for (const candidate of geminiPages) {
      if (await isVideoReversePromptConversation(candidate)) {
        page = candidate
        break
      }
    }
  }

  const ownedPages = [...new Set([
    ...projectUrlPages,
    ...markedPages,
    ...(savedPage ? [savedPage] : []),
  ])]
  let closedDuplicates = 0
  for (const duplicate of ownedPages) {
    if (duplicate === page || duplicate.isClosed()) continue
    try {
      await duplicate.close({ runBeforeUnload: false })
      closedDuplicates += 1
    } catch { /* A crashed duplicate no longer consumes a live renderer. */ }
  }
  return { page, closedDuplicates }
}

export async function connectGeminiPage(url: string, behavior: BrowserBehavior): Promise<{
  browser: Browser
  page: Page
  closedDuplicates: number
  hubLease: SharedBrowserLease
}> {
  const hubLease = await acquireSharedBrowser(projectBaseUrl(url))

  let browser: Browser
  try {
    browser = await chromium.connectOverCDP(hubLease.cdpEndpoint, { noDefaults: true })
  } catch (error) {
    await hubLease.release()
    throw new AutomationError(
      'BROWSER_UNAVAILABLE',
      ERROR_MESSAGES.BROWSER_UNAVAILABLE,
      error instanceof Error ? error.message : String(error),
    )
  }

  try {
    const context = browser.contexts()[0]
    if (!context) throw new AutomationError('BROWSER_UNAVAILABLE', ERROR_MESSAGES.BROWSER_UNAVAILABLE)

    const conversationUrl = await readConversationUrl()
    const projectPage = await findProjectPage(browser, conversationUrl)
    let page = projectPage.page
    if (!page) page = await context.newPage()
    await hubLease.registerPage(await pageTargetId(page))

    const targetUrl = conversationUrl ?? projectBaseUrl(url)
    const currentConversation = normalizeConversationUrl(page.url())
    const recognizedConversation = await isVideoReversePromptConversation(page)
    if (
      !page.url().includes('gemini.google.com')
      || (conversationUrl && currentConversation !== conversationUrl && !recognizedConversation)
      || (!conversationUrl && !isProjectPageUrl(page.url()) && !recognizedConversation)
    ) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }

    // Gemini 会把已失效的历史对话重定向到 /app。清除旧记录，避免以后每次
    // 启动都被这个失效链接带回空白页；新的完整分析发送后会保存新对话。
    if (recognizedConversation && currentConversation && currentConversation !== conversationUrl) {
      await rememberGeminiConversation(page)
    } else if (conversationUrl) {
      await page.waitForTimeout(600)
      if (!normalizeConversationUrl(page.url())) await clearConversationUrl()
    }

    await markProjectPage(page)
    if (behavior === 'show') await page.bringToFront()
    return { browser, page, closedDuplicates: projectPage.closedDuplicates, hubLease }
  } catch (error) {
    await browser.close().catch(() => undefined)
    await hubLease.release().catch(() => undefined)
    throw error
  }
}

/** 用户主动登录时使用普通 Chrome；macOS/Windows 都不携带 CDP、headless 或 automation 参数。 */
export async function openGeminiLoginWindow(url: string): Promise<void> {
  await openSharedBrowserLogin(projectBaseUrl(url))
}
