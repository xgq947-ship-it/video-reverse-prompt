import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { AutomationError } from '../errors.js'

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
const DEEPSEEK_STATUS_TIMEOUT_MS = 15_000

type FetchLike = typeof fetch

class RetriableGenerationError extends Error {
  constructor(readonly finalError: AutomationError) {
    super(finalError.message)
    this.name = 'RetriableGenerationError'
  }
}

export function deepSeekApiKeyValidationMessage(value: string | undefined): string | null {
  const apiKey = String(value || '').trim()
  if (!apiKey) return '请填写 DeepSeek API Key。'
  if (/[^\x21-\x7e]/.test(apiKey)) return 'DeepSeek API Key 包含中文、空格或其他不支持的字符，请重新复制完整 Key。'
  if (!apiKey.startsWith('sk-') || apiKey.length < 12) return 'DeepSeek API Key 格式不正确，应以 sk- 开头。'
  return null
}

function safeServiceDetail(value: unknown): string {
  const detail = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return detail.length > 300 ? `${detail.slice(0, 297)}…` : detail
}

async function deepSeekResponseDetail(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 2_000)
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | unknown; message?: unknown }
    if (parsed.error && typeof parsed.error === 'object' && 'message' in parsed.error) {
      return safeServiceDetail(parsed.error.message)
    }
    return safeServiceDetail(parsed.message || text)
  } catch {
    return safeServiceDetail(text)
  }
}

function deepSeekHttpError(status: number, detail = ''): AutomationError {
  if (status === 400) {
    return new AutomationError('DEEPSEEK_INVALID_REQUEST', `DeepSeek 拒绝了生成参数${detail ? `：${detail}` : '。'}`)
  }
  if (status === 401) return new AutomationError('DEEPSEEK_INVALID_KEY', 'DeepSeek API Key 无效或已失效，请在设置中重新填写并确认。')
  if (status === 402) return new AutomationError('DEEPSEEK_INSUFFICIENT_BALANCE', 'DeepSeek 账户余额不足，请充值后重试。')
  if (status === 403) return new AutomationError('DEEPSEEK_FORBIDDEN', '当前 DeepSeek API Key 没有调用此模型的权限。')
  if (status === 404) return new AutomationError('DEEPSEEK_MODEL_UNAVAILABLE', `DeepSeek 模型 ${DEEPSEEK_MODEL} 当前不可用。`)
  if (status === 429) return new AutomationError('DEEPSEEK_RATE_LIMITED', 'DeepSeek 请求过于频繁，请稍后重试。')
  if (status >= 500) return new AutomationError('DEEPSEEK_UNAVAILABLE', `DeepSeek 服务暂时不可用（HTTP ${status}），请稍后重试。`)
  return new AutomationError('DEEPSEEK_REQUEST_FAILED', `DeepSeek 请求失败（HTTP ${status}）${detail ? `：${detail}` : ''}`)
}

export class DeepSeekProvider implements GenerationProvider {
  readonly name = 'deepseek' as const
  readonly model = DEEPSEEK_MODEL
  private readonly apiKey: string

