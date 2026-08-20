import { createHash } from 'node:crypto'
import { renderHotStoryPrompt } from '../prompts/hotstory.js'
import { loadVerbatimSkills } from '../prompts/skills.js'
import type { StoryboardMode } from '../types.js'
import type { GenerationProvider } from './providers.js'

type JsonRecord = Record<string, unknown>

export interface ProductionPipelineInput {
  reverseResponse: string
  duration?: number
  filename?: string
  storyboardMode?: StoryboardMode
  protagonistTags?: string[]
  provider: GenerationProvider
  onProgress?: (stage: string, message: string) => void
}

export interface ProductionPipelineResult {
  rawResponse: string
  package: JsonRecord
}

interface CharacterDraft {
  prompt_label: string
  role: 'lead' | 'supporting'
  story_function: string
  source_fact_ids: string[]
  visual_anchor: string
  wardrobe_anchor: string
  image_prompt: string
  acting_profile: string
  voice_prompt: string
  default_use_reference: boolean
}

interface CharacterAsset extends CharacterDraft {
  id: string
  reference_token: string
  prompt_reference: string
  user_protagonist_tag?: string
  identity_basis: 'verified_role_visualization' | 'user_protagonist_tag'
  disclosure: string
  image_settings: {
    model: string
    aspect_ratio: string
    quality: string
    consistency: string
  }
  optimized_by: string
}

interface ShotPlan {
  shot_id: string
  title: string
  start_second: number
  end_second: number
  narration: string
  dialogue: string
  visual_brief: string
  active_character_ids: string[]
  event_ids: string[]
  source_ids: string[]
  source_shot_ids: string[]
  source_fact_ids: string[]
  internal_cut_times: number[]
  contains_multiple_source_shots: boolean
}

interface SourceShot {
  id: string
  fact_id: string
  start_second: number
  end_second: number
  content: JsonRecord
  derived_fallback?: boolean
}

interface GenerationSegment {
  index: number
  start_second: number
  end_second: number
  source_shot_ids: string[]
  source_fact_ids: string[]
  internal_cut_times: number[]
}

interface ShotPromptDraft {
  shot_id: string
  prompt_body_template: string
  ambient_audio: string
}

const DEFAULT_STYLE_BIBLE = '真实社会纪实电影质感，自然生活化表演，克制的低对比方向光；60%环境中性色、30%深灰阴影、10%来自现场的暖色实用光，真实皮肤、布料与旧化表面，统一自然颗粒和稳定曝光。'
const MARKERS = ['VIDEO_OVERVIEW', 'TIMELINE', 'MOTION_PROMPT', 'CAMERA_PROMPT', 'KLING', 'SEEDANCE', 'VEO', 'RUNWAY', 'JSON'] as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function shortId(prefix: 'source' | 'fact' | 'event', value: string): string {
  return `${prefix}_${sha256(value).slice(0, 16)}`
}

function asRecord(value: unknown, label = 'JSON'): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 顶层必须是对象。`)
  }
  return value as JsonRecord
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(asString).filter(Boolean)
}

function constrainedString(values: string[]): JsonRecord {
  return values.length ? { type: 'string', enum: values } : { type: 'string' }
}

function stripCodeFence(content: string): string {
  const stripped = content.trim()
  if (!stripped.startsWith('```')) return stripped
  return stripped.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

export function parseJsonContent(content: string): JsonRecord {
  const stripped = stripCodeFence(content)
  try {
    return asRecord(JSON.parse(stripped))
  } catch (firstError) {
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end <= start) throw firstError
    return asRecord(JSON.parse(stripped.slice(start, end + 1)))
  }
}

function extractMarkedSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {}
  const markerPattern = new RegExp(`^---(${MARKERS.join('|')})---\\s*$`, 'gm')
  const matches = [...raw.matchAll(markerPattern)]
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const key = match[1]
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index ?? raw.length : raw.length
    sections[key] = raw.slice(start, end).trim()
  }
  return sections
}

function numericDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseFloat(value.match(/[\d.]+/)?.[0] ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function resolveDuration(input: number | undefined, reverseJson: JsonRecord): number {
  const duration = numericDuration(input) ?? numericDuration(reverseJson.duration) ?? numericDuration(reverseJson.duration_seconds)
  if (!duration) throw new Error('无法读取原视频时长，请重新导入视频后再生成短视频剧本。')
  if (duration > 180) throw new Error('HotStory 短视频生成流程当前支持最长 180 秒的视频。')
  return Math.max(1, Math.round(duration * 1000) / 1000)
}

function timestampSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const parts = trimmed.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return undefined
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return Number.isFinite(seconds) ? seconds : undefined
}

