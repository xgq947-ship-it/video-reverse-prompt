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
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
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
const FALLBACK_VERSION = '0.1.0'
const isTauri = '__TAURI_INTERNALS__' in window

type SettingsPage = 'advanced' | 'about' | 'updates' | 'support'
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
  onChange: (settings: Settings) => void
  connection: 'unknown' | 'connected' | 'disconnected' | 'checking'
  onOpenGemini: () => void
  onCheck: () => void
  onCompatibility: () => void
  checks: Record<string, boolean> | null
  onClearHistory: () => void
}

const LOCAL_RELEASES: ReleaseInfo[] = [
  {
    tag_name: 'v0.1.0',
    name: 'Video Reverse Prompt v0.1.0',
    html_url: `${REPOSITORY_URL}/releases/tag/v0.1.0`,
    published_at: '2026-08-09T00:00:00Z',
    draft: false,
    prerelease: false,
    assets: [],
    body: '从 Reverse Prompt 独立拆分为纯视频项目\n支持对白识别开关：开启生成含逐字台词剧本，关闭生成纯画面剧本\n按原视频时长拆分为单镜头不超过 10 秒的连续成片提示词\n新增可选角色参考图提示词与表演主档案\n接入 HotStory 同源的剧本、角色、表演、分镜与成片工作流\n支持从本机逐字加载 lira-image-prompts、acting-ai-video、cinedance-higgsfield 三份完整 SKILL.md',
  },
]

const NAV_ITEMS: { id: SettingsPage; label: string; icon: typeof Wrench }[] = [
  { id: 'advanced', label: '高级', icon: Wrench },
  { id: 'about', label: '关于', icon: Info },
  { id: 'updates', label: '新功能', icon: Sparkles },
  { id: 'support', label: '支持', icon: Heart },
]

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

export function SettingsView({ settings, onChange, connection, onOpenGemini, onCheck, onCompatibility, checks, onClearHistory }: Props) {
  const [page, setPage] = useState<SettingsPage>('about')
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
  const autoChecked = useRef(false)
  const updateDownloadActive = useRef(false)

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => onChange({ ...settings, [key]: value })

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

  const renderAbout = () => (
    <div className="settings-page about-page">
      <section className="about-hero">
        <img src={appIcon} alt="Video Reverse Prompt 图标" />
        <h2>Video Reverse Prompt</h2>
        <p className="app-version">版本 {currentVersion}</p>
        <p className="about-description">你的本地 AI 视频逆向导演工作台。<br />从参考视频生成剧本、可选角色资产和可直接复制的逐镜头成片提示词。</p>
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
      {page === 'updates' && renderUpdates()}
      {page === 'support' && renderSupport()}
      {page === 'advanced' && renderAdvanced()}
    </div>
  </div>
}
