import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/automation/parser.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { parseAutomationResponse } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('视频生成包的六个标准标记可完整解析', () => {
  const markers = ['VIDEO_OVERVIEW', 'REVERSE_PROMPT', 'SCRIPT', 'CHARACTER_PROMPTS', 'SHOT_PROMPTS']
  const raw = `${markers.map((marker) => `---${marker}---\n${marker} content`).join('\n')}\n---JSON---\n{"duration_seconds":15}`
  const result = parseAutomationResponse(raw)
  assert.equal(result.parseWarning, undefined)
  assert.deepEqual(Object.keys(result.sections), [...markers, 'JSON'])
  assert.deepEqual(result.json, { duration_seconds: 15 })
  assert.equal(result.kind, 'video')
})

test('缺失中间标记时不会吞掉后续分区', () => {
  const raw = `---VIDEO_OVERVIEW---\n概述\n---SCRIPT---\n剧本正文\n---SHOT_PROMPTS---\n镜头提示词`
  const result = parseAutomationResponse(raw)
  assert.equal(result.sections.VIDEO_OVERVIEW, '概述')
  assert.equal(result.sections.SCRIPT, '剧本正文')
  assert.equal(result.sections.SHOT_PROMPTS, '镜头提示词')
  assert.equal(result.sections.REVERSE_PROMPT, undefined)
  assert.match(result.parseWarning, /3\/6/)
})

test('兼容 Markdown、中文和中英双语标题', () => {
  const raw = `## 视频概述 (VIDEO_OVERVIEW)\n概述内容\n### 反推提示词\n复刻内容\n**反推剧本**\n剧本内容\nCHARACTER PROMPTS:\n角色内容\n## 逐镜头成片提示词\n镜头内容\n## 结构化 JSON\n{"duration_seconds":15}`
  const result = parseAutomationResponse(raw)
  assert.equal(result.parseWarning, undefined)
  assert.equal(result.sections.VIDEO_OVERVIEW, '概述内容')
  assert.equal(result.sections.REVERSE_PROMPT, '复刻内容')
  assert.equal(result.sections.SCRIPT, '剧本内容')
  assert.equal(result.sections.CHARACTER_PROMPTS, '角色内容')
  assert.equal(result.sections.SHOT_PROMPTS, '镜头内容')
  assert.deepEqual(result.json, { duration_seconds: 15 })
})

test('只返回 JSON 时从字段回填视频分区', () => {
  const raw = '```json\n{"overview":"概述","reverse_prompt":"反推","script_segments":[{"start":"00:00"}],"characters":[],"shots":[{"start":"00:00","end":"00:01"}]}\n```'
  const result = parseAutomationResponse(raw)
  assert.equal(result.sections.VIDEO_OVERVIEW, '概述')
  assert.equal(result.sections.REVERSE_PROMPT, '反推')
  assert.match(result.sections.SCRIPT, /00:00/)
  assert.equal(result.sections.CHARACTER_PROMPTS, '[]')
  assert.match(result.sections.SHOT_PROMPTS, /00:01/)
  assert.ok(result.sections.JSON)
})