function sourceShotBoundary(shot: JsonRecord, kind: 'start' | 'end'): number | undefined {
  const keys = kind === 'start'
    ? ['start', 'start_second', 'start_seconds', 'start_time', 'startTime']
    : ['end', 'end_second', 'end_seconds', 'end_time', 'endTime']
  for (const key of keys) {
    const seconds = timestampSeconds(shot[key])
    if (seconds !== undefined) return seconds
  }
  return undefined
}

function extractSourceShots(reverseJson: JsonRecord, duration: number, factIds: string[]): SourceShot[] {
  const rawShots = Array.isArray(reverseJson.shots) ? reverseJson.shots : []
  const records = rawShots.map((shot) => asRecord(shot, 'reverse shot'))
  const starts = records.map((shot) => sourceShotBoundary(shot, 'start'))
  const parsed = records.flatMap((shot, index): SourceShot[] => {
    const start = starts[index]
    const explicitEnd = sourceShotBoundary(shot, 'end')
    const end = explicitEnd ?? starts[index + 1] ?? duration
    if (start === undefined || !Number.isFinite(end) || end <= start) return []
    const clampedStart = Math.max(0, Math.min(duration, start))
    const clampedEnd = Math.max(0, Math.min(duration, end))
    if (clampedEnd <= clampedStart) return []
    return [{
      id: `source_shot_${String(index + 1).padStart(2, '0')}`,
      fact_id: factIds[index] ?? factIds[0] ?? '',
      start_second: Math.round(clampedStart * 1000) / 1000,
      end_second: Math.round(clampedEnd * 1000) / 1000,
      content: shot,
    }]
  }).sort((left, right) => left.start_second - right.start_second)
  if (parsed.length) return parsed
  return [{
    id: 'source_shot_01',
    fact_id: factIds[0] ?? '',
    start_second: 0,
    end_second: duration,
    content: { overview: reverseJson },
    derived_fallback: true,
  }]
}

function buildGenerationSegments(mode: StoryboardMode, duration: number, sourceShots: SourceShot[]): GenerationSegment[] {
  const windows = mode === 'source_shots'
    ? sourceShots.map((shot) => [shot.start_second, shot.end_second] as const)
    : Array.from({ length: Math.ceil(duration / 10) }, (_, index) => [index * 10, Math.min(duration, (index + 1) * 10)] as const)
  if (mode === 'source_shots' && (!sourceShots.length || sourceShots.some((shot) => shot.derived_fallback || shot.end_second <= shot.start_second))) {
    throw new Error('原视频分镜缺少有效起止时间，请先用“分镜优先”重新反推视频。')
  }
  if (windows.length > 80) throw new Error('原视频分镜超过 80 个，请改用“每 10 秒生成片段”模式。')
  return windows.map(([start, end], index) => {
    const overlapping = sourceShots.filter((shot) => shot.start_second < end && shot.end_second > start)
    const internalCutTimes = sourceShots
      .map((shot) => shot.start_second)
      .filter((cut) => cut > start && cut < end)
      .map((cut) => Math.round(cut * 1000) / 1000)
    return {
      index: index + 1,
      start_second: start,
      end_second: end,
      source_shot_ids: overlapping.map((shot) => shot.id),
      source_fact_ids: [...new Set(overlapping.map((shot) => shot.fact_id).filter(Boolean))],
      internal_cut_times: internalCutTimes,
    }
  })
}

function normalizeProtagonistTags(values: string[] | undefined): string[] {
  const tags = (values ?? []).map((value) => value.trim().replace(/^@+/, '')).filter(Boolean)
  if (tags.length > 2) throw new Error('主角标签最多填写 2 个。')
  if (tags.some((tag) => !/^[\p{L}\p{N}_-]{1,32}$/u.test(tag))) {
    throw new Error('主角标签只能包含中英文、数字、下划线或短横线，且不能超过 32 个字符。')
  }
  if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length) throw new Error('两个主角标签不能相同。')
  return tags.map((tag) => `@${tag}`)
}

