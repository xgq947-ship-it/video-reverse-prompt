import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VIDEO_PROMPT_SKILLS = [
  'lira-image-prompts',
  'acting-ai-video',
  'cinedance-higgsfield',
] as const

async function readFirst(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      const content = await readFile(path, 'utf8')
      if (content.trim()) return content
    } catch {
      // Optional skill location; keep checking candidates.
    }
  }
  return null
}

function candidates(name: string): string[] {
  const configured = String(process.env.VIDEO_REVERSE_PROMPT_SKILL_ROOT || '').trim()
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../skills')
  return [
    ...(configured ? [join(configured, name, 'SKILL.md')] : []),
    resolve(process.cwd(), 'skills', name, 'SKILL.md'),
    join(bundled, name, 'SKILL.md'),
    join(homedir(), '.agents', 'skills', name, 'SKILL.md'),
    join(homedir(), '.codex', 'skills', name, 'SKILL.md'),
  ]
}

export interface VerbatimSkill {
  name: typeof VIDEO_PROMPT_SKILLS[number]
  content: string
  sha256: string
}

export async function loadVerbatimSkills(): Promise<Record<typeof VIDEO_PROMPT_SKILLS[number], VerbatimSkill>> {
  const contents = await Promise.all(VIDEO_PROMPT_SKILLS.map((name) => readFirst(candidates(name))))
  const missing = VIDEO_PROMPT_SKILLS.filter((_, index) => !contents[index])
  if (missing.length) {
    throw new Error(`找不到内置完整 Skill 原文：${missing.join('、')}。项目拒绝使用摘要版规则。`)
  }

  return Object.fromEntries(VIDEO_PROMPT_SKILLS.map((name, index) => {
    const content = contents[index]!
    return [name, {
      name,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    }]
  })) as Record<typeof VIDEO_PROMPT_SKILLS[number], VerbatimSkill>
}
