import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
  return [
    ...(configured ? [join(configured, name, 'SKILL.md')] : []),
    resolve(process.cwd(), 'skills', name, 'SKILL.md'),
    join(homedir(), '.agents', 'skills', name, 'SKILL.md'),
    join(homedir(), '.codex', 'skills', name, 'SKILL.md'),
  ]
}

export async function augmentPromptWithVerbatimSkills(prompt: string): Promise<{
  prompt: string
  source: 'builtin' | 'verbatim'
}> {
  const contents = await Promise.all(VIDEO_PROMPT_SKILLS.map((name) => readFirst(candidates(name))))
  if (contents.some((content) => !content)) return { prompt, source: 'builtin' }

  const appendix = VIDEO_PROMPT_SKILLS.map((name, index) => `
<SKILL name="${name}" source="verbatim">
${contents[index]}
</SKILL>`).join('\n')
  return {
    source: 'verbatim',
    prompt: `${prompt}\n\n<VERBATIM_SKILLS>\n以下三份 SKILL.md 已从本机逐字加载。完整执行原文，不得总结、缩写或截断；如与项目内置同名职责冲突，原文优先，但仍须遵守前文的证据边界、用户开关和六分区输出契约。${appendix}\n</VERBATIM_SKILLS>`,
  }
}