function buildVerifiedContext(raw: string, sections: Record<string, string>, reverseJson: JsonRecord, filename: string): JsonRecord {
  const sourceId = shortId('source', `${filename}\n${raw}`)
  const rawShots = Array.isArray(reverseJson.shots) ? reverseJson.shots : []
  const sourceFacts = rawShots.length ? rawShots : [{ overview: sections.VIDEO_OVERVIEW, timeline: sections.TIMELINE }]
  const facts = sourceFacts.map((shot, index) => {
    const serialized = JSON.stringify(shot)
    return {
      id: shortId('fact', `${sourceId}:${index}:${serialized}`),
      statement: `原视频可见镜头 ${index + 1}：${serialized}`,
      source_ids: [sourceId],
      people: [],
      organizations: [],
      verified: true,
    }
  })
  const events = facts.map((fact, index) => ({
    id: shortId('event', `${fact.id}:${index}`),
    title: `原视频镜头 ${index + 1}`,
    summary: fact.statement,
    event_type: 'VIDEO_OBSERVATION',
    fact_ids: [fact.id],
    source_ids: [sourceId],
  }))
  return {
    topic: filename.replace(/\.[^.]+$/, '') || '参考视频',
    evidence_scope: '仅以 Gemini 对用户所选原视频的逐帧反推结果作为已核验输入，不引入外部事实。',
    source_video: {
      id: sourceId,
      filename,
      title: filename,
      type: 'user_selected_reference_video',
    },
    sources: [{ id: sourceId, title: filename, type: 'reference_video' }],
    facts,
    events,
    reverse_analysis_sections: sections,
    reverse_analysis_json: reverseJson,
    reverse_analysis_verbatim: raw,
  }
}

function characterSchema(validFactIds: string[]): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['style_bible', 'characters'],
    properties: {
      style_bible: { type: 'string', minLength: 10 },
      characters: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['prompt_label', 'role', 'story_function', 'source_fact_ids', 'visual_anchor', 'wardrobe_anchor', 'image_prompt', 'acting_profile', 'voice_prompt', 'default_use_reference'],
          properties: {
            prompt_label: { type: 'string', minLength: 2, maxLength: 80 },
            role: { type: 'string', enum: ['lead', 'supporting'] },
            story_function: { type: 'string', minLength: 2, maxLength: 300 },
            source_fact_ids: { type: 'array', items: constrainedString(validFactIds) },
            visual_anchor: { type: 'string', minLength: 10 },
            wardrobe_anchor: { type: 'string', minLength: 5 },
            image_prompt: { type: 'string', minLength: 30 },
            acting_profile: { type: 'string', minLength: 30 },
            voice_prompt: { type: 'string' },
            default_use_reference: { type: 'boolean' },
          },
        },
      },
    },
  }
}

function shotPlanSchema(count: number, characterIds: string[], eventIds: string[], sourceIds: string[]): JsonRecord {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['shots'],
    properties: {
      shots: {
        type: 'array', minItems: count, maxItems: count,
        items: {
          type: 'object', additionalProperties: false,
          required: ['shot_id', 'title', 'start_second', 'end_second', 'narration', 'dialogue', 'visual_brief', 'active_character_ids', 'event_ids', 'source_ids'],
          properties: {
            shot_id: { type: 'string', minLength: 3, maxLength: 40 },
            title: { type: 'string', minLength: 2, maxLength: 120 },
            start_second: { type: 'number', minimum: 0, maximum: 180 },
            end_second: { type: 'number', minimum: 0, maximum: 180 },
            narration: { type: 'string', maxLength: 1200 },
            dialogue: { type: 'string', maxLength: 800 },
            visual_brief: { type: 'string', minLength: 5, maxLength: 1500 },
            active_character_ids: { type: 'array', items: constrainedString(characterIds) },
            event_ids: { type: 'array', items: constrainedString(eventIds) },
            source_ids: { type: 'array', items: constrainedString(sourceIds) },
          },
        },
      },
    },
  }
}

function shotPromptSchema(expectedIds: string[]): JsonRecord {
  return {
    type: 'object', additionalProperties: false, required: ['shots'],
    properties: {
      shots: {
        type: 'array', minItems: expectedIds.length, maxItems: expectedIds.length,
        items: {
          type: 'object', additionalProperties: false,
          required: ['shot_id', 'prompt_body_template', 'ambient_audio'],
          properties: {
            shot_id: constrainedString(expectedIds),
            prompt_body_template: { type: 'string', minLength: 80 },
            ambient_audio: { type: 'string' },
          },
        },
      },
    },
  }
}

