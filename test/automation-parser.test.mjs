import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/automation/parser.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { parseAutomationResponse, parseProductionResponse } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('Reverse Prompt 原版九个标准标记可完整解析', () => {
  const markers = ['VIDEO_OVERVIEW', 'TIMELINE', 'MOTION_PROMPT', 'CAMERA_PROMPT', 'KLING', 'SEEDANCE', 'VEO', 'RUNWAY']
  const raw = `${markers.map((marker) => `---${marker}---\n${marker} content`).join('\n')}\n---JSON---\n{"duration":15}`
  const result = parseAutomationResponse(raw)
  assert.equal(result.parseWarning, undefined)
  assert.deepEqual(Object.keys(result.sections), [...markers, 'JSON'])
  assert.deepEqual(result.json, { duration: 15 })
  assert.equal(result.kind, 'video')
})

test('原版反推缺失中间标记时不会吞掉后续分区', () => {
  const raw = `---VIDEO_OVERVIEW---\n概述\n---MOTION_PROMPT---\n动作\n---RUNWAY---\nRunway 提示词`
  const result = parseAutomationResponse(raw)
  assert.equal(result.sections.VIDEO_OVERVIEW, '概述')
  assert.equal(result.sections.MOTION_PROMPT, '动作')
  assert.equal(result.sections.RUNWAY, 'Runway 提示词')
  assert.equal(result.sections.TIMELINE, undefined)
  assert.match(result.parseWarning, /3\/9/)
})

test('原版反推兼容 Markdown、中文和中英双语标题', () => {
  const raw = `## 视频概述 (VIDEO_OVERVIEW)\n概述内容\n### 镜头时间线\n分镜内容\n**动作提示词**\n动作内容\nCAMERA PROMPT:\n摄影内容\n## 可灵\n可灵内容\n## 即梦\n即梦内容\n## Google Veo\nVeo 内容\n## Runway\nRunway 内容\n## 结构化 JSON\n{"duration":15}`
  const result = parseAutomationResponse(raw)
  assert.equal(result.parseWarning, undefined)
  assert.equal(result.sections.TIMELINE, '分镜内容')
  assert.equal(result.sections.CAMERA_PROMPT, '摄影内容')
  assert.deepEqual(result.json, { duration: 15 })
})

test('只返回 JSON 时可回填原版视频分区', () => {
  const raw = '---JSON---\n{"overview":"概述","shots":[{"start":0,"end":1}],"motion_prompt":"动作","camera_prompt":"运镜","kling_prompt":"K","seedance_prompt":"S","veo_prompt":"V","runway_prompt":"R"}'
  const result = parseAutomationResponse(raw)
  assert.equal(result.sections.VIDEO_OVERVIEW, '概述')
  assert.match(result.sections.TIMELINE, /"end": 1/)
  assert.equal(result.sections.MOTION_PROMPT, '动作')
  assert.equal(result.sections.RUNWAY, 'R')
})

test('第二步剧本、角色和多分镜结果独立解析', () => {
  const raw = `---SCRIPT---\n剧本正文\n---CHARACTER_PROMPTS---\n角色提示词\n---SHOT_PROMPTS---\n镜头一\n镜头二\n---JSON---\n{"characters":[],"shots":[{"shot_id":"shot_01"}]}`
  const result = parseProductionResponse(raw)
  assert.equal(result.parseWarning, undefined)
  assert.equal(result.sections.SCRIPT, '剧本正文')
  assert.equal(result.sections.CHARACTER_PROMPTS, '角色提示词')
  assert.match(result.sections.SHOT_PROMPTS, /镜头二/)
  assert.equal(result.json.shots[0].shot_id, 'shot_01')
})
