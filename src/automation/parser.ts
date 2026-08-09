import type { AnalysisResult } from '../types'

const VIDEO_MARKERS = ['VIDEO_OVERVIEW', 'REVERSE_PROMPT', 'SCRIPT', 'CHARACTER_PROMPTS', 'SHOT_PROMPTS', 'JSON']

const MARKER_ALIASES: Record<string, string[]> = {
  VIDEO_OVERVIEW: ['VIDEO_OVERVIEW', 'VIDEO OVERVIEW', 'OVERVIEW', '视频概述', '视频总览', '整体概述'],
  REVERSE_PROMPT: ['REVERSE_PROMPT', 'REVERSE PROMPT', '反推提示词', '视频反推提示词', '复刻提示词'],
  SCRIPT: ['SCRIPT', 'VIDEO SCRIPT', '剧本', '反推剧本', '视频剧本', '纯画面剧本'],
  CHARACTER_PROMPTS: ['CHARACTER_PROMPTS', 'CHARACTER PROMPTS', '角色提示词', '人物提示词', '角色资产'],
  SHOT_PROMPTS: ['SHOT_PROMPTS', 'SHOT PROMPTS', '逐镜头提示词', '成片提示词', '逐镜头成片提示词'],
  JSON: ['JSON', '结构化 JSON', '结构化数据'],
}

interface HeaderMatch {
  marker: string
  start: number
  contentStart: number
}

function normalizeLabel(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*\d+\s*[.\u3001):\uff1a-]\s*/, '')
    .replace(/^\s*[-=*`~]+\s*/, '')
    .replace(/\s*[-=*`~:\uff1a]+\s*$/, '')
    .replace(/[\uff08(\u3010[]/g, '_')
    .replace(/[\uff09)\u3011\]]/g, '_')
    .replace(/[\s/\\-]+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function markerForLabel(value: string, markers: string[], allowCompound = false): string | null {
  const normalized = normalizeLabel(value)
  if (!normalized) return null
  for (const marker of markers) {
    const aliases = MARKER_ALIASES[marker] ?? [marker]
    for (const alias of aliases) {
      const normalizedAlias = normalizeLabel(alias)
      if (
        normalized === normalizedAlias
        || (allowCompound && normalized.startsWith(`${normalizedAlias}_`))
        || (allowCompound && normalized.endsWith(`_${normalizedAlias}`))
      ) return marker
    }
  }
  return null
}

function findHeaders(rawResponse: string, markers: string[]): HeaderMatch[] {
  const matches: HeaderMatch[] = []
  const canonicalPattern = /---\s*([\p{L}\p{N}_ -]+?)\s*---/gu
  for (const match of rawResponse.matchAll(canonicalPattern)) {
    const marker = markerForLabel(match[1], markers)
    if (marker && match.index !== undefined) {
      matches.push({ marker, start: match.index, contentStart: match.index + match[0].length })
    }
  }

  let offset = 0
  const lines = rawResponse.match(/[^\n]*(?:\n|$)/g) ?? []
  for (const lineWithBreak of lines) {
    if (!lineWithBreak) continue
    const line = lineWithBreak.replace(/\r?\n$/, '')
    const trimmed = line.trim()
    const structuredData = /^[{[]/.test(trimmed) || /["']\s*:\s*/.test(trimmed)
    const decorated = !structuredData && (
      /^(?:#{1,6}\s+|[-=*`~]{2,})/.test(trimmed)
      || /[:\uff1a]\s*$/.test(trimmed)
      || /[\uff08(\u3010[]/.test(trimmed)
      || /\s[-\u2013\u2014|/]\s/.test(trimmed)
    )
    const marker = trimmed && trimmed.length <= 140 && !trimmed.startsWith('```')
      ? markerForLabel(trimmed, markers, decorated)
      : null
    if (marker) {
      const lineStart = offset + Math.max(0, line.indexOf(trimmed))
      matches.push({ marker, start: lineStart, contentStart: offset + lineWithBreak.length })
    }
    offset += lineWithBreak.length
  }

  return matches
    .sort((left, right) => left.start - right.start || right.contentStart - left.contentStart)
    .filter((match, index, sorted) => index === 0 || match.start !== sorted[index - 1].start)
}

function parseSections(rawResponse: string, markers: string[]): Record<string, string> {
  const headers = findHeaders(rawResponse, markers)
  const sections: Record<string, string> = {}
  headers.forEach((header, index) => {
    if (sections[header.marker] !== undefined) return
    const next = headers[index + 1]
    const content = rawResponse.slice(header.contentStart, next?.start ?? rawResponse.length).trim()
    if (content) sections[header.marker] = content
  })
  return sections
}

function jsonCandidates(section: string | undefined, rawResponse: string): string[] {
  const candidates: string[] = []
  if (section) candidates.push(section)
  for (const match of rawResponse.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1])
  candidates.push(rawResponse)
  return candidates.flatMap((candidate) => {
    const trimmed = candidate.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    return firstBrace >= 0 && lastBrace > firstBrace
      ? [trimmed, trimmed.slice(firstBrace, lastBrace + 1)]
      : [trimmed]
  })
}

function parseJson(section: string | undefined, rawResponse: string): unknown | null {
  for (const candidate of jsonCandidates(section, rawResponse)) {
    try { return JSON.parse(candidate) } catch { /* Try the next candidate. */ }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonField(json: unknown, aliases: string[]): unknown {
  if (!isRecord(json)) return undefined
  const normalizedAliases = new Set(aliases.map(normalizeLabel))
  const entry = Object.entries(json).find(([key]) => normalizedAliases.has(normalizeLabel(key)))
  return entry?.[1]
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

function populateFromJson(sections: Record<string, string>, json: unknown): void {
  const mappings = {
    VIDEO_OVERVIEW: ['video_overview', 'overview', 'summary'],
    REVERSE_PROMPT: ['reverse_prompt', 'reproduction_prompt', 'video_prompt'],
    SCRIPT: ['script', 'video_script', 'script_segments'],
    CHARACTER_PROMPTS: ['character_prompts', 'characters', 'character_assets'],
    SHOT_PROMPTS: ['shot_prompts', 'cinematic_prompts', 'shots'],
  }
  for (const [marker, aliases] of Object.entries(mappings)) {
    if (sections[marker]) continue
    const value = textValue(jsonField(json, aliases))
    if (value) sections[marker] = value
  }
}

export function parseAutomationResponse(rawResponse: string): AnalysisResult {
  const sections = parseSections(rawResponse, VIDEO_MARKERS)
  const json = parseJson(sections.JSON, rawResponse)
  if (json) {
    if (!sections.JSON) sections.JSON = JSON.stringify(json, null, 2)
    populateFromJson(sections, json)
  }
  const found = VIDEO_MARKERS.filter((marker) => Boolean(sections[marker])).length
  return {
    kind: 'video',
    sections,
    json,
    rawResponse,
    parseWarning: found === VIDEO_MARKERS.length
      ? undefined
      : found
        ? `Gemini 本次返回了非标准标题，已自动识别 ${found}/${VIDEO_MARKERS.length} 个分区；完整回答保留在 Raw。`
        : '未识别到可用分区，完整回答已保留在 Raw。',
  }
}