  constructor(config: GeneratorConfig, private readonly fetchImpl: FetchLike = fetch) {
    this.apiKey = (config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()
  }

  private async request(systemPrompt: string, userPrompt: string, jsonMode: boolean): Promise<GenerationResponse> {
    const configurationError = deepSeekApiKeyValidationMessage(this.apiKey)
    if (configurationError) throw new AutomationError('DEEPSEEK_INVALID_KEY_FORMAT', configurationError)
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
          throw new RetriableGenerationError(deepSeekHttpError(response.status))
        }
        if (!response.ok) {
          throw deepSeekHttpError(response.status, await deepSeekResponseDetail(response))
        }
        let data: {
          choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>
        }
        try {
          data = await response.json() as typeof data
        } catch (error) {
          throw new AutomationError('DEEPSEEK_INVALID_RESPONSE', 'DeepSeek 返回了无法识别的数据，请稍后重试。', error instanceof Error ? error.message : String(error))
        }
        const choice = data.choices?.[0]
        const content = choice?.message?.content
        if (!content?.trim()) {
          throw new RetriableGenerationError(new AutomationError(
            'DEEPSEEK_EMPTY_RESPONSE',
            'DeepSeek 没有返回最终内容，已自动重试仍未成功。',
            `finish_reason=${choice?.finish_reason ?? 'unknown'}, reasoning_chars=${choice?.message?.reasoning_content?.length ?? 0}`,
          ))
        }
        return { content: content.trim(), provider: this.name, model: this.model, raw: data }
      } catch (error) {
        lastError = error
        const retriable = error instanceof RetriableGenerationError || (error instanceof Error && error.name === 'AbortError')
        if (retriable && attempt < 1) {
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000))
          continue
        }
        if (error instanceof RetriableGenerationError) throw error.finalError
        if (error instanceof AutomationError) throw error
        if (error instanceof Error && error.name === 'AbortError') {
          throw new AutomationError('DEEPSEEK_TIMEOUT', 'DeepSeek 生成超时，已自动重试仍未完成。')
        }
        throw new AutomationError(
          'DEEPSEEK_UNAVAILABLE',
          `无法连接 DeepSeek：${error instanceof Error ? safeServiceDetail(error.message) : '网络请求失败'}`,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        )
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
    if (!binary) throw new AutomationError('CODEX_CLI_NOT_FOUND', '找不到 Codex CLI，请先安装并登录后在设置中重新检测。')
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
        const detail = safeServiceDetail(processResult.stderr.slice(-2_000))
        const loginRequired = /not logged in|login required|unauthorized|authentication/i.test(detail)
        throw new AutomationError(
          loginRequired ? 'CODEX_CLI_LOGIN_REQUIRED' : 'CODEX_CLI_FAILED',
          loginRequired ? 'Codex CLI 尚未登录，请先完成登录后重试。' : `Codex CLI 生成失败（退出码 ${processResult.code}）${detail ? `：${detail}` : ''}`,
        )
      }
      const content = (await readFile(outputPath, 'utf8').catch(() => '')).trim()
      if (!content) throw new AutomationError('CODEX_CLI_EMPTY_RESPONSE', 'Codex CLI 没有返回最终内容，请重试。')
      return {
        content,
        provider: this.name,
        model: this.model,
        raw: { returncode: processResult.code, stdout_tail: processResult.stdout.slice(-2000) },
      }
    } catch (error) {
      if (error instanceof AutomationError) throw error
      throw new AutomationError(
        'CODEX_CLI_FAILED',
        `Codex CLI 调用失败：${error instanceof Error ? safeServiceDetail(error.message) : String(error)}`,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )
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

export async function generatorStatus(config: GeneratorConfig, fetchImpl: FetchLike = fetch): Promise<Record<string, string | boolean>> {
  if (config.provider === 'deepseek') {
    const apiKey = (config.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '').trim()
    const configurationError = deepSeekApiKeyValidationMessage(apiKey)
    if (configurationError) {
      return { available: false, provider: 'DeepSeek', model: DEEPSEEK_MODEL, mode: 'V4 Flash MAX', message: configurationError }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEEPSEEK_STATUS_TIMEOUT_MS)
    try {
      const response = await fetchImpl(`${DEEPSEEK_BASE_URL}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = deepSeekHttpError(response.status, await deepSeekResponseDetail(response))
        return { available: false, provider: 'DeepSeek', model: DEEPSEEK_MODEL, mode: 'V4 Flash MAX', message: error.message }
      }
      const payload = await response.json() as { data?: Array<{ id?: string }> }
      const models = Array.isArray(payload.data) ? payload.data.map((item) => item.id).filter(Boolean) : []
      const available = models.includes(DEEPSEEK_MODEL)
      return {
        available,
        provider: 'DeepSeek',
        model: DEEPSEEK_MODEL,
        mode: 'V4 Flash MAX',
        message: available ? 'API Key 已验证，DeepSeek V4 Flash MAX 可用。' : `当前账号暂时无法使用 ${DEEPSEEK_MODEL}。`,
      }
    } catch (error) {
      return {
        available: false,
        provider: 'DeepSeek',
        model: DEEPSEEK_MODEL,
        mode: 'V4 Flash MAX',
        message: error instanceof Error && error.name === 'AbortError'
          ? '连接 DeepSeek 超时，请检查网络后重试。'
          : `无法连接 DeepSeek：${error instanceof Error ? safeServiceDetail(error.message) : '网络请求失败'}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }
  const binary = await resolveCodexBin()
  if (!binary) {
    return {
      available: false,
      provider: 'Codex CLI',
      path: '',
      version: '',
      loggedIn: false,
      message: '未找到 Codex CLI，请先安装或打开包含 Codex 的 ChatGPT App。',
    }
  }
  try {
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
      message: loggedIn ? 'Codex CLI 已登录，可以使用。' : 'Codex CLI 尚未登录，请先在终端运行 codex login。',
    }
  } catch (error) {
    return {
      available: false,
      provider: 'Codex CLI',
      path: binary,
      version: '',
      loggedIn: false,
      message: `Codex CLI 检测失败：${error instanceof Error ? safeServiceDetail(error.message) : String(error)}`,
    }
  }
}
