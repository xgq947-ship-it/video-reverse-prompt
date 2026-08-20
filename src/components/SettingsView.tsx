import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  Heart,
  Info,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import appIcon from '../../src-tauri/icons/128x128.png'
import type { Settings } from '../types'

const REPOSITORY_URL = 'https://github.com/xgq947-ship-it/video-reverse-prompt'
const RELEASES_API = 'https://api.github.com/repos/xgq947-ship-it/video-reverse-prompt/releases'
const WECHAT_ID = 'Moment_oo7'
const FALLBACK_VERSION = '0.2.0'
const isTauri = '__TAURI_INTERNALS__' in window

type SettingsPage = 'generator' | 'advanced' | 'about' | 'updates' | 'support'
type UpdateState = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'

interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  digest: string | null
}

interface ReleaseInfo {
  tag_name: string
  name: string
  html_url: string
  body: string | null
  published_at: string
  draft: boolean
  prerelease: boolean
  assets: ReleaseAsset[]
}

interface UpdateDownloadProgress {
  downloadedBytes: number
  totalBytes: number
  percent: number
}

interface UpdateDownloadResult {
  version: string
  size: number
}

interface Props {
  settings: Settings
  onChange: (settings: Settings) => void | Promise<void>
  connection: 'unknown' | 'connected' | 'disconnected' | 'checking'
  onOpenGemini: () => void
  onCheck: () => void
  onCompatibility: () => void
  checks: Record<string, boolean> | null
  onClearHistory: () => void
  initialPage?: 'generator' | 'about'
}

const LOCAL_RELEASES: ReleaseInfo[] = [
  {
    tag_name: 'v0.2.0',
    name: 'Video Reverse Prompt v0.2.0',
    html_url: `${REPOSITORY_URL}/releases/tag/v0.2.0`,
    published_at: '2026-08-09T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: [],
    body: '从 Reverse Prompt 独立拆分为纯视频项目\n第一步恢复 Reverse Prompt 原版 Gemini 九分区视频反推\n反推完成后新增“生成短视频剧本”第二步\n第二步支持 DeepSeek V4 Flash MAX 与本机 Codex CLI\n逐字内置 HotStory 四份提示词模板\n完整内置 lira-image-prompts、acting-ai-video、cinedance-higgsfield 三份 SKILL.md\n自动生成角色参考图、表演主档案与多分镜成片提示词',
  },
]

const NAV_ITEMS: { id: SettingsPage; label: string; icon: typeof Wrench }[] = [
  { id: 'generator', label: '生成模型', icon: Sparkles },
  { id: 'advanced', label: '高级', icon: Wrench },
  { id: 'about', label: '关于', icon: Info },
  { id: 'updates', label: '新功能', icon: Sparkles },
  { id: 'support', label: '支持', icon: Heart },
]

function deepSeekKeyFormatMessage(value: string): string | null {
  const apiKey = value.trim()
  if (!apiKey) return '请填写 DeepSeek API Key。'
  if (/[^\x21-\x7e]/.test(apiKey)) return 'Key 中包含中文、空格或其他不支持的字符，请重新复制完整 Key。'
  if (!apiKey.startsWith('sk-') || apiKey.length < 12) return 'Key 格式不正确，应以 sk- 开头。'
  return null
}

