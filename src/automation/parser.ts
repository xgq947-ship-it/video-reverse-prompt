import type { AnalysisResult, ProductionResult } from '../types'

const REVERSE_MARKERS = ['VIDEO_OVERVIEW', 'TIMELINE', 'MOTION_PROMPT', 'CAMERA_PROMPT', 'KLING', 'SEEDANCE', 'VEO', 'RUNWAY', 'JSON']
const PRODUCTION_MARKERS = ['SCRIPT', 'CHARACTER_PROMPTS', 'SHOT_PROMPTS', 'JSON']

const MARKER_ALIASES: Record<string, string[]> = {
  VIDEO_OVERVIEW: ['VIDEO_OVERVIEW', 'VIDEO OVERVIEW', 'OVERVIEW', '视频概述', '视频总览', '整体概述'],
  TIMELINE: ['TIMELINE', 'SHOT TIMELINE', '时间线', '镜头时间线', '分镜时间线'],
  MOTION_PROMPT: ['MOTION_PROMPT', 'MOTION PROMPT', '动作提示词', '动作反推'],
  CAMERA_PROMPT: ['CAMERA_PROMPT', 'CAMERA PROMPT', '镜头提示词', '运镜提示词', '摄影提示词'],
  KLING: ['KLING', '可灵'],
  SEEDANCE: ['SEEDANCE', '即梦', '豆包'],
  VEO: ['VEO', 'GOOGLE VEO'],
  RUNWAY: ['RUNWAY'],
  SCRIPT: ['SCRIPT', 'VIDEO SCRIPT', '剧本', '短视频剧本'],
  CHARACTER_PROMPTS: ['CHARACTER_PROMPTS', 'CHARACTER PROMPTS', '角色提示词', '人物提示词', '角色资产'],
  SHOT_PROMPTS: ['SHOT_PROMPTS', 'SHOT PROMPTS', '逐镜头提示词', '成片提示词', '逐镜头成片提示词'],
  JSON: ['JSON', '结构化 JSON', '结构化数据'],
}

interface HeaderMatch { marker: string; start: number; contentStart: number }

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').toUpperCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*\d+\s*[.、):：-]\s*/, '')
    .replace(/^\s*[-=*`~]+\s*/, '')
    .replace(/\s*[-=*`~:：]+\s*$/, '')
    .replace(/[（(【[]/g, '_').replace(/[）)】\]]/g, '_')
    .replace(/[\s/\\-]+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '')
}

function markerForLabel(value: string, markers: string[], allowCompound = false): string | null {
  const normalized = normalizeLabel(value)
  if (!normalized) return null
  for (const marker of markers) {
    for (const alias of MARKER_ALIASES[marker] ?? [marker]) {
      const normalizedAlias = normalizeLabel(alias)
      if (normalized === normalizedAlias || (allowCompound && normalized.startsWith(`${normalizedAlias}_`)) || (allowCompound && normalized.endsWith(`_${normalizedAlias}`))) return marker
    }
  }
  return null
}

