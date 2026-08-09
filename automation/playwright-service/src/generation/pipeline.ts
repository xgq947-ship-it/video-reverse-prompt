import { createHash } from 'node:crypto'
import { renderHotStoryPrompt } from '../prompts/hotstory.js'
import { loadVerbatimSkills } from '../prompts/skills.js'
import type { GenerationProvider } from './providers.js'

type JsonRecord = Record<string, unknown>

export interface ProductionPipelineInput {
  reverseResponse: string
  duration?: number
  filename?: string
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
  identity_basis: 'verified_role_visualization'
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

function exactScriptText(value: unknown, script: string): string {
  const candidate = asString(value)
  return candidate && script.includes(candidate) ? candidate : ''
}

function shotWindow(index: number, duration: number, count: number): [number, number] {
  const start = Math.round((index * duration / count) * 1000) / 1000
  const end = Math.round(((index + 1) * duration / count) * 1000) / 1000
  return [start, end]
}

function normalizeShotPlan(
  value: JsonRecord,
  count: number,
  duration: number,
  script: string,
  characterIds: Set<string>,
  eventIds: Set<string>,
  sourceIds: Set<string>,
): ShotPlan[] {
  if (!Array.isArray(value.shots) || value.shots.length !== count) throw new Error(`镜头计划必须恰好包含 ${count} 个镜头。`)
  return value.shots.map((entry, index) => {
    const item = asRecord(entry, 'shot')
    const [start, end] = shotWindow(index, duration, count)
    if (end - start > 10.001) throw new Error('单个镜头不得超过 10 秒。')
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

function formatCharacters(characters: CharacterAsset[], styleBible: string): string {
  if (!characters.length) return `全片视觉圣经\n${styleBible}\n\n原视频中没有需要跨镜头复用的明确角色，因此不生成角色参考图。`
  return [
    `全片视觉圣经\n${styleBible}`,
    ...characters.map((character) => [
      `## ${character.reference_token} · ${character.prompt_label}`,
      `角色 ID：${character.id}`,
      `角色类型：${character.role === 'lead' ? '主角' : '配角'}`,
      `故事功能：${character.story_function}`,
      `视觉锚点：${character.visual_anchor}`,
      `服装锚点：${character.wardrobe_anchor}`,
      '',
      '### 角色参考图提示词',
      character.image_prompt,
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
  const filename = input.filename?.trim() || 'reference-video.mp4'
  const context = buildVerifiedContext(reverseResponse, sections, reverseJson, filename)
  const contextJson = JSON.stringify(context, null, 2)
  const topic = asString(context.topic) || '参考视频'
  const skills = await loadVerbatimSkills()

  notify('writing-script', '正在根据反推结果生成短视频剧本')
  const scriptBasePrompt = await renderHotStoryPrompt('script_writer', { duration, context: contextJson })
  const scriptPrompt = `${scriptBasePrompt}\n\n<VIDEO_REVERSE_PROMPT_ADAPTATION>\n本项目的“已核验素材”来自用户所选原视频的 Gemini 反推结果。必须以 reverse_analysis_verbatim、reverse_analysis_sections 与 reverse_analysis_json 为完整依据；不得把反推中没有出现的内容写成事实。时间线、人物动作、对白和声音应复刻原片可见/可听信息，同时把结果整理成可继续生成角色与多分镜提示词的短视频剧本。输入中提供的 source_id、fact_id、event_id 均为该原视频证据的稳定引用 ID。\n</VIDEO_REVERSE_PROMPT_ADAPTATION>`
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
  const validFactIds = new Set((context.facts as JsonRecord[]).map((item) => asString(item.id)))
  const rawCharacters = await generateStructured(
    input.provider,
    '你是 Lira 图像提示词优化师与影视表演导演。只使用已核验人物依据。',
    characterPrompt,
    characterSchema([...validFactIds]),
    (value) => { normalizeCharacters(value, validFactIds) },
  )
  const { styleBible, characters } = normalizeCharacters(rawCharacters, validFactIds)

  const targetShotCount = Math.max(1, Math.min(18, Math.ceil(duration / 10)))
  notify('planning-shots', `正在规划 ${targetShotCount} 个连续分镜`)
  const shotPlanPrompt = await renderHotStoryPrompt('shot_plan', {
    topic,
    duration,
    target_shot_count: targetShotCount,
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
    (value) => { normalizeShotPlan(value, targetShotCount, duration, script, characterIds, eventIds, sourceIds) },
  )
  const shotPlan = normalizeShotPlan(rawShotPlan, targetShotCount, duration, script, characterIds, eventIds, sourceIds)

  const chunks: ShotPlan[][] = []
  for (let offset = 0; offset < shotPlan.length; offset += 4) chunks.push(shotPlan.slice(offset, offset + 4))
  notify('generating-shots', `正在生成 ${shotPlan.length} 个可直接复制的视频提示词`)
  const generatedBatches = await mapWithConcurrency(chunks, 3, async (chunk, batchIndex) => {
    notify('generating-shots', `正在生成第 ${batchIndex + 1}/${chunks.length} 批分镜提示词`)
    const activeIds = new Set(chunk.flatMap((shot) => shot.active_character_ids))
    const activeCharacters = characters.filter((character) => activeIds.has(character.id))
    const cinematicPrompt = await renderHotStoryPrompt('cinematic_shots', {
      style_bible: styleBible,
      characters: JSON.stringify(activeCharacters, null, 2),
      shots: JSON.stringify(chunk, null, 2),
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
    let body = generatedPrompt.prompt_body_template.trim()
    for (const characterId of plan.active_character_ids) {
      const character = characterById.get(characterId)
      if (!character) continue
      const token = `[[${character.reference_token}]]`
      if (!body.includes(token)) {
        body = `人物锚点\n${token}：${character.visual_anchor}，当前镜头保持身份与造型一致。\n\n${body}`
      }
    }
    const voiceLines = plan.active_character_ids.flatMap((id) => {
      const character = characterById.get(id)
      return character?.voice_prompt ? [`[[${character.reference_token}]] 固定声线：${character.voice_prompt}`] : []
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
    version: '1.2',
    generated_at: new Date().toISOString(),
    source_filename: filename,
    source_reverse_prompt_sha256: sha256(reverseResponse),
    duration_seconds: duration,
    llm_profile: `${scriptResponse.provider}:${scriptResponse.model}`,
    generation_provider: scriptResponse.provider,
    generation_model: scriptResponse.model,
    max_shot_duration_seconds: 10,
    generation_mode: 'ai_optimized',
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
