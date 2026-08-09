import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export type GenerationProviderName = 'deepseek' | 'codex_cli'

export interface GeneratorConfig {
  provider: GenerationProviderName
  deepseekApiKey?: string
}

export interface GenerationResponse {
  content: string
  provider: GenerationProviderName
  model: string
  raw?: unknown
}

export interface GenerationProvider {
  readonly name: GenerationProviderName
  readonly model: string
  generateText(systemPrompt: string, userPrompt: string): Promise<GenerationResponse>
  generateJson(systemPrompt: string, userPrompt: string): Promise<GenerationResponse>
}

export const DEEPSEEK_MODEL = 'deepseek-v4-flash'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 65_536
export const DEEPSEEK_TIMEOUT_MS = 240_000
export const CODEX_TIMEOUT_MS = 480_000

type FetchLike = typeof fetch

class RetriableGenerationError extends Error {}

export class DeepSeekProvider implements GenerationProvider {
  readonly name = 'deepseek' as const
  readonly model = DEEPSEEK_MODEL
  private readonly apiKey: string

  constructor(config: GeneratorConfig, private readonly fetchImpl: FetchLike = fetch) {
    this.apiKey = (config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()
  }

  private async request(systemPrompt: string, userPrompt: string, jsonMode: boolean): Promise<GenerationResponse> {
    if (!this.apiKey) throw new Error('请先在设置中填写 DeepSeek API Key。')
    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    }
    if (jsonMode) payload.response_format = { type: 'json_object' }

    let lastError: unknown
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS)
      try {
        const response = await this.fetchImpl(`${DEEPSEEK_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if (response.status === 429 || response.status >= 500) {
          throw new RetriableGenerationError(`DeepSeek temporary HTTP ${response.status}`)
        }
        if (!response.ok) {
          const detail = (await response.text()).slice(-1200)
          throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）：${detail}`)
        }
        const data = await response.json() as {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>
        }
        const choice = data.choices?.[0]
        const content = choice?.message?.content
        if (!content?.trim()) {
          throw new RetriableGenerationError(
            `DeepSeek 返回空内容（finish_reason=${choice?.finish_reason ?? 'unknown'}, reasoning_chars=${choice?.message?.reasoning_content?.length ?? 0}）`,
          )
        }
        return { content: content.trim(), provider: this.name, model: this.model, raw: data }
      } catch (error) {
        lastError = error
        const retriable = error instanceof RetriableGenerationError || (error instanceof Error && error.name === 'AbortError')
        if (!retriable || attempt >= 1) throw error
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  generateText(systemPrompt: string, userPrompt: string): Promise<GenerationResponse> {
    return this.request(systemPrompt, userPrompt, false)
  }

  generateJson(systemPrompt: string, userPrompt: string): Promise<GenerationResponse> {
    return this.request(systemPrompt, userPrompt, true)
  }
}

async function executable(path: string): Promise<boolean> {
  if (!path) return false
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function pathCandidates(): string[] {
  const home = homedir()
  const candidates = [
    process.env.CODEX_CLI_PATH || '',
    ...String(process.env.PATH || '').split(delimiter).filter(Boolean).map((entry) => join(entry, process.platform === 'win32' ? 'codex.exe' : 'codex')),
    join(home, '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    join(home, '.npm-global', 'bin', process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  ]
  if (process.platform === 'win32') {
    candidates.push(
      join(process.env.LOCALAPPDATA || '', 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
      join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
    )
  }
  return [...new Set(candidates.filter(Boolean))]
}

export async function resolveCodexBin(): Promise<string> {
  for (const candidate of pathCandidates()) {
    if (await executable(candidate)) return candidate
  }
  return ''
}

export function buildCodexExecArgs(outputPath: string, projectRoot: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    projectRoot,
    '--output-last-message',
    outputPath,
    '-',
  ]
}

async function runProcess(binary: string, args: string[], input: string, timeoutMs: number): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Codex CLI 生成超时'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-20_000) })
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
    child.stdin.end(input, 'utf8')
  })
}

export class CodexCliProvider implements GenerationProvider {
  readonly name = 'codex_cli' as const
  readonly model = 'codex-default'

  private async run(systemPrompt: string, userPrompt: string, jsonMode: boolean): Promise<GenerationResponse> {
    const binary = await resolveCodexBin()
    if (!binary) throw new Error('找不到 Codex CLI；请先安装并登录 Codex CLI。')
    const suffix = jsonMode
      ? '\n\n输出必须是合法 JSON 对象；不要运行命令，不要修改文件，不要输出代码围栏。'
      : '\n\n只完成文本生成任务；不要运行命令，不要修改文件。'
    const prompt = `${systemPrompt}\n\n${userPrompt}${suffix}`
    const temporary = await mkdtemp(join(tmpdir(), 'video-reverse-prompt-codex-'))
    const outputPath = join(temporary, 'last-message.txt')
    const projectRoot = process.env.VIDEO_REVERSE_PROMPT_PROJECT_ROOT || process.cwd()
    try {
      const processResult = await runProcess(
        binary,
        buildCodexExecArgs(outputPath, projectRoot),
        prompt,
        CODEX_TIMEOUT_MS,
      )
      if (processResult.code !== 0) {
        throw new Error(`Codex CLI 失败（${processResult.code}）：${processResult.stderr.slice(-2000)}`)
      }
      const content = (await readFile(outputPath, 'utf8').catch(() => '')).trim()
      if (!content) throw new Error('Codex CLI 未返回最终内容')
      return {
        content,
        provider: this.name,
        model: this.model,
        raw: { returncode: processResult.code, stdout_tail: processResult.stdout.slice(-2000) },
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  generateText(systemPrompt: string, userPrompt: string): Promise<GenerationResponse> {
    return this.run(systemPrompt, userPrompt, false)
  }

  generateJson(systemPrompt: string, userPrompt: string): Promise<GenerationResponse> {
    return this.run(systemPrompt, userPrompt, true)
  }
}

export function createGenerationProvider(config: GeneratorConfig): GenerationProvider {
  return config.provider === 'codex_cli' ? new CodexCliProvider() : new DeepSeekProvider(config)
}

export async function generatorStatus(config: GeneratorConfig): Promise<Record<string, string | boolean>> {
  if (config.provider === 'deepseek') {
    return {
      available: Boolean((config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()),
      provider: 'DeepSeek',
      model: DEEPSEEK_MODEL,
      mode: 'V4 Flash MAX',
    }
  }
  const binary = await resolveCodexBin()
  if (!binary) return { available: false, provider: 'Codex CLI', path: '', version: '' }
  const [versionResult, loginResult] = await Promise.all([
    runProcess(binary, ['--version'], '', 10_000),
    runProcess(binary, ['login', 'status'], '', 10_000),
  ])
  const loginStatus = `${loginResult.stdout}\n${loginResult.stderr}`.trim().slice(0, 300)
  const loggedIn = loginResult.code === 0 && /logged in|已登录/i.test(loginStatus)
  return {
    available: versionResult.code === 0 && loggedIn,
    provider: 'Codex CLI',
    path: binary,
    version: versionResult.stdout.trim().slice(0, 200),
    loggedIn,
    loginStatus,
  }
}