async function generateStructured(
  provider: GenerationProvider,
  systemPrompt: string,
  userPrompt: string,
  schema: JsonRecord,
  validate: (value: JsonRecord) => void,
): Promise<JsonRecord> {
  const schemaText = JSON.stringify(schema, null, 2)
  const fullPrompt = `${userPrompt}\n\n请严格返回 JSON，JSON Schema：\n${schemaText}`
  let response = await provider.generateJson(systemPrompt, fullPrompt)
  try {
    const parsed = parseJsonContent(response.content)
    validate(parsed)
    return parsed
  } catch (firstError) {
    const repairPrompt = `修复下面内容，使其严格符合给定 JSON Schema。不得添加解释或代码围栏。\n\nJSON Schema：${schemaText}\n\n待修复内容：\n${response.content}`
    response = await provider.generateJson('你是严格 JSON 修复器。只能修复格式，不得创造新的现实事实。', repairPrompt)
    try {
      const parsed = parseJsonContent(response.content)
      validate(parsed)
      return parsed
    } catch (repairError) {
      const detail = repairError instanceof Error ? repairError.message : String(repairError)
      throw new Error(`LLM JSON 校验失败：${detail}`, { cause: firstError })
    }
  }
}

function requireString(record: JsonRecord, key: string, minimum = 0): string {
  const value = asString(record[key])
  if (value.length < minimum) throw new Error(`${key} 内容不完整。`)
  return value
}

function normalizeCharacters(value: JsonRecord, validFactIds: Set<string>): { styleBible: string; characters: CharacterAsset[] } {
  const styleBible = requireString(value, 'style_bible', 10) || DEFAULT_STYLE_BIBLE
  if (!Array.isArray(value.characters)) throw new Error('characters 必须是数组。')
  if (value.characters.length > 6) throw new Error('characters 最多 6 个。')
  const characters = value.characters.map((entry, index): CharacterAsset => {
    const item = asRecord(entry, 'character')
    const role = item.role === 'lead' ? 'lead' : item.role === 'supporting' ? 'supporting' : null
    if (!role) throw new Error('角色 role 必须是 lead 或 supporting。')
    const sourceFactIds = asStringArray(item.source_fact_ids).filter((id) => validFactIds.has(id))
    if (!sourceFactIds.length) throw new Error('角色缺少来自原视频的有效 source_fact_ids。')
    const number = index + 1
    return {
      id: `char_${String(number).padStart(2, '0')}`,
      reference_token: `CHAR_${String(number).padStart(2, '0')}`,
      prompt_reference: `[[CHAR_${String(number).padStart(2, '0')}]]`,
      prompt_label: requireString(item, 'prompt_label', 2),
      role,
      story_function: requireString(item, 'story_function', 2),
      source_fact_ids: sourceFactIds,
      visual_anchor: requireString(item, 'visual_anchor', 10),
      wardrobe_anchor: requireString(item, 'wardrobe_anchor', 5),
      image_prompt: requireString(item, 'image_prompt', 30),
      acting_profile: requireString(item, 'acting_profile', 30),
      voice_prompt: asString(item.voice_prompt),
      default_use_reference: item.default_use_reference !== false,
      identity_basis: 'verified_role_visualization',
      disclosure: '影视化还原角色，不代表真实人物的实际外貌。',
      image_settings: {
        model: 'Higgsfield Soul 2.0',
        aspect_ratio: '16:9',
        quality: '2k',
        consistency: '首张满意后创建 Soul ID，并在后续镜头中复用',
      },
      optimized_by: 'lira-image-prompts + acting-ai-video',
    }
  })
  return { styleBible, characters }
}

function applyProtagonistTags(characters: CharacterAsset[], tags: string[]): CharacterAsset[] {
  let tagIndex = 0
  return characters.map((character) => {
    if (character.role !== 'lead' || tagIndex >= tags.length) return character
    const tag = tags[tagIndex]
    tagIndex += 1
    return {
      ...character,
      prompt_reference: tag,
      user_protagonist_tag: tag,
      identity_basis: 'user_protagonist_tag',
      disclosure: '人物身份与外观直接使用用户提供的主角标签，不由 AI 重新描述。',
      image_prompt: '',
    }
  })
}

function charactersForPrompt(characters: CharacterAsset[]): JsonRecord[] {
  return characters.map((character) => {
    if (!character.user_protagonist_tag) return character as unknown as JsonRecord
    return {
      id: character.id,
      role: character.role,
      prompt_label: character.prompt_label,
      prompt_reference: character.prompt_reference,
      identity_basis: character.identity_basis,
      identity_instruction: '只使用 prompt_reference 指向的标签人物；不得补写、猜测或覆盖其外貌、脸部、发型、体型与服装。',
      acting_profile: character.acting_profile,
      voice_prompt: character.voice_prompt,
    }
  })
}

