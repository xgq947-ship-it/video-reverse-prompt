import { access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AutomationError, ERROR_MESSAGES } from './errors.js'

interface HubBrowserState {
  running: boolean
  mode: 'background' | 'login' | null
  pid: number | null
  cdpEndpoint: string | null
}

interface HubLease {
  leaseId: string
}

interface HubClient {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>
  acquire(params: Record<string, unknown>): Promise<{ browser: HubBrowserState; lease: HubLease }>
  heartbeat(leaseId: string): Promise<unknown>
  release(leaseId: string): Promise<unknown>
  openLogin(url: string): Promise<unknown>
}

interface HubSdk {
  ensureHub(payloadDir: string): Promise<HubClient>
}

export interface SharedBrowserLease {
  cdpEndpoint: string
  registerPage(targetId: string): Promise<void>
  release(): Promise<void>
}

let sdkPromise: Promise<{ sdk: HubSdk; payloadDir: string }> | null = null

async function resolvePayloadDir(): Promise<string> {
  const configured = process.env.AI_BROWSER_HUB_PAYLOAD?.trim()
  const candidates = [
    configured,
    resolve(process.cwd(), 'browser-hub-payload', 'current'),
    resolve(process.cwd(), '..', 'AI-Browser-Hub', 'dist', `payload-${process.platform}-${process.arch}`),
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'manifest.json'))
      await access(join(candidate, 'server', 'sdk', 'node.mjs'))
      return candidate
    } catch {
      // Try the next development or packaged location.
    }
  }
  throw new AutomationError(
    'BROWSER_UNAVAILABLE',
    '共享浏览器运行时缺失，请重新安装 Video Reverse Prompt。',
  )
}

async function loadHub(): Promise<{ sdk: HubSdk; payloadDir: string }> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const payloadDir = await resolvePayloadDir()
      const sdkUrl = pathToFileURL(join(payloadDir, 'server', 'sdk', 'node.mjs')).href
      const sdk = await import(sdkUrl) as HubSdk
      return { sdk, payloadDir }
    })()
  }
  return sdkPromise
}

async function client(): Promise<HubClient> {
  try {
    const { sdk, payloadDir } = await loadHub()
    return await sdk.ensureHub(payloadDir)
  } catch (error) {
    if (error instanceof AutomationError) throw error
    throw new AutomationError(
      'BROWSER_UNAVAILABLE',
      ERROR_MESSAGES.BROWSER_UNAVAILABLE,
      error instanceof Error ? error.message : String(error),
    )
  }
}

export async function acquireSharedBrowser(url: string): Promise<SharedBrowserLease> {
  const hub = await client()
  let acquired: { browser: HubBrowserState; lease: HubLease }
  try {
    acquired = await hub.acquire({
      appId: 'com.videoreverseprompt.desktop',
      taskId: randomUUID(),
      provider: 'gemini',
      pageKey: 'video-reverse-prompt:gemini',
      url,
      ttlMs: 120_000,
    })
  } catch (error) {
    throw new AutomationError(
      'BROWSER_UNAVAILABLE',
      error instanceof Error ? error.message : ERROR_MESSAGES.BROWSER_UNAVAILABLE,
      error instanceof Error ? error.message : String(error),
    )
  }
  if (!acquired.browser.cdpEndpoint) {
    await hub.release(acquired.lease.leaseId).catch(() => undefined)
    throw new AutomationError('BROWSER_UNAVAILABLE', ERROR_MESSAGES.BROWSER_UNAVAILABLE)
  }
  const heartbeat = setInterval(() => {
    void hub.heartbeat(acquired.lease.leaseId).catch(() => undefined)
  }, 25_000)
  heartbeat.unref()
  let released = false
  return {
    cdpEndpoint: acquired.browser.cdpEndpoint,
    async registerPage(targetId: string) {
      try {
        await hub.rpc('page.register', { leaseId: acquired.lease.leaseId, targetId })
      } catch (error) {
        const code = String((error as { code?: unknown })?.code || '')
        if (['METHOD_NOT_FOUND', 'LEASE_NOT_FOUND'].includes(code)) return
        throw new AutomationError(
          'BROWSER_UNAVAILABLE',
          error instanceof Error ? error.message : ERROR_MESSAGES.BROWSER_UNAVAILABLE,
          error instanceof Error ? error.message : String(error),
        )
      }
    },
    async release() {
      if (released) return
      released = true
      clearInterval(heartbeat)
      await hub.release(acquired.lease.leaseId).catch(() => undefined)
    },
  }
}

export async function openSharedBrowserLogin(url: string): Promise<void> {
  const hub = await client()
  try {
    await hub.openLogin(url)
  } catch (error) {
    throw new AutomationError(
      'BROWSER_UNAVAILABLE',
      error instanceof Error ? error.message : '无法打开共享 Gemini 登录窗口。',
      error instanceof Error ? error.message : String(error),
    )
  }
}
