import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { loadVerbatimSkills, VIDEO_PROMPT_SKILLS } from '../automation/playwright-service/dist/prompts/skills.js'

const EXPECTED_SKILL_HASHES = {
  'lira-image-prompts': 'e82e6dc74e27103c77fc169d1c793356bf27663a7151a2444a3d1e642a39a50d',
  'acting-ai-video': 'dd08b2d9d014493519123b4857799b759251797b0c5f0939e03ec46302023e17',
  'cinedance-higgsfield': 'feb82ba06110e54b41723bc4aff341bbf98f2710a7b26b7ee01ab341d20ff5b0',
}

const EXPECTED_HOTSTORY_HASHES = {
  'character_assets.md': '6e40033d4f0961717e7d987362b14f3f067344d17d2706e4b29b9ceab84efb46',
  'cinematic_shots.md': '9393df364c098b7d2923e9c18f4a63f28185e162ac83a8b13644e4eadfe8f097',
  'script_writer.md': '16044cb371b7d74d3537d7e7db40843b690f942bde210f952fcf7ea09821dd7e',
  'shot_plan.md': '6cf5a46ca9be9a8db8ba12f4d5a1968b99f04012e1a2602912fa5d5979b874db',
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex')
}

test('三份 Skill 使用完整原文并锁定原始 SHA-256', async () => {
  const skills = await loadVerbatimSkills()
  assert.deepEqual(Object.keys(skills), [...VIDEO_PROMPT_SKILLS])
  for (const name of VIDEO_PROMPT_SKILLS) {
    assert.equal(skills[name].sha256, EXPECTED_SKILL_HASHES[name])
    assert.equal(hash(skills[name].content), EXPECTED_SKILL_HASHES[name])
    assert.ok(skills[name].content.length > 9_000)
  }
})

test('HotStory 四份提示词模板逐字复制且不使用摘要模板', async () => {
  for (const [filename, expected] of Object.entries(EXPECTED_HOTSTORY_HASHES)) {
    const content = await readFile(new URL(`../automation/playwright-service/src/prompts/hotstory/${filename}`, import.meta.url), 'utf8')
    assert.equal(hash(content), expected)
  }
  const loader = await readFile(new URL('../automation/playwright-service/src/prompts/skills.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(loader, /fallback|摘要版规则\s*=/i)
  assert.match(loader, /项目拒绝使用摘要版规则/)
})