function exactScriptText(value: unknown, script: string): string {
  const candidate = asString(value)
  return candidate && script.includes(candidate) ? candidate : ''
}

function normalizeShotPlan(
  value: JsonRecord,
  segments: GenerationSegment[],
  mode: StoryboardMode,
  script: string,
  characterIds: Set<string>,
  eventIds: Set<string>,
  sourceIds: Set<string>,
): ShotPlan[] {
  if (!Array.isArray(value.shots) || value.shots.length !== segments.length) throw new Error(`镜头计划必须恰好包含 ${segments.length} 个生成片段。`)
  return value.shots.map((entry, index) => {
    const item = asRecord(entry, 'shot')
    const segment = segments[index]
    const start = segment.start_second
    const end = segment.end_second
    if (mode === 'ten_second_groups' && end - start > 10.001) throw new Error('10 秒模式的单个生成片段不得超过 10 秒。')
    return {
      shot_id: `shot_${String(index + 1).padStart(2, '0')}`,
      title: requireString(item, 'title', 2).replace(/\bS(?:HOT)?\s*\d{1,3}\s*[:：-]?\s*/gi, '').trim() || `镜头 ${index + 1}`,
      start_second: start,
      end_second: end,
      narration: exactScriptText(item.narration, script),
      dialogue: exactScriptText(item.dialogue, script),
      visual_brief: requireString(item, 'visual_brief', 5),
      active_character_ids: [...new Set(asStringArray(item.active_character_ids).filter((id) => characterIds.has(id)))],
      event_ids: [...new Set(asStringArray(item.event_ids).filter((id) => eventIds.has(id)))],
      source_ids: [...new Set(asStringArray(item.source_ids).filter((id) => sourceIds.has(id)))],
      source_shot_ids: segment.source_shot_ids,
      source_fact_ids: segment.source_fact_ids,
      internal_cut_times: segment.internal_cut_times,
      contains_multiple_source_shots: segment.source_shot_ids.length > 1,
    }
  })
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  async function consume(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()))
  return results
}

function validatePromptBatch(value: JsonRecord, expectedIds: string[]): ShotPromptDraft[] {
  if (!Array.isArray(value.shots) || value.shots.length !== expectedIds.length) throw new Error('逐镜头提示词返回数量不完整。')
  const items = value.shots.map((entry): ShotPromptDraft => {
    const item = asRecord(entry, 'shot prompt')
    return {
      shot_id: requireString(item, 'shot_id'),
      prompt_body_template: requireString(item, 'prompt_body_template', 80),
      ambient_audio: asString(item.ambient_audio),
    }
  })
  const returnedIds = new Set(items.map((item) => item.shot_id))
  if (returnedIds.size !== expectedIds.length || expectedIds.some((id) => !returnedIds.has(id))) {
    throw new Error('逐镜头提示词返回的 shot_id 不完整或被修改。')
  }
  return items
}

function attachAudio(body: string, ambient: string, narration: string, dialogue: string, voiceLines: string[]): string {
  const lines = [body.trim(), '', '音频（使用模型原生音频）', ambient || '与当前环境一致的真实同期环境声。']
  if (narration) lines.push(`旁白逐字："${narration}"`)
  if (dialogue) {
    lines.push(`对白逐字："${dialogue}"`)
    lines.push(...voiceLines)
  }
  lines.push('除上述内容外无额外人声，无字幕。')
  return lines.join('\n').trim()
}

function enforceCharacterReferences(body: string, plan: ShotPlan, characterById: Map<string, CharacterAsset>): string {
  let result = body.trim()
  for (const characterId of plan.active_character_ids) {
    const character = characterById.get(characterId)
    if (!character) continue
    const generatedToken = `[[${character.reference_token}]]`
    if (character.user_protagonist_tag) result = result.replaceAll(generatedToken, character.prompt_reference)
    if (result.includes(character.prompt_reference)) continue
    const anchor = character.user_protagonist_tag
      ? `${character.prompt_reference} 作为当前镜头人物，身份和外观完全由该标签锁定。`
      : `${character.prompt_reference}：${character.visual_anchor}，当前镜头保持身份与造型一致。`
    result = `人物引用\n${anchor}\n\n${result}`
  }
  return result
}

