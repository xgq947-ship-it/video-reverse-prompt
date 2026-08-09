import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

async function loadVideoPrompt(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'video-reverse-prompt-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const [workflowSource, promptSource] = await Promise.all([
    readFile(new URL('../src/prompts/workflows.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/prompts/videoPrompt.ts', import.meta.url), 'utf8'),
  ])
  const options = { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }
  const workflows = ts.transpileModule(workflowSource, options).outputText
  const prompt = ts.transpileModule(promptSource, options).outputText.replace("'./workflows'", "'./workflows.mjs'")
  await Promise.all([
    writeFile(path.join(directory, 'workflows.mjs'), workflows),
    writeFile(path.join(directory, 'videoPrompt.mjs'), prompt),
  ])
  return import(`${pathToFileURL(path.join(directory, 'videoPrompt.mjs')).href}?t=${Date.now()}`)
}

test('镜头数按原视频时长向上取整且单镜头上限为 10 秒', async (t) => {
  const { plannedShotCount, buildVideoPrompt } = await loadVideoPrompt(t)
  assert.equal(plannedShotCount(9.9), 1)
  assert.equal(plannedShotCount(10), 1)
  assert.equal(plannedShotCount(10.001), 2)
  assert.equal(plannedShotCount(90), 9)
  const prompt = buildVideoPrompt({ mode: '完整反推', duration: 23.4, detectDialogue: false, generateCharacterPrompts: false })
  assert.match(prompt, /原视频总时长：23\.400 秒/)
  assert.match(prompt, /目标镜头数：恰好 3 个/)
  assert.match(prompt, /只识别画面/)
  assert.match(prompt, /不得使用 \[\[CHAR_XX\]\]/)
  assert.match(prompt, /---SHOT_PROMPTS---/)
})

test('对白与角色开关会进入剧本、角色和成片提示词约束', async (t) => {
  const { buildVideoPrompt } = await loadVideoPrompt(t)
  const prompt = buildVideoPrompt({ mode: '分镜优先', duration: 61, detectDialogue: true, generateCharacterPrompts: true })
  assert.match(prompt, /目标镜头数：恰好 7 个/)
  assert.match(prompt, /真正可辨认的角色对白/)
  assert.match(prompt, /\[\[CHAR_01\]\]/)
  assert.match(prompt, /完整三联棚拍角色生图提示词/)
  assert.match(prompt, /附加该时间段逐字对白/)
})
