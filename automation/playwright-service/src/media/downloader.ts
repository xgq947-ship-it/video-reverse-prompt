import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { mediaResolver, type ResolvedMedia } from './resolver.js'

export const MAX_IMPORTED_VIDEO_BYTES = 1024 * 1024 * 1024

const SUPPORTED_EXTENSION_RE = /^\.(?:mp4|mov|m4v|webm)$/i
const EXTENSION_BY_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/x-m4v': '.m4v',
  'video/webm': '.webm',
  'application/octet-stream': '.mp4',
  'binary/octet-stream': '.mp4',
}

type LookupAddress = { address: string; family?: number }
type LookupImpl = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>
type Resolver = { resolve(input: string): Promise<ResolvedMedia> }

export interface ImportedVideoFile {
  filePath: string
  name: string
  size: number
  extension: string
  type: 'video'
  sourceUrl: string
  platform: string
  title?: string
  author?: string
  coverUrl?: string
  duration?: number
  watermarkStatus?: string
}

export class VideoDownloadError extends Error {
  readonly code: string

  constructor(message: string, { code = 'VIDEO_DOWNLOAD_FAILED', cause }: { code?: string; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'VideoDownloadError'
    this.code = code
  }
}

function normalizeMimeType(value: string | null | undefined): string {
  return String(value || '').split(';')[0].trim().toLowerCase()
}

function extensionForVideo({ mimeType, url }: { mimeType?: string; url?: string }): string {
  const normalizedMime = normalizeMimeType(mimeType)
  if (EXTENSION_BY_MIME[normalizedMime]) return EXTENSION_BY_MIME[normalizedMime]
  if (url) {
    let pathname = String(url)
    try { pathname = new URL(pathname).pathname } catch { pathname = pathname.split(/[?#]/)[0] }
    const extension = path.extname(pathname).toLowerCase()
    if (SUPPORTED_EXTENSION_RE.test(extension)) return extension
  }
  throw new VideoDownloadError('解析结果不是受支持的 MP4、MOV、M4V 或 WebM 视频', { code: 'UNSUPPORTED_VIDEO_FORMAT' })
}

function ipv4ToNumber(address: string): number | null {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0
}

function inIpv4Range(address: string, base: string, prefix: number): boolean {
  const value = ipv4ToNumber(address)
  const baseValue = ipv4ToNumber(base)
  if (value === null || baseValue === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (baseValue & mask)
}

export function isPrivateNetworkAddress(address: string): boolean {
  const ipVersion = net.isIP(address)
  if (ipVersion === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4],
    ].some(([base, prefix]) => inIpv4Range(address, String(base), Number(prefix)))
  }
  if (ipVersion === 6) {
    const normalized = String(address).toLowerCase().split('%')[0]
    if (normalized.startsWith('::ffff:')) return isPrivateNetworkAddress(normalized.slice('::ffff:'.length))
    return normalized === '::'
      || normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith('ff')
      || normalized.startsWith('2001:db8:')
  }
  return true
}

export async function assertPublicMediaUrl(
  value: string,
  { lookupImpl = ((hostname, options) => dns.lookup(hostname, options)) as LookupImpl }: { lookupImpl?: LookupImpl } = {},
): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(String(value || ''))
  } catch {
    throw new VideoDownloadError('解析服务返回了无效的视频地址', { code: 'INVALID_DOWNLOAD_URL' })
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new VideoDownloadError('解析服务返回了不安全的视频地址', { code: 'UNSAFE_DOWNLOAD_URL' })
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (hostname.toLowerCase() === 'localhost') {
    throw new VideoDownloadError('拒绝下载本机或内网地址', { code: 'UNSAFE_DOWNLOAD_URL' })
  }

  const directIp = net.isIP(hostname) ? [{ address: hostname }] : null
  let addresses: LookupAddress[]
  try {
    addresses = directIp || await lookupImpl(hostname, { all: true, verbatim: true })
  } catch (error) {
    throw new VideoDownloadError(`无法解析视频下载域名：${hostname}`, { code: 'DOWNLOAD_DNS_FAILED', cause: error })
  }
  // Local proxy/TUN software may map public hostnames to 198.18.0.0/15. Keep
  // allowing that hostname mapping while still blocking literal private IPs.
  const proxySyntheticAddress = (address: string) => !directIp
    && net.isIP(address) === 4
    && inIpv4Range(address, '198.18.0.0', 15)
  if (!addresses.length || addresses.some((entry) => (
    isPrivateNetworkAddress(entry.address) && !proxySyntheticAddress(entry.address)
  ))) {
    throw new VideoDownloadError('拒绝下载本机或内网地址', { code: 'UNSAFE_DOWNLOAD_URL' })
  }
  return parsed
}

function nodeReadable(responseBody: Response['body']): NodeJS.ReadableStream {
  if (!responseBody) {
    throw new VideoDownloadError('视频下载地址返回了空响应', { code: 'EMPTY_VIDEO' })
  }
  return Readable.fromWeb(responseBody as never)
}

async function fetchPublicVideo(url: string, {
  fetchImpl,
  lookupImpl,
  signal,
  referer,
  range,
  maxRedirects = 5,
}: {
  fetchImpl: typeof fetch
  lookupImpl: LookupImpl
  signal: AbortSignal
  referer?: string
  range: string
  maxRedirects?: number
}): Promise<{ response: Response; finalUrl: string }> {
  let current = String(url)
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    await assertPublicMediaUrl(current, { lookupImpl })
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5',
        range,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        ...(referer ? { referer } : {}),
      },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new VideoDownloadError('视频下载重定向缺少目标地址', { code: 'DOWNLOAD_FAILED' })
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok) {
      throw new VideoDownloadError(`视频下载失败（HTTP ${response.status}）`, { code: 'DOWNLOAD_FAILED' })
    }
    return { response, finalUrl: current }
  }
  throw new VideoDownloadError('视频下载重定向次数过多', { code: 'DOWNLOAD_FAILED' })
}

