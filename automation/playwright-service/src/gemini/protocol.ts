export interface GeminiConversation {
  conversationId?: string
  responseId?: string
  candidateId?: string
  contextToken?: string
}

export interface GeminiAsset {
  resourcePath: string
  fileName: string
  mimeType: string
}

export interface GeminiBootstrap {
  at: string
  bl: string
  fSid: string
  feedIds: string[]
  userId: string
  signedIn: boolean
}

export const GEMINI_ORIGIN = 'https://gemini.google.com'
export const GEMINI_UPLOAD_ENDPOINT = 'https://push.clients6.google.com/upload/'
const GEMINI_STREAM_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'

export function buildConversationTuple(conversation: GeminiConversation = {}): unknown[] {
  return [
    conversation.conversationId ?? '',
    conversation.responseId ?? '',
    conversation.candidateId ?? '',
    null, null, null, null, null, null,
    conversation.contextToken ?? '',
  ]
}

export function buildStreamPayload(prompt: string, assets: GeminiAsset[], conversation: GeminiConversation): unknown[] {
  const attachments = assets.length
    ? assets.map((asset) => [[[asset.resourcePath, 1, null, asset.mimeType], asset.fileName]])
    : null
  // Gemini expects a flat attachment list, not one nested list per asset.
  const normalizedAttachments = attachments?.map((entry) => entry[0]) ?? null
  return [[prompt, 0, null, normalizedAttachments, null, null, 0], ['en'], buildConversationTuple(conversation)]
}

export function buildStreamRequest(
  bootstrap: Pick<GeminiBootstrap, 'at' | 'bl' | 'fSid'>,
  prompt: string,
  assets: GeminiAsset[],
  conversation: GeminiConversation,
  requestId: number,
): { url: string; body: string } {
  const query = new URLSearchParams({
    bl: bootstrap.bl,
    'f.sid': bootstrap.fSid,
    hl: 'en',
    _reqid: String(requestId),
    rt: 'c',
  })
  const form = new URLSearchParams()
  form.set('f.req', JSON.stringify([null, JSON.stringify(buildStreamPayload(prompt, assets, conversation))]))
  form.set('at', bootstrap.at)
  return { url: `${GEMINI_ORIGIN}${GEMINI_STREAM_PATH}?${query}`, body: form.toString() }
}

export function nextRequestId(previous?: number): number {
  return previous ? previous + 100_000 : Math.floor(Math.random() * 900_000) + 100_000
}

function readBalancedArray(source: string, from: number): { text: string; end: number } | null {
  const start = source.indexOf('[', from)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return { text: source.slice(start, index + 1), end: index + 1 }
    }
  }
  return null
}

export function parseBatchExecuteChunks(raw: string): unknown[] {
  let source = String(raw || '')
  const prefix = source.indexOf(")]}'")
  if (prefix >= 0) source = source.slice(prefix + 4)
  const chunks: unknown[] = []
  let cursor = 0
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor)
    if (newline < 0) break
    const header = source.slice(cursor, newline).trim()
    const length = Number(header)
    if (Number.isInteger(length) && length > 0 && header !== '') {
      const body = source.slice(newline + 1, newline + 1 + length)
      try {
        chunks.push(JSON.parse(body))
        cursor = newline + 1 + length
        continue
      } catch { /* Multi-byte lengths can differ; use balanced parsing below. */ }
    }
    const balanced = readBalancedArray(source, newline + 1)
    if (!balanced) break
    try { chunks.push(JSON.parse(balanced.text)) } catch { /* Keep later frames readable. */ }
    cursor = balanced.end
  }
  return chunks
}

export function extractStreamPayloads(raw: string): unknown[] {
  const payloads: unknown[] = []
  for (const chunk of parseBatchExecuteChunks(raw)) {
    if (!Array.isArray(chunk)) continue
    for (const envelope of chunk) {
      if (!Array.isArray(envelope) || envelope[0] !== 'wrb.fr' || typeof envelope[2] !== 'string') continue
      try { payloads.push(JSON.parse(envelope[2])) } catch { /* Ignore one malformed frame. */ }
    }
  }
  return payloads
}

function walk(value: unknown, visitor: (value: unknown) => void, depth = 0): void {
  if (depth > 40) return
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor, depth + 1))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => walk(item, visitor, depth + 1))
  } else {
    visitor(value)
  }
}

function walkArrays(value: unknown, visitor: (value: unknown[]) => void, depth = 0): void {
  if (depth > 40 || !Array.isArray(value)) return
  visitor(value)
  value.forEach((item) => walkArrays(item, visitor, depth + 1))
}

function looksLikeProse(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text.length < 2 || text.length > 200_000 || /^(https?:)?\/\//.test(text) || text.includes('://')) return false
  if (/^(c_|r_|rc_|\/contrib_service\/)/.test(text) || /^Aw[A-Za-z0-9+/_-]{22,}={0,2}$/.test(text) || /^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(text)) return false
  const wordish = (text.match(/[\p{L}\p{N}\s，。！？、；：“”"'.,!?;:]/gu) ?? []).length
  // Video Reverse Prompt intentionally asks for ---SECTION_NAME--- markers, so the
  // prose score must tolerate their underscores and dashes.
  return wordish / text.length > 0.65
}

export function extractText(payloads: unknown[]): string {
  let structural = ''
  walkArrays(payloads, (node) => {
    if (typeof node[0] !== 'string' || !node[0].startsWith('rc_') || !Array.isArray(node[1])) return
    const text = node[1].find(looksLikeProse)
    if (typeof text === 'string' && text.length > structural.length) structural = text
  })
  if (structural) return structural.trim()

  let best = ''
  walk(payloads, (value) => {
    if (looksLikeProse(value) && value.length > best.length) best = value
  })
  return best.trim()
}

export function extractConversation(payloads: unknown[]): GeminiConversation {
  const conversation: GeminiConversation = {}
  walk(payloads, (value) => {
    if (typeof value !== 'string') return
    if (!conversation.conversationId && /^c_[0-9a-f]{8,}$/i.test(value)) conversation.conversationId = value
    else if (!conversation.responseId && /^r_[0-9a-f]{8,}$/i.test(value)) conversation.responseId = value
    else if (!conversation.candidateId && /^rc_[0-9a-f]{8,}$/i.test(value)) conversation.candidateId = value
    else if (!conversation.contextToken && value.startsWith('Aw') && /^[A-Za-z0-9+/_-]{24,}={0,2}$/.test(value)) conversation.contextToken = value
  })
  return conversation
}

/**
 * Gemini 的正文可能讨论“额度 / quota / limit”，不能仅凭关键词判定失败。
 * 真正的额度拒绝通常是短回答，而且不会包含 Video Reverse Prompt 的分段结果。
 */
export function isQuotaRefusal(text: string): boolean {
  const value = String(text || '').trim()
  if (!value || value.length > 1_000 || /---(?:PROMPT|VIDEO|TIMELINE|JSON)_?/.test(value)) return false
  return /(?:额度|配额).{0,36}(?:用尽|用完|耗尽|不足|上限|重置)/i.test(value)
    || /(?:用尽|用完|耗尽|不足|上限).{0,36}(?:额度|配额)/i.test(value)
    || /\b(?:quota|limit).{0,48}(?:exhausted|used up|reached|reset)\b/i.test(value)
    || /\b(?:you.?ve|you have) reached (?:your|the) (?:daily )?limit\b/i.test(value)
}
