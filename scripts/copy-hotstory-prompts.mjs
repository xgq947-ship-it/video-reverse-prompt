import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceRoot = join(projectRoot, 'automation', 'playwright-service', 'src', 'prompts', 'hotstory')
const outputRoot = join(projectRoot, 'automation', 'playwright-service', 'dist', 'prompts', 'hotstory')

await mkdir(outputRoot, { recursive: true })
for (const name of ['character_assets.md', 'cinematic_shots.md', 'script_writer.md', 'shot_plan.md']) {
  await cp(join(sourceRoot, name), join(outputRoot, name))
}
