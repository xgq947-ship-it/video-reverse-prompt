const DEFAULT_RESOLVER_ORIGIN = 'https://dyxhsdownloader.com'
const XHUS_DOUYIN_API_ORIGIN = 'https://api.xhus.cn/api/douyin'
const TIKWM_API_ORIGIN = 'https://www.tikwm.com/api/'
const FXTWITTER_API_ORIGIN = 'https://api.fxtwitter.com/2/status'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_DOUYIN_PAGE_LENGTH = 5 * 1024 * 1024
const MAX_DOUYIN_REDIRECTS = 5
const DIRECT_VIDEO_EXTENSION_RE = /\.(?:mp4|mov|m4v|webm)(?:$|[?#])/i
const TRAILING_SHARE_PUNCTUATION_RE = /[)\]}>，。！？；：、）》】」』"'`.,!?;:]+$/u
const TIKWM_HOST_RE = /(?:^|\.)(?:douyin\.com|iesdouyin\.com|tiktok\.com)$/i
const TWITTER_HOST_RE = /(?:^|\.)(?:x\.com|twitter\.com)$/i
const DOUYIN_SHARE_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

type JsonRecord = Record<string, unknown>

export interface ResolvedMedia {
  sourceUrl: string
  platform: string
  type: 'video'
  title?: string
  coverUrl?: string
  videoUrl: string
  metadata: {
    resolver: string
    author?: string
    description?: string
    duration?: number
    watermarkStatus?: 'removed' | 'original' | 'present' | string
    alternateVideoUrl?: string
    direct?: boolean
  }
}

export class MediaResolverError extends Error {
  readonly code: string

  constructor(message: string, { code = 'MEDIA_RESOLVER_FAILED', cause }: { code?: string; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'MediaResolverError'
    this.code = code
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function serviceMessage(value: unknown, fallback: string): string {
  const message = optionalString(value)
  if (!message) return fallback
  const beforeMarkup = message.split(/<(?:!doctype|html|head|body|script|link|meta)\b/i)[0]
  const normalized = beforeMarkup.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized
}

export function extractMediaUrl(input: string): string {
  const text = String(input || '').trim()
  const match = text.match(/https?:\/\/[^\s<]+/iu)
  if (!match) {
    throw new MediaResolverError('没有在分享文案中找到 http(s) 链接', { code: 'INVALID_MEDIA_URL' })
  }

  const candidate = match[0].replace(TRAILING_SHARE_PUNCTUATION_RE, '')
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new MediaResolverError('分享链接格式无效', { code: 'INVALID_MEDIA_URL' })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new MediaResolverError('只支持 http(s) 分享链接', { code: 'INVALID_MEDIA_URL' })
  }
  if (parsed.username || parsed.password) {
    throw new MediaResolverError('分享链接不能包含账号或密码', { code: 'INVALID_MEDIA_URL' })
  }
  return parsed.toString()
}

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  timer.unref?.()
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

async function readJsonResponse(response: Response, endpointName: string): Promise<JsonRecord> {
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    const contentType = response.headers?.get?.('content-type') || ''
    throw new MediaResolverError(
      `${endpointName}返回了无法识别的数据（HTTP ${response.status}${contentType ? `，${contentType}` : ''}），解析服务可能被安全验证拦截`,
      { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED', cause: error },
    )
  }
  if (!isRecord(payload)) {
    throw new MediaResolverError(`${endpointName}返回的数据格式无效`, { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
  }
  if (!response.ok) {
    throw new MediaResolverError(
      serviceMessage(payload.error, serviceMessage(payload.message, `${endpointName}请求失败（HTTP ${response.status}）`)),
      { code: 'MEDIA_RESOLVER_HTTP_ERROR' },
    )
  }
  if (payload.error) {
    const nestedError = isRecord(payload.error) ? optionalString(payload.error.message) || optionalString(payload.error.code) : undefined
    throw new MediaResolverError(serviceMessage(nestedError || payload.error, `${endpointName}拒绝了解析请求`), { code: 'MEDIA_RESOLVER_REJECTED' })
  }
  return payload
}

async function getJson(fetchImpl: typeof fetch, url: string, timeoutMs: number, endpointName: string): Promise<JsonRecord> {
  const timeout = createTimeoutSignal(timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 Video Reverse Prompt',
      },
      signal: timeout.signal,
    })
    return await readJsonResponse(response, endpointName)
  } catch (error) {
    if (error instanceof MediaResolverError) throw error
    const timedOut = timeout.signal.aborted
    throw new MediaResolverError(
      timedOut ? '媒体解析服务请求超时，请稍后重试' : `媒体解析服务不可用：${error instanceof Error ? error.message : '网络请求失败'}`,
      { code: timedOut ? 'MEDIA_RESOLVER_TIMEOUT' : 'MEDIA_RESOLVER_UNAVAILABLE', cause: error },
    )
  } finally {
    timeout.clear()
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: JsonRecord, timeoutMs: number): Promise<JsonRecord> {
  const timeout = createTimeoutSignal(timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeout.signal,
    })
    return await readJsonResponse(response, new URL(url).pathname)
  } catch (error) {
    if (error instanceof MediaResolverError) throw error
    const timedOut = timeout.signal.aborted
    throw new MediaResolverError(
      timedOut ? '媒体解析服务请求超时，请稍后重试' : `媒体解析服务不可用：${error instanceof Error ? error.message : '网络请求失败'}`,
      { code: timedOut ? 'MEDIA_RESOLVER_TIMEOUT' : 'MEDIA_RESOLVER_UNAVAILABLE', cause: error },
    )
  } finally {
    timeout.clear()
  }
}

