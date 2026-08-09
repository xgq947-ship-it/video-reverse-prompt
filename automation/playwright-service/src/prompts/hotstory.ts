import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HotStoryPromptName = 'character_assets' | 'cinematic_shots' | 'script_writer' | 'shot_plan'

const promptRoot = join(dirname(fileURLToPath(import.meta.url)), 'hotstory')
const cache = new Map<HotStoryPromptName, string>()

export async function loadHotStoryPrompt(name: HotStoryPromptName): Promise<string> {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  const content = await readFile(join(promptRoot, `${name}.md`), 'utf8')
  cache.set(name, content)
  return content
}

export async function renderHotStoryPrompt(
  name: HotStoryPromptName,
  values: Record<string, unknown>,
): Promise<string> {
  let content = await loadHotStoryPrompt(name)
  for (const [key, value] of Object.entries(values)) {
    content = content.replaceAll(`{{${key}}}`, String(value))
  }
  return content
}