function validateDownloadedVideoResponse(response: Response): string {
  const contentType = normalizeMimeType(response.headers.get('content-type'))
  const genericBinary = ['application/octet-stream', 'binary/octet-stream'].includes(contentType)
  if (contentType && !contentType.startsWith('video/') && !genericBinary) {
    throw new VideoDownloadError(`下载地址返回了 ${contentType}，不是有效视频`, { code: 'DOWNLOAD_NOT_VIDEO' })
  }
  return contentType
}

function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
  if (!match) return null
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) }
}

async function downloadVideoUrl({
  mediaUrl,
  sourceUrl,
  outputDir,
  fetchImpl = fetch,
  lookupImpl = ((hostname, options) => dns.lookup(hostname, options)) as LookupImpl,
  maxBytes = MAX_IMPORTED_VIDEO_BYTES,
  downloadTimeoutMs = 180_000,
  downloadChunkBytes = 4 * 1024 * 1024,
}: {
  mediaUrl: string
  sourceUrl?: string
  outputDir: string
  fetchImpl?: typeof fetch
  lookupImpl?: LookupImpl
  maxBytes?: number
  downloadTimeoutMs?: number
  downloadChunkBytes?: number
}): Promise<{ filePath: string; name: string; size: number; extension: string }> {
  await fsp.mkdir(outputDir, { recursive: true })
  const id = crypto.randomUUID()
  const temporaryPath = path.join(outputDir, `.social-video-${id}.download`)
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(new Error('视频下载超时')), downloadTimeoutMs)
  timeout.unref?.()
  let finalPath = ''

  try {
    const chunkBytes = Math.max(256 * 1024, Math.min(downloadChunkBytes, 16 * 1024 * 1024))
    let requestUrl = mediaUrl
    let nextOffset = 0
    let totalBytes: number | null = null
    let writtenBytes = 0
    let finalUrl = mediaUrl
    let contentType = ''

    do {
      if (nextOffset >= maxBytes) {
        throw new VideoDownloadError('单个视频不能超过 1GB', { code: 'VIDEO_TOO_LARGE' })
      }
      const requestedEnd = Math.min(nextOffset + chunkBytes - 1, maxBytes - 1)
      const fetched = await fetchPublicVideo(requestUrl, {
        fetchImpl,
        lookupImpl,
        signal: timeoutController.signal,
        referer: sourceUrl,
        range: `bytes=${nextOffset}-${requestedEnd}`,
      })
      const { response } = fetched
      finalUrl = fetched.finalUrl
      requestUrl = finalUrl
      const responseType = validateDownloadedVideoResponse(response)
      if (!contentType) contentType = responseType

      const contentRange = parseContentRange(response.headers.get('content-range'))
      if (response.status === 206) {
        if (!contentRange || contentRange.start !== nextOffset || contentRange.end < contentRange.start) {
          throw new VideoDownloadError('视频 CDN 返回了无效的分段范围', { code: 'DOWNLOAD_PROTOCOL_ERROR' })
        }
        if (contentRange.total !== null) {
          totalBytes = contentRange.total
          if (totalBytes > maxBytes) throw new VideoDownloadError('单个视频不能超过 1GB', { code: 'VIDEO_TOO_LARGE' })
        }
      } else if (nextOffset > 0) {
        throw new VideoDownloadError('视频 CDN 未按要求继续分段下载', { code: 'DOWNLOAD_PROTOCOL_ERROR' })
      } else {
        const contentLength = Number(response.headers.get('content-length'))
        if (contentLength > maxBytes) throw new VideoDownloadError('单个视频不能超过 1GB', { code: 'VIDEO_TOO_LARGE' })
      }

      const before = writtenBytes
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          writtenBytes += chunk.length
          if (writtenBytes > maxBytes) {
            callback(new VideoDownloadError('单个视频不能超过 1GB', { code: 'VIDEO_TOO_LARGE' }))
            return
          }
          callback(null, chunk)
        },
      })
      await pipeline(
        nodeReadable(response.body),
        limiter,
        fs.createWriteStream(temporaryPath, { flags: nextOffset === 0 ? 'wx' : 'a' }),
      )
      const received = writtenBytes - before
      if (received === 0) throw new VideoDownloadError('视频下载地址返回了空文件', { code: 'EMPTY_VIDEO' })
      if (response.status !== 206) {
        totalBytes = writtenBytes
        break
      }
      const expected = contentRange!.end - contentRange!.start + 1
      if (received !== expected) {
        throw new VideoDownloadError('视频下载连接在分段传输中断开', { code: 'DOWNLOAD_INTERRUPTED' })
      }
      nextOffset = contentRange!.end + 1
      if (totalBytes === null && received < chunkBytes) totalBytes = nextOffset
    } while (totalBytes === null || nextOffset < totalBytes)

    const stat = await fsp.stat(temporaryPath)
    if (stat.size === 0 || stat.size !== writtenBytes) {
      throw new VideoDownloadError('视频下载地址返回了空文件', { code: 'EMPTY_VIDEO' })
    }
    const extensionWithDot = extensionForVideo({ mimeType: contentType, url: finalUrl })
    const name = `social-video-${id}${extensionWithDot}`
    finalPath = path.join(outputDir, name)
    await fsp.rename(temporaryPath, finalPath)
    return {
      filePath: finalPath,
      name,
      size: stat.size,
      extension: extensionWithDot.slice(1),
    }
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => undefined)
    if (finalPath) await fsp.rm(finalPath, { force: true }).catch(() => undefined)
    if (timeoutController.signal.aborted) {
      throw new VideoDownloadError('视频下载超时，请重试', { code: 'DOWNLOAD_TIMEOUT', cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function resolveAndDownloadVideo({
  input,
  outputDir,
  resolver = mediaResolver,
  onProgress,
  fetchImpl = fetch,
  lookupImpl = ((hostname, options) => dns.lookup(hostname, options)) as LookupImpl,
}: {
  input: string
  outputDir: string
  resolver?: Resolver
  onProgress?: (stage: 'resolving' | 'downloading', message: string) => void
  fetchImpl?: typeof fetch
  lookupImpl?: LookupImpl
}): Promise<ImportedVideoFile> {
  onProgress?.('resolving', '正在识别平台并解析无水印视频')
  const resolved = await resolver.resolve(input)
  const candidates = [resolved.videoUrl, resolved.metadata.alternateVideoUrl]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
  onProgress?.('downloading', `已解析 ${resolved.platform} 视频，正在保存到本机`)

  let lastError: unknown
  for (const mediaUrl of candidates) {
    try {
      const downloaded = await downloadVideoUrl({
        mediaUrl,
        sourceUrl: resolved.sourceUrl,
        outputDir,
        fetchImpl,
        lookupImpl,
      })
      return {
        ...downloaded,
        type: 'video',
        sourceUrl: resolved.sourceUrl,
        platform: resolved.platform,
        title: resolved.title,
        author: resolved.metadata.author,
        coverUrl: resolved.coverUrl,
        duration: resolved.metadata.duration,
        watermarkStatus: resolved.metadata.watermarkStatus,
      }
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new VideoDownloadError('解析结果没有可下载的视频地址', { code: 'DOWNLOAD_FAILED' })
}
