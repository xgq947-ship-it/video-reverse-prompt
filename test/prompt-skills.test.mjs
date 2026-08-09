import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { augmentPromptWithVerbatimSkills, VIDEO_PROMPT_SKILLS } from '../automation/playwright-service/dist/prompts/skills.js'

test('三份 SKILL.md 齐全时逐字附加，缺失时安全使用内置工作流', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'video-reverse-prompt-skills-'))
  const previous = process.env.VIDEO_REVERSE_PROMPT_SKILL_ROOT
  process.env.VIDEO_REVERSE_PROMPT_SKILL_ROOT = root
  t.after(async () => {
    if (previous === undefined) delete process.env.VIDEO_REVERSE_PROMPT_SKILL_ROOT
    else process.env.VIDEO_REVERSE_PROMPT_SKILL_ROOT = previous
    await rm(root, { recursive: true, force: true })
  })

  const fallback = await augmentPromptWithVerbatimSkills('BASE')
  assert.equal(fallback.source, 'builtin')
  assert.equal(fallback.prompt, 'BASE')

  for (const name of VIDEO_PROMPT_SKILLS) {
    const directory = path.join(root, name)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'SKILL.md'), `${name} 完整原文`)
  }
  const verbatim = await augmentPromptWithVerbatimSkills('BASE')
  assert.equal(verbatim.source, 'verbatim')
  for (const name of VIDEO_PROMPT_SKILLS) {
    assert.match(verbatim.prompt, new RegExp(`${name} 完整原文`))
  }
  assert.match(verbatim.prompt, /不得总结、缩写或截断/)
})