function versionParts(version: string): number[] {
  return version.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function isNewerVersion(candidate: string, current: string): boolean {
  const left = versionParts(candidate)
  const right = versionParts(current)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

function releaseLines(body: string | null): string[] {
  if (!body) return ['本次更新未提供详细说明。']
  return body
    .split('\n')
    .map((line) => line.replace(/^\s*[-*#]+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12)
}

export function SettingsView({ settings, onChange, connection, onOpenGemini, onCheck, onCompatibility, checks, onClearHistory, initialPage = 'about' }: Props) {
  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [search, setSearch] = useState('')
  const [currentVersion, setCurrentVersion] = useState(FALLBACK_VERSION)
  const [releases, setReleases] = useState<ReleaseInfo[]>(LOCAL_RELEASES)
  const [updateState, setUpdateState] = useState<UpdateState>('idle')
  const [latestRelease, setLatestRelease] = useState<ReleaseInfo | null>(null)
  const [updateMessage, setUpdateMessage] = useState('尚未检查更新。')
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [copied, setCopied] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [uninstallError, setUninstallError] = useState('')
  const [generatorChecking, setGeneratorChecking] = useState(false)
  const [generatorStatus, setGeneratorStatus] = useState<Record<string, string | boolean> | null>(null)
  const [generatorDraft, setGeneratorDraft] = useState(() => ({
    provider: settings.generationProvider,
    deepseekApiKey: settings.deepseekApiKey,
  }))
  const [generatorSaving, setGeneratorSaving] = useState(false)
  const [generatorSaveState, setGeneratorSaveState] = useState<'idle' | 'success' | 'error'>('idle')
  const [generatorSaveMessage, setGeneratorSaveMessage] = useState('')
  const autoChecked = useRef(false)
  const updateDownloadActive = useRef(false)

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => { void onChange({ ...settings, [key]: value }) }

  const changeGeneratorDraft = (next: Partial<typeof generatorDraft>) => {
    setGeneratorDraft((current) => ({ ...current, ...next }))
    setGeneratorStatus(null)
    setGeneratorSaveState('idle')
    setGeneratorSaveMessage('')
  }

  const openExternal = useCallback(async (url: string) => {
    if (isTauri) await invoke('open_external', { url })
    else window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  const checkForUpdates = useCallback(async () => {
    setUpdateState('checking')
    setUpdateMessage('正在连接 GitHub 检查最新版本…')
    try {
      const response = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
      if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
      const remote = (await response.json() as ReleaseInfo[]).filter((item) => !item.draft && !item.prerelease)
      if (!remote.length) throw new Error('没有找到可用版本')
      setReleases(remote)
      const latest = remote[0]
      setLatestRelease(latest)
      if (isNewerVersion(latest.tag_name, currentVersion)) {
        setUpdateState('available')
        setUpdateMessage(`发现新版本 ${latest.tag_name.replace(/^v/, '')}`)
      } else {
        setUpdateState('current')
        setUpdateMessage('你已是最新版本。')
      }
      update('lastUpdateCheck', new Date().toISOString())
    } catch (error) {
      setUpdateState('error')
      setUpdateMessage(`检查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVersion])

  useEffect(() => {
    if (!isTauri) return
    void getVersion().then(setCurrentVersion).catch(() => setCurrentVersion(FALLBACK_VERSION))
  }, [])

  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    const registration = listen<UpdateDownloadProgress>('update-download-progress', ({ payload }) => {
      if (disposed || !updateDownloadActive.current) return
      setDownloadProgress(payload.percent)
      setUpdateState('downloading')
      setUpdateMessage(`正在下载更新… ${payload.percent}%`)
    })
    return () => {
      disposed = true
      void registration.then((unlisten) => unlisten())
    }
  }, [])

  useEffect(() => {
    if (!settings.autoCheckUpdates || autoChecked.current) return
    autoChecked.current = true
    void checkForUpdates()
  }, [checkForUpdates, settings.autoCheckUpdates])

  const visibleNav = useMemo(() => {
    const query = search.trim().toLowerCase()
    return query ? NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(query)) : NAV_ITEMS
  }, [search])

  const downloadUpdate = async () => {
    if (!latestRelease) return
    const isWindows = /Windows/i.test(navigator.userAgent)
    const asset = latestRelease.assets.find((item) => (
      isWindows
        ? /\.(exe|msi)$/i.test(item.name)
        : /\.dmg$/i.test(item.name) || /macos.*arm64|arm64.*macos/i.test(item.name)
    ))
    if (!isWindows || !isTauri) {
      await openExternal(asset?.browser_download_url ?? latestRelease.html_url)
      return
    }
    if (!asset) {
      setUpdateState('error')
      setUpdateMessage('当前版本没有 Windows x64 安装包。')
      return
    }
    if (!asset.digest?.startsWith('sha256:') || !asset.size) {
      setUpdateState('error')
      setUpdateMessage('GitHub 未提供安装包完整性校验值，已拒绝自动安装。')
      return
    }
    setDownloadProgress(0)
    updateDownloadActive.current = true
    setUpdateState('downloading')
    setUpdateMessage('正在安全下载更新… 0%')
    try {
      const result = await invoke<UpdateDownloadResult>('download_update', {
        request: {
          url: asset.browser_download_url,
          version: latestRelease.tag_name,
          expectedSize: asset.size,
          digest: asset.digest,
        },
      })
      updateDownloadActive.current = false
      setDownloadProgress(100)
      setUpdateState('ready')
      setUpdateMessage(`${result.version.replace(/^v/, '')} 已下载并校验，可以重启安装。`)
    } catch (error) {
      updateDownloadActive.current = false
      setUpdateState('error')
      setUpdateMessage(`下载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const installUpdate = async () => {
    if (!isTauri) return
    setUpdateState('installing')
    setUpdateMessage('正在启动更新安装器，应用即将重启…')
    try {
      await invoke('install_downloaded_update')
    } catch (error) {
      setUpdateState('error')
      setUpdateMessage(`安装失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const copyWechat = async () => {
    await navigator.clipboard.writeText(WECHAT_ID)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const uninstall = async () => {
    const confirmed = window.confirm('完整卸载会清除 Video Reverse Prompt 的本地设置、历史和缓存，并将 App 移到废纸篓。是否继续？')
    if (!confirmed || !window.confirm('最后确认：卸载完成后应用会立即退出。')) return
    setUninstalling(true)
    setUninstallError('')
    try {
      await invoke('uninstall_app')
    } catch (error) {
      setUninstalling(false)
      setUninstallError(error instanceof Error ? error.message : String(error))
    }
  }

  const checkGenerator = useCallback(async (): Promise<Record<string, string | boolean>> => {
    if (!isTauri) {
      const status = { available: false, message: '请通过 Video Reverse Prompt 桌面应用验证生成模型。' }
      setGeneratorStatus(status)
      return status
    }
    setGeneratorChecking(true)
    try {
      const payload = await invoke<{ ok: boolean; generatorStatus?: Record<string, string | boolean>; error?: { message?: string } }>('run_automation', {
        request: {
          command: 'generator-status',
          generator: {
            provider: generatorDraft.provider,
            deepseekApiKey: generatorDraft.provider === 'deepseek' ? generatorDraft.deepseekApiKey.trim() : undefined,
          },
        },
      })
      if (!payload.ok) throw new Error(payload.error?.message || '检测失败')
      const status = payload.generatorStatus ?? { available: false, message: '生成模型没有返回检测结果。' }
      setGeneratorStatus(status)
      return status
    } catch (error) {
      const status = { available: false, message: error instanceof Error ? error.message : String(error) }
      setGeneratorStatus(status)
      return status
    } finally {
      setGeneratorChecking(false)
    }
  }, [generatorDraft.deepseekApiKey, generatorDraft.provider])

  useEffect(() => {
    setGeneratorStatus(null)
    if (page === 'generator' && generatorDraft.provider === 'codex_cli') void checkGenerator()
  }, [checkGenerator, generatorDraft.provider, page])

  const confirmGenerator = async () => {
    setGeneratorSaving(true)
    setGeneratorSaveState('idle')
    setGeneratorSaveMessage('')
    const status = await checkGenerator()
    if (!status.available) {
      setGeneratorSaving(false)
      setGeneratorSaveState('error')
      setGeneratorSaveMessage(String(status.message || '所选生成模型当前不可用，请检查配置。'))
      return
    }
    try {
      await onChange({
        ...settings,
        generationProvider: generatorDraft.provider,
        deepseekApiKey: generatorDraft.deepseekApiKey.trim(),
      })
      setGeneratorSaveState('success')
      setGeneratorSaveMessage(`已保存并启用${generatorDraft.provider === 'deepseek' ? ' DeepSeek V4 Flash MAX' : ' Codex CLI'}。`)
    } catch (error) {
      setGeneratorSaveState('error')
      setGeneratorSaveMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setGeneratorSaving(false)
    }
  }

  const generatorDirty = generatorDraft.provider !== settings.generationProvider
    || generatorDraft.deepseekApiKey.trim() !== settings.deepseekApiKey.trim()
  const deepSeekKeyError = generatorDraft.provider === 'deepseek'
    ? deepSeekKeyFormatMessage(generatorDraft.deepseekApiKey)
    : null

  const renderGenerator = () => (
    <div className="settings-page generator-page">
      <div className="settings-page-title"><span>PRODUCTION MODEL</span><h2>生成模型</h2><p>Gemini 只负责第一步视频反推；这里的模型负责剧本、角色和多分镜提示词。</p></div>
      <section className="settings-section generator-card">
        <div className="generator-section-heading"><h3>模型来源</h3><span>当前已启用：{settings.generationProvider === 'deepseek' ? 'DeepSeek V4 Flash MAX' : 'Codex CLI'}</span></div>
        <div className="provider-choice">
          <button className={generatorDraft.provider === 'deepseek' ? 'active' : ''} onClick={() => changeGeneratorDraft({ provider: 'deepseek' })}><KeyRound size={18} /><span><strong>DeepSeek</strong><small>默认 · V4 Flash MAX</small></span></button>
          <button className={generatorDraft.provider === 'codex_cli' ? 'active' : ''} onClick={() => changeGeneratorDraft({ provider: 'codex_cli' })}><Terminal size={18} /><span><strong>Codex CLI</strong><small>自动检测本机登录</small></span></button>
        </div>
      </section>

      {generatorDraft.provider === 'deepseek' ? <section className="settings-section generator-card">
        <h3>DeepSeek V4 Flash MAX</h3>
        <label className="api-key-field"><span>API Key</span><input type="password" value={generatorDraft.deepseekApiKey} onChange={(event) => changeGeneratorDraft({ deepseekApiKey: event.target.value })} placeholder="sk-…" autoComplete="off" spellCheck={false} aria-invalid={Boolean(deepSeekKeyError)} /></label>
        {deepSeekKeyError && <div className="generator-validation-error"><CircleAlert size={13} />{deepSeekKeyError}</div>}
        <div className="generator-facts"><span>模型固定为 deepseek-v4-flash</span><span>Thinking 已开启</span><span>Reasoning Effort：MAX</span></div>
        <p className="generator-note">点击下方“验证并保存”后才会生效。Key 保存在本机应用设置中，调用生成阶段时通过标准输入传给内置服务，不会出现在进程命令行。</p>
      </section> : <section className="settings-section generator-card">
        <h3>Codex CLI</h3>
        <div className="setting-row"><div><strong>本机 Codex CLI</strong><span>{generatorStatus?.path ? String(generatorStatus.path) : '自动查找系统 PATH 与 ChatGPT App 内置 Codex'}</span></div><div className={`connection ${generatorStatus?.available ? 'connected' : ''}`}>{generatorChecking ? <LoaderCircle className="spin" size={14} /> : generatorStatus?.available ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}{generatorChecking ? '检测中' : generatorStatus?.available ? '可用' : '未检测'}</div></div>
        {(generatorStatus?.version || generatorStatus?.loginStatus) && <div className="generator-facts"><span>{String(generatorStatus.version || '')}</span>{generatorStatus?.loginStatus && <span>{String(generatorStatus.loginStatus)}</span>}</div>}
        {generatorStatus?.message && <div className="inline-generation-error">{String(generatorStatus.message)}</div>}
        <div className="button-row"><button className="quiet-button" onClick={() => void checkGenerator()} disabled={generatorChecking}><RefreshCw size={14} />重新自动检测</button></div>
        <p className="generator-note">无需填写路径、模型或 Key。应用使用本机已登录的 Codex CLI，并以临时会话和只读沙箱执行纯文本生成。</p>
      </section>}

      <section className={`generator-save-card ${generatorSaveState}`}>
        <div className="generator-save-copy">
          {generatorSaveState === 'success' ? <CheckCircle2 size={17} /> : generatorSaveState === 'error' ? <CircleAlert size={17} /> : <Info size={17} />}
          <div><strong>{generatorDirty ? '模型设置尚未确认' : '确认当前模型设置'}</strong><span>{generatorSaveMessage || (generatorDirty ? '点击验证并保存后，所选模型才会用于第二步生成。' : '可重新验证凭证与模型可用性。')}</span></div>
        </div>
        <button className="generator-save-button" onClick={() => void confirmGenerator()} disabled={generatorSaving || generatorChecking || Boolean(deepSeekKeyError)}>
          {generatorSaving || generatorChecking ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
          {generatorSaving || generatorChecking ? '正在验证…' : '验证并保存'}
        </button>
      </section>

      <section className="skill-integrity-card"><ShieldCheck size={19} /><div><strong>HotStory 原始工作流</strong><p>角色、剧本、分镜模板及 Lira、Acting、CINEDANCE 三份完整 Skill 原文均随应用打包；缺失时直接停止，不会降级为摘要。</p></div></section>
    </div>
  )

  const renderAbout = () => (
    <div className="settings-page about-page">
      <section className="about-hero">
        <img src={appIcon} alt="Video Reverse Prompt 图标" />
        <h2>Video Reverse Prompt</h2>
        <p className="app-version">版本 {currentVersion}</p>
        <p className="about-description">你的本地 AI 视频逆向导演工作台。<br />先用 Gemini 反推参考视频，再生成剧本、角色资产和可直接复制的多分镜成片提示词。</p>
        <div className="about-actions">
          <button onClick={() => setPage('updates')}>查看新功能</button>
          <button className="link-button" onClick={() => void openExternal(REPOSITORY_URL)}>在 GitHub 上查看 <ExternalLink size={14} /></button>
        </div>
        <span className="copyright">© 2026 Video Reverse Prompt</span>
      </section>

      <section className="settings-block update-block">
        <h3>更新</h3>
        <div className="mac-list-card">
          <label className="mac-list-row">
            <div><strong>自动检查更新</strong><span>打开设置时从 GitHub Releases 检查</span></div>
            <span className="mac-switch"><input type="checkbox" checked={settings.autoCheckUpdates} onChange={(event) => update('autoCheckUpdates', event.target.checked)} /><i /></span>
          </label>
          <div className={`mac-list-row update-result ${updateState}`}>
            <div className="update-status-icon">{updateState === 'checking' || updateState === 'downloading' || updateState === 'installing' ? <LoaderCircle className="spin" size={16} /> : updateState === 'error' ? <CircleAlert size={16} /> : updateState === 'available' ? <Download size={16} /> : <Check size={16} />}</div>
            <strong>{updateMessage}</strong>
          </div>
          {updateState === 'downloading' && <div className="update-progress"><i style={{ width: `${downloadProgress}%` }} /></div>}
          <div className="mac-list-row update-actions-row">
            {updateState === 'ready' && <button className="accent-action" onClick={() => void installUpdate()}><RefreshCw size={14} />重启并安装</button>}
            {updateState === 'available' && <button className="accent-action" onClick={() => void downloadUpdate()}><Download size={14} />{/Windows/i.test(navigator.userAgent) ? '下载并准备更新' : '下载更新'}</button>}
            <button onClick={() => void checkForUpdates()} disabled={updateState === 'checking' || updateState === 'downloading' || updateState === 'installing'}><RefreshCw size={14} />立即检查</button>
          </div>
          {/Windows/i.test(navigator.userAgent) && <div className="update-note">Windows 下载后会校验 SHA-256，点击“重启并安装”即可自动覆盖更新。</div>}
          <div className="last-check">上次检查：{settings.lastUpdateCheck ? new Date(settings.lastUpdateCheck).toLocaleString('zh-CN') : '从未'}</div>
        </div>
      </section>
    </div>
  )

  const renderUpdates = () => (
    <div className="settings-page updates-page">
      <div className="settings-page-title"><span>RELEASE NOTES</span><h2>新功能</h2><p>Video Reverse Prompt 每个版本的更新内容。</p></div>
      <div className="release-list">
        {releases.map((release, index) => <article className="release-card" key={release.tag_name}>
          <div className="release-heading"><div><strong>{release.name || release.tag_name}</strong><span>{new Date(release.published_at).toLocaleDateString('zh-CN')}</span></div>{index === 0 && <b>最新</b>}</div>
          <ul>{releaseLines(release.body).map((line) => <li key={line}>{line}</li>)}</ul>
          <button className="release-link" onClick={() => void openExternal(release.html_url)}>查看发布页面 <ChevronRight size={14} /></button>
        </article>)}
      </div>
    </div>
  )

  const renderSupport = () => (
    <div className="settings-page support-page">
      <div className="settings-page-title"><span>SUPPORT</span><h2>支持</h2><p>遇到问题或有功能建议，可以通过微信联系。</p></div>
      <section className="support-card">
        <div className="support-icon"><Heart size={28} fill="currentColor" /></div>
        <div><span>微信号</span><strong>{WECHAT_ID}</strong><p>添加时请备注“Video Reverse Prompt”。</p></div>
        <button onClick={() => void copyWechat()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制微信号'}</button>
      </section>
      <section className="privacy-card"><ShieldCheck size={20} /><div><strong>隐私说明</strong><p>本地文件只会在你开始反推后，通过已登录的 Gemini 页面上下文直接上传到 Google。短视频链接会按平台发送给对应平台或公开解析服务，解析后的视频缓存在本机；只有你点击反推时才会上传到 Gemini。解析请求不会携带 Google 密码、Cookie、OAuth Token 或 Authorization Header。</p></div></section>
    </div>
  )

  const renderAdvanced = () => (
    <div className="settings-page advanced-page">
      <div className="settings-page-title"><span>ADVANCED</span><h2>高级</h2><p>Gemini HTTP、本地历史与维护设置。</p></div>
      <section className="settings-section"><h3>Gemini</h3><div className="setting-row"><div><strong>Gemini Web · 系统共享 Chrome</strong><span>{settings.geminiUrl}</span></div><div className={`connection ${connection}`}>{connection === 'connected' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{connection === 'checking' ? '检查中' : connection === 'connected' ? '已登录' : connection === 'disconnected' ? '未登录' : '未检查'}</div></div><div className="button-row"><button className="quiet-button" onClick={onOpenGemini}><ExternalLink size={14} />打开 Gemini</button><button className="quiet-button" onClick={onCheck}><RefreshCw size={14} />重新检查登录</button></div></section>
      <section className="settings-section"><h3>Gemini HTTP</h3><div className="setting-row"><div><strong>HTTP 请求通道</strong><span>上传与反推请求不再点击网页控件</span></div><div className="connection connected"><CheckCircle2 size={14} />已启用</div></div><div className="setting-row"><div><strong>启动登录检查</strong><span>未登录时阻止上传并要求先完成 Gemini 登录</span></div><div className="connection connected"><CheckCircle2 size={14} />已启用</div></div><div className="setting-row"><div><strong>固定专用对话</strong><span>HTTP 会话标识保存在本机，用于连续调整</span></div><div className="connection connected"><CheckCircle2 size={14} />已启用</div></div><div className="setting-row"><div><strong>自动分析浏览器</strong><span>固定后台无头执行；只有手动登录窗口可见</span></div><div className="connection connected"><CheckCircle2 size={14} />后台</div></div></section>
      <section className="settings-section"><h3>History & Debug</h3><label className="setting-row"><div><strong>保存历史</strong><span>仅保存在本机，最多 {settings.maxHistory} 条</span></div><input type="checkbox" checked={settings.saveHistory} onChange={(event) => update('saveHistory', event.target.checked)} /></label><label className="setting-row"><div><strong>Debug Mode</strong><span>记录技术日志，不记录 Cookie、Token 或密码</span></div><input type="checkbox" checked={settings.debug} onChange={(event) => update('debug', event.target.checked)} /></label><div className="button-row"><button className="quiet-button" onClick={onClearHistory}>清空历史</button><button className="quiet-button" onClick={onCompatibility}>检测 Gemini 页面兼容性</button></div>{checks && <div className="checks">{Object.entries(checks).map(([name, ok]) => <div key={name}><span>{name}</span><b className={ok ? 'ok' : 'bad'}>{ok ? '✓' : '×'}</b></div>)}</div>}</section>
      <section className="uninstall-section"><h3>卸载</h3><div className="uninstall-card"><p>移除本地设置、历史和缓存，并将 Video Reverse Prompt 移到废纸篓。系统共享浏览器与登录资料会保留给其他 App。</p><button onClick={() => void uninstall()} disabled={uninstalling}><Trash2 size={16} />{uninstalling ? '正在卸载…' : '完全卸载 Video Reverse Prompt'}</button>{uninstallError && <span className="uninstall-error">{uninstallError}</span>}</div></section>
    </div>
  )

  return <div className="settings-shell">
    <aside className="settings-sidebar">
      <label className="settings-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索设置" /></label>
      <nav>{visibleNav.map((item) => { const Icon = item.icon; return <button key={item.id} className={page === item.id ? 'active' : ''} onClick={() => setPage(item.id)}><Icon size={17} />{item.label}</button> })}</nav>
      {!visibleNav.length && <p className="settings-no-result">没有匹配的设置</p>}
    </aside>
    <div className="settings-content">
      {page === 'about' && renderAbout()}
      {page === 'generator' && renderGenerator()}
      {page === 'updates' && renderUpdates()}
      {page === 'support' && renderSupport()}
      {page === 'advanced' && renderAdvanced()}
    </div>
  </div>
}