function findHeaders(rawResponse: string, markers: string[]): HeaderMatch[] {
  const matches: HeaderMatch[] = []
  for (const match of rawResponse.matchAll(/---\s*([\p{L}\p{N}_ -]+?)\s*---/gu)) {
    const marker = markerForLabel(match[1], markers)
    if (marker && match.index !== undefined) matches.push({ marker, start: match.index, contentStart: match.index + match[0].length })
  }
  let offset = 0
  for (const lineWithBreak of rawResponse.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!lineWithBreak) continue
    const line = lineWithBreak.replace(/\r?\n$/, '')
    const trimmed = line.trim()
    const structuredData = /^[{[]/.test(trimmed) || /["']\s*:\s*/.test(trimmed)
    const decorated = !structuredData && (/^(?:#{1,6}\s+|[-=*`~]{2,})/.test(trimmed) || /[:：]\s*$/.test(trimmed) || /[（(【[]/.test(trimmed) || /\s[-–—|/]\s/.test(trimmed))
    const bareCanonical = /^[A-Z][A-Z0-9_ ]+$/.test(trimmed) && markers.includes(normalizeLabel(trimmed))
    const marker = trimmed && trimmed.length <= 140 && !trimmed.startsWith('```') && (decorated || bareCanonical)
      ? markerForLabel(trimmed, markers, decorated)
      : null
    if (marker) matches.push({ marker, start: offset + Math.max(0, line.indexOf(trimmed)), contentStart: offset + lineWithBreak.length })
    offset += lineWithBreak.length
  }
  return matches.sort((left, right) => left.start - right.start || right.contentStart - left.contentStart)
    .filter((match, index, sorted) => index === 0 || match.start !== sorted[index - 1].start)
}

function parseSections(rawResponse: string, markers: string[]): Record<string, string> {
  const headers = findHeaders(rawResponse, markers)
  const sections: Record<string, string> = {}
  headers.forEach((header, index) => {
    if (sections[header.marker] !== undefined) return
    const content = rawResponse.slice(header.contentStart, headers[index + 1]?.start ?? rawResponse.length).trim()
    if (content) sections[header.marker] = content
  })
  return sections
}

function parseJson(section: string | undefined, rawResponse: string): unknown | null {
  const candidates = [section ?? '', ...[...rawResponse.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1])]
  for (const source of candidates) {
    const trimmed = source.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const first = trimmed.indexOf('{')
    const last = trimmed.lastIndexOf('}')
    for (const candidate of [trimmed, first >= 0 && last > first ? trimmed.slice(first, last + 1) : '']) {
      if (!candidate) continue
      try { return JSON.parse(candidate) } catch { /* Try the next candidate. */ }
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonField(json: unknown, aliases: string[]): unknown {
  if (!isRecord(json)) return undefined
  const normalized = new Set(aliases.map(normalizeLabel))
  return Object.entries(json).find(([key]) => normalized.has(normalizeLabel(key)))?.[1]
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  return value === undefined || value === null ? '' : JSON.stringify(value, null, 2)
}

function parseResult(rawResponse: string, markers: string[], mappings: Record<string, string[]>): Omit<ProductionResult, never> {
  const sections = parseSections(rawResponse, markers)
  const json = parseJson(sections.JSON, rawResponse)
  if (json) {
    if (!sections.JSON) sections.JSON = JSON.stringify(json, null, 2)
    for (const [marker, aliases] of Object.entries(mappings)) {
      if (!sections[marker]) sections[marker] = textValue(jsonField(json, aliases))
    }
  }
  const found = markers.filter((marker) => Boolean(sections[marker])).length
  return {
    sections,
    json,
    rawResponse,
    parseWarning: found === markers.length ? undefined : found
      ? `本次返回使用了非标准标题，已自动识别 ${found}/${markers.length} 个分区；完整回答保留在“原文”。`
      : '未识别到可用分区，完整回答已保留在“原文”。',
  }
}

export function parseAutomationResponse(rawResponse: string): AnalysisResult {
  return {
    kind: 'video',
    ...parseResult(rawResponse, REVERSE_MARKERS, {
      VIDEO_OVERVIEW: ['video_overview', 'overview', 'summary'],
      TIMELINE: ['timeline', 'shots'],
      MOTION_PROMPT: ['motion_prompt'],
      CAMERA_PROMPT: ['camera_prompt'],
      KLING: ['kling_prompt'],
      SEEDANCE: ['seedance_prompt'],
      VEO: ['veo_prompt'],
      RUNWAY: ['runway_prompt'],
    }),
  }
}

export function parseProductionResponse(rawResponse: string): ProductionResult {
  return parseResult(rawResponse, PRODUCTION_MARKERS, {
    SCRIPT: ['script'],
    CHARACTER_PROMPTS: ['characters', 'character_prompts'],
    SHOT_PROMPTS: ['shots', 'shot_prompts'],
  })
}