function formatCharacters(characters: CharacterAsset[], styleBible: string): string {
  if (!characters.length) return `全片视觉圣经\n${styleBible}\n\n原视频中没有需要跨镜头复用的明确角色，因此不生成角色参考图。`
  return [
    `全片视觉圣经\n${styleBible}`,
    ...characters.map((character) => [
      `## ${character.reference_token} · ${character.prompt_label}`,
      `角色 ID：${character.id}`,
      `角色类型：${character.role === 'lead' ? '主角' : '配角'}`,
      `故事功能：${character.story_function}`,
      ...(character.user_protagonist_tag
        ? ['', '### 用户主角标签', `${character.user_protagonist_tag}（直接使用该标签人物，不生成或覆盖人物外貌）`]
        : [`视觉锚点：${character.visual_anchor}`, `服装锚点：${character.wardrobe_anchor}`, '', '### 角色参考图提示词', character.image_prompt]),
      '',
      '### 表演主档案',
      character.acting_profile,
      ...(character.voice_prompt ? ['', '### 固定声线', character.voice_prompt] : []),
    ].join('\n')),
  ].join('\n\n')
}

function formatShots(shots: JsonRecord[]): string {
  return shots.map((shot) => [
    `## ${shot.shot_id} · ${shot.title} · ${Number(shot.start_second).toFixed(3)}—${Number(shot.end_second).toFixed(3)} 秒`,
    String(shot.prompt_body_template),
  ].join('\n\n')).join('\n\n---\n\n')
}

