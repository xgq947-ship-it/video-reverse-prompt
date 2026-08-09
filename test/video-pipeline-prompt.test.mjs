import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

async function loadVideoPrompt(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-reverse-prompt-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const promptSource = await readFile(new URL('../src/prompts/videoPrompt.ts', import.meta.url), 'utf8')
  const prompt = ts.transpileModule(promptSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  await writeFile(path.join(directory, 'videoPrompt.mjs'), prompt)
  return import(`${pathToFileURL(path.join(directory, 'videoPrompt.mjs')).href}?t=${Date.now()}`)
}

test('第一步视频提示词与 Reverse Prompt 原版文件逐字一致', async () => {
  const source = await readFile(new URL('../src/prompts/videoPrompt.ts', import.meta.url))
  assert.equal(createHash('sha256').update(source).digest('hex'), '6989483cfe29bc8a90e4c66e13ef1fceacaea4d04ef41f44c8045577a40f661c')
})

test('Gemini 第一步只输出原版九分区，不提前生成 HotStory 内容', async (t) => {
  const { buildVideoPrompt } = await loadVideoPrompt(t)
  const prompt = buildVideoPrompt('分镜优先')
  const markers = ['VIDEO_OVERVIEW', 'TIMELINE', 'MOTION_PROMPT', 'CAMERA_PROMPT', 'KLING', 'SEEDANCE', 'VEO', 'RUNWAY', 'JSON']
  assert.deepEqual([...prompt.matchAll(/^---([A-Z_]+)---$/gm)].map((match) => match[1]), markers)
  assert.match(prompt, /当前模式追加规则：依据剪辑点/)
  assert.doesNotMatch(prompt, /SCRIPT|CHARACTER_PROMPTS|SHOT_PROMPTS|识别角色对白|生成角色提示词/)
})