function hostnameMatches(sourceUrl: string, pattern: RegExp): boolean {
  try {
    return pattern.test(new URL(sourceUrl).hostname)
  } catch {
    return false
  }
}

function isDouyinUrl(sourceUrl: string): boolean {
  return hostnameMatches(sourceUrl, /(?:^|\.)(?:douyin\.com|iesdouyin\.com)$/i)
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status)
}

function trustedDouyinUrl(value: string, base?: string): string {
  let parsed: URL
  try {
    parsed = new URL(value, base)
  } catch {
    throw new MediaResolverError('抖音分享页返回了无效的跳转地址', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !isDouyinUrl(parsed.toString())) {
    throw new MediaResolverError('抖音分享页跳转到了不受信任的地址', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
  }
  return parsed.toString()
}

async function getDouyinSharePage(fetchImpl: typeof fetch, sourceUrl: string, timeoutMs: number): Promise<string> {
  const timeout = createTimeoutSignal(timeoutMs)
  try {
    let currentUrl = trustedDouyinUrl(sourceUrl)
    for (let redirectCount = 0; redirectCount <= MAX_DOUYIN_REDIRECTS; redirectCount += 1) {
      const response = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': DOUYIN_SHARE_USER_AGENT,
        },
        signal: timeout.signal,
      })
      if (isRedirectStatus(response.status)) {
        const location = response.headers.get('location')
        if (!location) {
          throw new MediaResolverError('抖音分享页跳转缺少目标地址', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
        }
        if (redirectCount === MAX_DOUYIN_REDIRECTS) {
          throw new MediaResolverError('抖音分享页跳转次数过多', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
        }
        currentUrl = trustedDouyinUrl(location, currentUrl)
        continue
      }
      if (!response.ok) {
        throw new MediaResolverError(`抖音分享页请求失败（HTTP ${response.status}）`, { code: 'MEDIA_RESOLVER_HTTP_ERROR' })
      }
      const html = await response.text()
      if (!html.trim()) {
        throw new MediaResolverError('抖音分享页返回了空响应', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
      }
      if (html.length > MAX_DOUYIN_PAGE_LENGTH) {
        throw new MediaResolverError('抖音分享页响应过大', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
      }
      return html
    }
    throw new MediaResolverError('抖音分享页跳转次数过多', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
  } catch (error) {
    if (error instanceof MediaResolverError) throw error
    const timedOut = timeout.signal.aborted
    throw new MediaResolverError(
      timedOut ? '抖音分享页请求超时，请稍后重试' : `抖音分享页不可用：${error instanceof Error ? error.message : '网络请求失败'}`,
      { code: timedOut ? 'MEDIA_RESOLVER_TIMEOUT' : 'MEDIA_RESOLVER_UNAVAILABLE', cause: error },
    )
  } finally {
    timeout.clear()
  }
}

function parseWindowObject(html: string, variableName: string): JsonRecord | null {
  const assignment = html.indexOf(variableName)
  if (assignment < 0) return null
  const start = html.indexOf('{', assignment + variableName.length)
  if (start < 0) return null

  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') {
      quoted = true
      continue
    }
    if (character === '{') depth += 1
    if (character !== '}') continue
    depth -= 1
    if (depth !== 0) continue
    try {
      const parsed: unknown = JSON.parse(html.slice(start, index + 1))
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function firstRecord(value: unknown): JsonRecord | null {
  return Array.isArray(value) ? value.find(isRecord) ?? null : null
}

function douyinVideoItem(routerData: JsonRecord): JsonRecord | null {
  const loaderData = isRecord(routerData.loaderData) ? routerData.loaderData : null
  if (loaderData) {
    for (const routeData of Object.values(loaderData)) {
      if (!isRecord(routeData)) continue
      const videoInfo = isRecord(routeData.videoInfoRes) ? routeData.videoInfoRes : null
      const item = firstRecord(videoInfo?.item_list)
      if (item) return item
    }
  }

  const queue: unknown[] = [routerData]
  for (let index = 0; index < queue.length && index < 2_000; index += 1) {
    const value = queue[index]
    if (Array.isArray(value)) {
      queue.push(...value)
      continue
    }
    if (!isRecord(value)) continue
    if (isRecord(value.video) && optionalString(value.aweme_id)) return value
    queue.push(...Object.values(value))
  }
  return null
}

function firstUrl(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.url_list)) return undefined
  return value.url_list.map(optionalString).find((url): url is string => Boolean(url))
}

function cleanDouyinVideoUrl(value: string): { primary: string; alternate?: string; watermarkStatus: 'removed' | 'original' } {
  try {
    const parsed = new URL(value)
    if (!parsed.pathname.includes('/playwm/')) return { primary: parsed.toString(), watermarkStatus: 'original' }
    const alternate = parsed.toString()
    parsed.pathname = parsed.pathname.replace('/playwm/', '/play/')
    parsed.searchParams.delete('logo_name')
    return { primary: parsed.toString(), alternate, watermarkStatus: 'removed' }
  } catch {
    throw new MediaResolverError('抖音分享页返回了无效的视频地址', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
  }
}

function authorName(value: unknown): string | undefined {
  if (typeof value === 'string') return optionalString(value)
  if (!isRecord(value)) return undefined
  return optionalString(value.nickname) || optionalString(value.name) || optionalString(value.unique_id) || optionalString(value.screen_name)
}

async function resolveWithDouyinSharePage(fetchImpl: typeof fetch, sourceUrl: string, timeoutMs: number): Promise<ResolvedMedia> {
  const html = await getDouyinSharePage(fetchImpl, sourceUrl, timeoutMs)
  const routerData = parseWindowObject(html, 'window._ROUTER_DATA')
  const item = routerData ? douyinVideoItem(routerData) : null
  if (!item) {
    throw new MediaResolverError('抖音分享页没有返回可用的视频数据', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
  }
  const video = isRecord(item.video) ? item.video : null
  const videoUrl = firstUrl(video?.play_addr)
    || firstUrl(video?.play_addr_h264)
    || firstUrl(video?.download_addr)
  if (!video || !videoUrl) {
    throw new MediaResolverError('当前抖音链接不是可下载的视频，可能是图集、私密或已删除内容', { code: 'UNSUPPORTED_MEDIA_TYPE' })
  }
  const cleaned = cleanDouyinVideoUrl(videoUrl)
  const durationMs = optionalNumber(video.duration)
  return {
    sourceUrl,
    platform: 'douyin',
    type: 'video',
    title: optionalString(item.desc),
    coverUrl: firstUrl(video.cover) || firstUrl(video.origin_cover) || firstUrl(video.dynamic_cover),
    videoUrl: cleaned.primary,
    metadata: {
      resolver: 'douyin-share-page',
      author: authorName(item.author),
      duration: durationMs === undefined ? undefined : durationMs / 1_000,
      watermarkStatus: cleaned.watermarkStatus,
      alternateVideoUrl: cleaned.alternate,
    },
  }
}

async function resolveWithXhus(fetchImpl: typeof fetch, sourceUrl: string, timeoutMs: number): Promise<ResolvedMedia> {
  const payload = await getJson(
    fetchImpl,
    `${XHUS_DOUYIN_API_ORIGIN}?url=${encodeURIComponent(sourceUrl)}`,
    timeoutMs,
    '抖音备用解析接口',
  )
  const data = isRecord(payload.data) ? payload.data : null
  if (Number(payload.code) !== 200 || !data) {
    throw new MediaResolverError(serviceMessage(payload.msg, '抖音解析接口没有返回可用数据'), { code: 'MEDIA_RESOLVER_REJECTED' })
  }
  const videoUrl = optionalString(data.url)
  if (!videoUrl || (typeof data.images === 'string' && data.images !== '当前为短视频解析模式')) {
    throw new MediaResolverError('当前抖音链接不是可下载的视频，可能是图集或受限内容', { code: 'UNSUPPORTED_MEDIA_TYPE' })
  }
  return {
    sourceUrl,
    platform: 'douyin',
    type: 'video',
    title: optionalString(data.title),
    coverUrl: optionalString(data.cover),
    videoUrl,
    metadata: {
      resolver: 'xhus',
      author: authorName(data.author),
      watermarkStatus: 'removed',
    },
  }
}

async function resolveWithTikwm(fetchImpl: typeof fetch, sourceUrl: string, timeoutMs: number): Promise<ResolvedMedia> {
  const payload = await getJson(
    fetchImpl,
    `${TIKWM_API_ORIGIN}?url=${encodeURIComponent(sourceUrl)}`,
    timeoutMs,
    'TikWM 解析接口',
  )
  const data = isRecord(payload.data) ? payload.data : null
  if (Number(payload.code) !== 0 || !data) {
    throw new MediaResolverError(serviceMessage(payload.msg, 'TikWM 没有返回可用的视频'), { code: 'MEDIA_RESOLVER_REJECTED' })
  }

  const cleanVideoUrl = optionalString(data.hdplay) || optionalString(data.play)
  const watermarkedVideoUrl = optionalString(data.wmplay)
  const videoUrl = cleanVideoUrl || watermarkedVideoUrl
  if (!videoUrl) {
    throw new MediaResolverError('TikWM 返回的内容不是视频，或视频地址已失效', { code: 'UNSUPPORTED_MEDIA_TYPE' })
  }
  const author = isRecord(data.author) ? data.author : undefined
  const hostname = new URL(sourceUrl).hostname.toLowerCase()
  return {
    sourceUrl,
    platform: hostname.includes('tiktok') ? 'tiktok' : 'douyin',
    type: 'video',
    title: optionalString(data.title),
    coverUrl: optionalString(data.cover) || optionalString(data.origin_cover),
    videoUrl,
    metadata: {
      resolver: 'tikwm',
      author: authorName(author),
      duration: optionalNumber(data.duration),
      watermarkStatus: cleanVideoUrl ? 'removed' : 'present',
      alternateVideoUrl: watermarkedVideoUrl && watermarkedVideoUrl !== videoUrl ? watermarkedVideoUrl : undefined,
    },
  }
}

function twitterStatusId(sourceUrl: string): string | null {
  try {
    const parsed = new URL(sourceUrl)
    return parsed.pathname.match(/\/(?:i\/)?status(?:es)?\/(\d{2,20})/i)?.[1] ?? null
  } catch {
    return null
  }
}

function bestTwitterVideo(media: JsonRecord): { url: string; alternate?: string; duration?: number } | null {
  const videos = Array.isArray(media.videos) ? media.videos.filter(isRecord) : []
  const all = Array.isArray(media.all) ? media.all.filter(isRecord) : []
  const video = [...videos, ...all].find((item) => item.type === 'video' || item.type === 'gif')
  if (!video) return null

  const formats = Array.isArray(video.formats) ? video.formats.filter(isRecord) : []
  const mp4s = formats
    .filter((format) => format.container === 'mp4' && optionalString(format.url))
    .sort((left, right) => Number(right.bitrate || 0) - Number(left.bitrate || 0))
  const primary = optionalString(mp4s[0]?.url) || optionalString(video.url)
  if (!primary) return null
  const alternate = optionalString(mp4s[1]?.url)
  return { url: primary, alternate, duration: optionalNumber(video.duration) }
}

async function resolveWithFxTwitter(fetchImpl: typeof fetch, sourceUrl: string, timeoutMs: number): Promise<ResolvedMedia> {
  const statusId = twitterStatusId(sourceUrl)
  if (!statusId) {
    throw new MediaResolverError('X / Twitter 链接中没有找到有效的帖子 ID', { code: 'INVALID_MEDIA_URL' })
  }
  const payload = await getJson(fetchImpl, `${FXTWITTER_API_ORIGIN}/${statusId}`, timeoutMs, 'X / Twitter 解析接口')
  const status = isRecord(payload.status) ? payload.status : isRecord(payload.tweet) ? payload.tweet : null
  if (Number(payload.code) !== 200 || !status) {
    throw new MediaResolverError('没有找到可公开访问的 X / Twitter 帖子', { code: 'MEDIA_RESOLVER_REJECTED' })
  }
  const media = isRecord(status.media) ? status.media : null
  const video = media ? bestTwitterVideo(media) : null
  if (!video) {
    throw new MediaResolverError('这条 X / Twitter 帖子没有可下载的视频', { code: 'UNSUPPORTED_MEDIA_TYPE' })
  }
  const author = isRecord(status.author) ? status.author : undefined
  const thumbnail = media && Array.isArray(media.videos)
    ? media.videos.filter(isRecord).map((item) => optionalString(item.thumbnail_url)).find(Boolean)
    : undefined
  return {
    sourceUrl,
    platform: 'twitter',
    type: 'video',
    title: optionalString(status.text),
    coverUrl: thumbnail,
    videoUrl: video.url,
    metadata: {
      resolver: 'fxtwitter',
      author: authorName(author),
      duration: video.duration,
      watermarkStatus: 'original',
      alternateVideoUrl: video.alternate,
    },
  }
}

export class SocialVideoProvider {
  readonly id = 'social-video-resolver'
  private readonly fetchImpl: typeof fetch
  private readonly origin: string
  private readonly timeoutMs: number

  constructor({
    fetchImpl = fetch,
    origin = DEFAULT_RESOLVER_ORIGIN,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; origin?: string; timeoutMs?: number } = {}) {
    this.fetchImpl = fetchImpl
    this.origin = String(origin).replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url)
      return ['http:', 'https:'].includes(parsed.protocol)
    } catch {
      return false
    }
  }

  async resolve(url: string, { userInput = url }: { userInput?: string } = {}): Promise<ResolvedMedia> {
    const sourceUrl = extractMediaUrl(url)
    if (DIRECT_VIDEO_EXTENSION_RE.test(sourceUrl)) {
      let title = new URL(sourceUrl).pathname.split('/').pop() || 'video'
      try { title = decodeURIComponent(title) } catch { /* Keep malformed encoded filenames unchanged. */ }
      return {
        sourceUrl,
        platform: 'direct',
        type: 'video',
        title,
        videoUrl: sourceUrl,
        metadata: { resolver: this.id, direct: true, watermarkStatus: 'original' },
      }
    }

    if (hostnameMatches(sourceUrl, TWITTER_HOST_RE)) {
      return resolveWithFxTwitter(this.fetchImpl, sourceUrl, this.timeoutMs)
    }
    if (isDouyinUrl(sourceUrl)) {
      const errors: unknown[] = []
      try {
        return await resolveWithDouyinSharePage(this.fetchImpl, sourceUrl, this.timeoutMs)
      } catch (error) {
        errors.push(error)
      }
      try {
        return await resolveWithXhus(this.fetchImpl, sourceUrl, this.timeoutMs)
      } catch (error) {
        errors.push(error)
      }
      try {
        return await resolveWithTikwm(this.fetchImpl, sourceUrl, this.timeoutMs)
      } catch (error) {
        errors.push(error)
      }
      const unsupported = errors.find((error) => error instanceof MediaResolverError && error.code === 'UNSUPPORTED_MEDIA_TYPE')
      if (unsupported instanceof MediaResolverError) throw unsupported
      throw new MediaResolverError('抖音视频解析暂时不可用，请确认作品可公开播放后重试', {
        code: 'MEDIA_RESOLVER_UNAVAILABLE',
        cause: new AggregateError(errors, '所有抖音解析方式均失败'),
      })
    }
    if (hostnameMatches(sourceUrl, TIKWM_HOST_RE)) {
      return resolveWithTikwm(this.fetchImpl, sourceUrl, this.timeoutMs)
    }

    const resolved = await postJson(this.fetchImpl, `${this.origin}/api/resolve`, { url: sourceUrl }, this.timeoutMs)
    const finalUrl = extractMediaUrl(optionalString(resolved.finalUrl) || sourceUrl)
    const parsed = await postJson(this.fetchImpl, `${this.origin}/api/parse`, {
      url: finalUrl,
      originalUrl: sourceUrl,
      userInput: String(userInput || sourceUrl).trim(),
    }, this.timeoutMs)
    if (parsed.success === false) {
      throw new MediaResolverError(serviceMessage(parsed.error, '媒体解析失败'), { code: 'MEDIA_RESOLVER_REJECTED' })
    }
    const data = isRecord(parsed.data) ? parsed.data : null
    if (!data) {
      throw new MediaResolverError('媒体解析响应缺少 data', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
    }
    if (data.type !== 'video') {
      throw new MediaResolverError('当前链接解析为图集，目前只支持视频', { code: 'UNSUPPORTED_MEDIA_TYPE' })
    }
    const videoUrl = optionalString(data.videoUrl) || optionalString(data.videoUrlAlt)
    if (!videoUrl) {
      throw new MediaResolverError('媒体解析响应缺少可下载的视频地址', { code: 'MEDIA_RESOLVER_PROTOCOL_CHANGED' })
    }
    return {
      sourceUrl,
      platform: optionalString(parsed.provider) || 'unknown',
      type: 'video',
      title: optionalString(data.title),
      coverUrl: optionalString(data.cover),
      videoUrl,
      metadata: {
        resolver: this.id,
        author: authorName(data.author),
        description: optionalString(data.description),
        watermarkStatus: optionalString(data.watermarkStatus),
        alternateVideoUrl: optionalString(data.videoUrlAlt),
      },
    }
  }
}

export function createMediaResolver({ providers = [new SocialVideoProvider()] }: { providers?: SocialVideoProvider[] } = {}) {
  const registered = [...providers]
  return {
    providers: registered,
    async resolve(input: string): Promise<ResolvedMedia> {
      const sourceUrl = extractMediaUrl(input)
      const provider = registered.find((candidate) => candidate.canHandle(sourceUrl))
      if (!provider) {
        throw new MediaResolverError('没有可处理此链接的媒体解析器', { code: 'MEDIA_RESOLVER_NOT_FOUND' })
      }
      return provider.resolve(sourceUrl, { userInput: input })
    },
  }
}

export const mediaResolver = createMediaResolver()