export async function generateProductionPackage(input: ProductionPipelineInput): Promise<ProductionPipelineResult> {
  const notify = input.onProgress ?? (() => undefined)
  const reverseResponse = input.reverseResponse.trim()
  if (!reverseResponse) throw new Error('缺少 Gemini 视频反推结果。')
  const sections = extractMarkedSections(reverseResponse)
  if (!sections.JSON) throw new Error('Gemini 反推结果缺少 ---JSON--- 分区，请先重新完成视频反推。')
  const reverseJson = parseJsonContent(sections.JSON)
  const duration = resolveDuration(input.duration, reverseJson)
  const storyboardMode: StoryboardMode = input.storyboardMode === 'source_shots' ? 'source_shots' : 'ten_second_groups'
  const protagonistTags = normalizeProtagonistTags(input.protagonistTags)
  const filename = input.filename?.trim() || 'reference-video.mp4'
  const context = buildVerifiedContext(reverseResponse, sections, reverseJson, filename)
  const topic = asString(context.topic) || '参考视频'
  const skills = await loadVerbatimSkills()
  const validFactIds = new Set((context.facts as JsonRecord[]).map((item) => asString(item.id)))
  const sourceShots = extractSourceShots(reverseJson, duration, [...validFactIds])
  const segments = buildGenerationSegments(storyboardMode, duration, sourceShots)
  context.source_shots = sourceShots
  const contextJson = JSON.stringify(context, null, 2)

  notify('writing-script', storyboardMode === 'ten_second_groups' ? '正在按 10 秒片段无损重排原视频剧本' : '正在按原视频分镜整理剧本')
  const reblockingRule = storyboardMode === 'ten_second_groups'
    ? '按从 0 秒开始、每段最多 10 秒重新编排时间块。一个 10 秒时间块可以原样容纳多个原视频镜头与剪辑点，以减少后续视频生成次数；必须保持原镜头顺序、镜头内容、人物动作、对白、旁白与事件因果完全不变，只能改变分段边界和排版。'
    : '严格沿用 reverse_analysis_json.shots 中每个原视频镜头的起止时间、顺序与内容，不合并、不拆分、不改写镜头。'
  const scriptBasePrompt = await renderHotStoryPrompt('script_writer', {
    duration,
    segmentation_rule: reblockingRule,
    segment_plan: JSON.stringify(segments, null, 2),
    context: contextJson,
  })
  const scriptPrompt = `${scriptBasePrompt}\n\n<VIDEO_REVERSE_PROMPT_ADAPTATION>\n本项目的“已核验素材”来自用户所选原视频的 Gemini 反推结果。必须以 reverse_analysis_verbatim、reverse_analysis_sections 与 reverse_analysis_json 为完整依据；不得把反推中没有出现的内容写成事实。${reblockingRule} 不得为了“更有戏剧性”增删或改写原视频的剧本内容、分镜内容、人物、场景、动作、对白、旁白、声音或叙事结果。输入中提供的 source_id、fact_id、event_id 均为该原视频证据的稳定引用 ID。\n</VIDEO_REVERSE_PROMPT_ADAPTATION>`
  const scriptResponse = await input.provider.generateText(
    '真实性高于戏剧性。剧本只能使用输入中的已核验事实和真实 ID。',
    scriptPrompt,
  )
  const script = scriptResponse.content.trim()
  if (script.length < 80) throw new Error('短视频剧本返回内容不完整。')

  notify('creating-characters', '正在用 Lira 与 Acting 完整 Skill 生成角色资产')
  const characterPrompt = await renderHotStoryPrompt('character_assets', {
    topic,
    script,
    context: contextJson,
    lira_skill: skills['lira-image-prompts'].content,
    acting_skill: skills['acting-ai-video'].content,
  })
  const rawCharacters = await generateStructured(
    input.provider,
    '你是 Lira 图像提示词优化师与影视表演导演。只使用已核验人物依据。',
    characterPrompt,
    characterSchema([...validFactIds]),
    (value) => { normalizeCharacters(value, validFactIds) },
  )
  const normalizedCharacters = normalizeCharacters(rawCharacters, validFactIds)
  const styleBible = normalizedCharacters.styleBible
  const characters = applyProtagonistTags(normalizedCharacters.characters, protagonistTags)
  if (protagonistTags.length > characters.filter((character) => character.role === 'lead').length) {
    throw new Error(`填写了 ${protagonistTags.length} 个主角标签，但剧本只识别到 ${characters.filter((character) => character.role === 'lead').length} 个主角。`)
  }

  const targetShotCount = segments.length
  notify('planning-shots', storyboardMode === 'ten_second_groups' ? `正在规划 ${targetShotCount} 个 10 秒生成片段` : `正在沿用 ${targetShotCount} 个原视频分镜`)
  const shotPlanPrompt = await renderHotStoryPrompt('shot_plan', {
    topic,
    duration,
    target_shot_count: targetShotCount,
    segmentation_mode: storyboardMode,
    segmentation_rule: storyboardMode === 'ten_second_groups'
      ? '每个生成片段最多 10 秒；片段内必须按 internal_cut_times 保留一个或多个原视频镜头，可使用受控硬切。'
      : '每个生成片段与一个原视频镜头一一对应，起止时间必须完全沿用，禁止合并或拆分。',
    segment_plan: JSON.stringify(segments, null, 2),
    script,
    characters: JSON.stringify(characters, null, 2),
    context: contextJson,
  })
  const characterIds = new Set(characters.map((item) => item.id))
  const eventIds = new Set((context.events as JsonRecord[]).map((item) => asString(item.id)))
  const sourceIds = new Set((context.sources as JsonRecord[]).map((item) => asString(item.id)))
  const rawShotPlan = await generateStructured(
    input.provider,
    '你是严格的纪录片分镜规划师。不得改写旁白或创造现实事实。',
    shotPlanPrompt,
    shotPlanSchema(targetShotCount, [...characterIds], [...eventIds], [...sourceIds]),
    (value) => { normalizeShotPlan(value, segments, storyboardMode, script, characterIds, eventIds, sourceIds) },
  )
  const shotPlan = normalizeShotPlan(rawShotPlan, segments, storyboardMode, script, characterIds, eventIds, sourceIds)

  const chunks: ShotPlan[][] = []
  for (let offset = 0; offset < shotPlan.length; offset += 4) chunks.push(shotPlan.slice(offset, offset + 4))
  notify('generating-shots', `正在生成 ${shotPlan.length} 个可直接复制的视频提示词`)
  const generatedBatches = await mapWithConcurrency(chunks, 3, async (chunk, batchIndex) => {
    notify('generating-shots', `正在生成第 ${batchIndex + 1}/${chunks.length} 批分镜提示词`)
    const activeIds = new Set(chunk.flatMap((shot) => shot.active_character_ids))
    const activeCharacters = characters.filter((character) => activeIds.has(character.id))
    const cinematicPrompt = await renderHotStoryPrompt('cinematic_shots', {
      style_bible: styleBible,
      characters: JSON.stringify(charactersForPrompt(activeCharacters), null, 2),
      shots: JSON.stringify(chunk, null, 2),
      character_reference_rule: protagonistTags.length
        ? '带 user_protagonist_tag 的主角必须逐字使用 prompt_reference（例如 @标签），不得再写该人物的外貌、脸部、发型、体型或服装描述；其他角色使用其 [[CHAR_XX]]。'
        : '每个角色使用其 prompt_reference（即 [[CHAR_XX]]），并用已生成的视觉锚点保持一致。',
      segment_editing_rule: storyboardMode === 'ten_second_groups'
        ? '一个生成片段可以包含多个原视频镜头。必须按 source_shot_ids 的顺序与 internal_cut_times 使用受控硬切，逐个保留全部原镜头内容，不得融合、删减、替换或创造镜头。'
        : '一个生成片段只对应一个原视频镜头，严格保持原时长、原动作和原镜头内容，不得增加片内硬切。',
      previous_prompts: '{}',
      acting_skill: skills['acting-ai-video'].content,
      cinedance_skill: skills['cinedance-higgsfield'].content,
    })
    const expectedIds = chunk.map((shot) => shot.shot_id)
    const rawBatch = await generateStructured(
      input.provider,
      '你是 CINEDANCE V4 电影提示词导演，并严格执行 Acting 表演系统。',
      cinematicPrompt,
      shotPromptSchema(expectedIds),
      (value) => { validatePromptBatch(value, expectedIds) },
    )
    return validatePromptBatch(rawBatch, expectedIds)
  })
  const generated = new Map(generatedBatches.flat().map((item) => [item.shot_id, item]))
  const characterById = new Map(characters.map((item) => [item.id, item]))
  const shots: JsonRecord[] = shotPlan.map((plan) => {
    const generatedPrompt = generated.get(plan.shot_id)
    if (!generatedPrompt) throw new Error(`缺少 ${plan.shot_id} 的成片提示词。`)
    const body = enforceCharacterReferences(generatedPrompt.prompt_body_template, plan, characterById)
    const voiceLines = plan.active_character_ids.flatMap((id) => {
      const character = characterById.get(id)
      return character?.voice_prompt ? [`${character.prompt_reference} 固定声线：${character.voice_prompt}`] : []
    })
    const completePrompt = attachAudio(body, generatedPrompt.ambient_audio, plan.narration, plan.dialogue, plan.dialogue ? voiceLines : [])
    return {
      ...plan,
      duration_seconds: Math.round((plan.end_second - plan.start_second) * 1000) / 1000,
      prompt_body_template: completePrompt,
      ambient_audio: generatedPrompt.ambient_audio,
      target_model: 'Seedance 2.0 / Higgsfield Seedance',
      optimized_by: 'acting-ai-video + cinedance-higgsfield',
      revision: 1,
    }
  })

  const packageData: JsonRecord = {
    version: '1.3',
    generated_at: new Date().toISOString(),
    source_filename: filename,
    source_reverse_prompt_sha256: sha256(reverseResponse),
    duration_seconds: duration,
    llm_profile: `${scriptResponse.provider}:${scriptResponse.model}`,
    generation_provider: scriptResponse.provider,
    generation_model: scriptResponse.model,
    storyboard_mode: storyboardMode,
    storyboard_mode_label: storyboardMode === 'ten_second_groups' ? '每 10 秒一个生成片段（片段内可含多个原分镜）' : '沿用原视频分镜时长',
    protagonist_tags: protagonistTags,
    max_shot_duration_seconds: storyboardMode === 'ten_second_groups' ? 10 : Math.max(...shots.map((shot) => Number(shot.duration_seconds))),
    generation_mode: storyboardMode === 'ten_second_groups' ? 'lossless_10_second_reblock' : 'source_shot_timing',
    warnings: [],
    prompt_preservation: 'lossless',
    style_bible: styleBible,
    skills: [
      { order: 1, skill: 'lira-image-prompts', purpose: '角色、造型与参考图提示词', instruction_mode: 'verbatim', source_sha256: skills['lira-image-prompts'].sha256 },
      { order: 2, skill: 'acting-ai-video', purpose: '角色表演主档案与逐镜头表演适配', instruction_mode: 'verbatim', source_sha256: skills['acting-ai-video'].sha256 },
      { order: 3, skill: 'cinedance-higgsfield', purpose: '可直接生成视频的镜头调度提示词', instruction_mode: 'verbatim', source_sha256: skills['cinedance-higgsfield'].sha256 },
    ],
    script,
    characters,
    shots,
  }
  const characterText = formatCharacters(characters, styleBible)
  const shotText = formatShots(shots)
  const rawResponse = [
    '---SCRIPT---', script,
    '---CHARACTER_PROMPTS---', characterText,
    '---SHOT_PROMPTS---', shotText,
    '---JSON---', JSON.stringify(packageData, null, 2),
  ].join('\n')
  notify('completed', '短视频剧本、角色与分镜提示词已生成')
  return { rawResponse, package: packageData }
}
