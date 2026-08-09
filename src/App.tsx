import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { Clock3, Clapperboard, Settings as SettingsIcon, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { parseAutomationResponse } from './automation/parser'
import { DropZone } from './components/DropZone'
import type { SourceMode } from './components/DropZone'
import { HistoryView } from './components/HistoryView'
import { MediaPreview } from './components/MediaPreview'
import { ResultPanel } from './components/ResultPanel'
import { SettingsView } from './components/SettingsView'
import { buildVideoPrompt } from './prompts/videoPrompt'
import { loadHistory, loadSettings, saveHistory, saveSettings } from './storage/store'
import type { AnalysisMode, AnalysisOptions, AnalysisResult, AnalysisStage, HistoryItem, MediaFile, MediaSource, Settings } from './types'
import { DEFAULT_ANALYSIS_OPTIONS, DEFAULT_SETTINGS } from './types'

interface ImportedVideoPayload {
  filePath: string
  name: string
  size: number
  extension: string
  type: 'video'
  sourceUrl: string
  platform: string
  title?: string
  author?: string
  coverUrl?: string
  duration?: number
  watermarkStatus?: string
}

interface AutomationPayload {
  ok: boolean
  loggedIn?: boolean
  checks?: Record<string, boolean>
  rawResponse?: string
  importedVideo?: ImportedVideoPayload
  error?: { code: string; message: string; detail?: string }
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm'])
const isTauri = '__TAURI_INTERNALS__' in window
const isUiPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).has('ui-preview')
const UI_PREVIEW_FILE: MediaFile = {
  path: '',
  name: 'reference-video-90s.mp4',
  size: 48_320_000,
  extension: 'mp4',
  type: 'video',
  width: 1920,
  height: 1080,
  duration: 90,
}

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function App() {
  const [file, setFile] = useState<MediaFile | null>(isUiPreview ? UI_PREVIEW_FILE : null)
  const [mode, setMode] = useState<AnalysisMode>('完整反推')
  const [options, setOptions] = useState<AnalysisOptions>(DEFAULT_ANALYSIS_OPTIONS)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [stage, setStage] = useState<AnalysisStage>('idle')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState<'main' | 'history' | 'settings'>('main')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [connection, setConnection] = useState<'unknown' | 'connected' | 'disconnected' | 'checking'>('unknown')
  const [checks, setChecks] = useState<Record<string, boolean> | null>(null)
  const [sourceMode, setSourceMode] = useState<SourceMode>('link')
  const [videoUrl, setVideoUrl] = useState('')
  const [resolvingLink, setResolvingLink] = useState(false)
  const [linkError, setLinkError] = useState('')

  useEffect(() => {
    void Promise.all([loadSettings(), loadHistory()]).then(async ([loadedSettings, loadedHistory]) => {
      setSettings(loadedSettings)
      setMode(loadedSettings.defaultVideoMode)
      setHistory(loadedHistory)
      if (!isTauri) return
      setConnection('checking')
      try {
        const payload = await invoke<AutomationPayload>('run_automation', {
          request: {
            command: 'check-login',
            geminiUrl: loadedSettings.geminiUrl,
            browserBehavior: loadedSettings.browserBehavior,
            debug: loadedSettings.debug,
          },
        })
        const loggedIn = Boolean(payload.ok && payload.loggedIn)
        setConnection(loggedIn ? 'connected' : 'disconnected')
        if (!loggedIn) {
          setView('settings')
          await invoke<AutomationPayload>('run_automation', {
            request: {
              command: 'open',
              geminiUrl: loadedSettings.geminiUrl,
              browserBehavior: 'show',
              debug: loadedSettings.debug,
            },
          }).catch(() => undefined)
        }
      } catch {
        setConnection('disconnected')
      }
    })
  }, [])

  useEffect(() => { void saveSettings(settings) }, [settings])

  const acceptPath = useCallback(async (path: string, source?: MediaSource) => {
    const extension = extensionOf(path)
    if (!VIDEO_EXTENSIONS.has(extension)) {
      setError('文件格式不支持。请选择 MP4、MOV、M4V 或 WEBM 视频。')
      return
    }
    if (file && !window.confirm('已选择一个视频，是否替换？')) return
    try {
      const metadata = await invoke<{ name: string; size: number }>('get_file_metadata', { path })
      setFile({ path, name: metadata.name, size: metadata.size, extension, type: 'video', source })
      setMode(settings.defaultVideoMode)
      setOptions(DEFAULT_ANALYSIS_OPTIONS)
      setResult(null)
      setError('')
      setStatus('')
      setStage('idle')
      setView('main')
    } catch {
      setError('无法读取视频，请确认文件仍然存在且有访问权限。')
    }
  }, [file, settings.defaultVideoMode])

  useEffect(() => {
    if (!isTauri) return
    const unlistenProgress = listen<{ stage: AnalysisStage; message: string }>('automation-progress', ({ payload }) => {
      setStage(payload.stage)
      setStatus(payload.message)
    })
    const unlistenDrop = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === 'over') setDragging(true)
      if (event.payload.type === 'leave') setDragging(false)
      if (event.payload.type === 'drop') {
        setDragging(false)
        const path = event.payload.paths[0]
        if (path) void acceptPath(path)
      }
    })
    return () => {
      void unlistenProgress.then((fn) => fn())
      void unlistenDrop.then((fn) => fn())
    }
  }, [acceptPath])

  const pickFile = useCallback(async () => {
    if (!isTauri) {
      setError('请通过 Tauri 桌面窗口运行此功能。')
      return
    }
    const selected = await open({ multiple: false, directory: false, filters: [{ name: '视频', extensions: [...VIDEO_EXTENSIONS] }] })
    if (selected) await acceptPath(selected)
  }, [acceptPath])

  const resolveVideoLink = useCallback(async () => {
    const input = videoUrl.trim()
    if (!input) {
      setLinkError('请先粘贴视频链接或分享文案。')
      return
    }
    if (!isTauri) {
      setLinkError('请通过 Video Reverse Prompt 桌面应用解析视频链接。')
      return
    }
    setResolvingLink(true)
    setLinkError('')
    setError('')
    setStage('resolving')
    setStatus('正在识别视频平台')
    try {
      const payload = await invoke<AutomationPayload>('run_automation', {
        request: { command: 'resolve-video', mediaInput: input, debug: settings.debug },
      })
      if (!payload.ok || !payload.importedVideo) {
        throw new Error(payload.error?.message ?? '没有解析到可用的视频。')
      }
      const imported = payload.importedVideo
      await acceptPath(imported.filePath, {
        kind: 'link',
        sourceUrl: imported.sourceUrl,
        platform: imported.platform,
        title: imported.title,
        author: imported.author,
        coverUrl: imported.coverUrl,
        watermarkStatus: imported.watermarkStatus,
      })
      setFile((current) => current && current.path === imported.filePath && imported.duration
        ? { ...current, duration: imported.duration }
        : current)
      setVideoUrl('')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setLinkError(message.replace(/^Error:\s*/, ''))
      setStage('error')
      setStatus('解析失败')
    } finally {
      setResolvingLink(false)
    }
  }, [acceptPath, settings.debug, videoUrl])

  const analyze = useCallback(async (modifier = '') => {
    if (!file || !isTauri) return
    const refining = Boolean(modifier && result)
    setError('')
    if (!refining) setResult(null)
    setStage('preparing')
    setStatus(refining ? '正在继续优化' : '准备视频生成包')
    const prompt = refining
      ? `请基于本对话中上一份视频生成包继续调整，不要要求重新上传附件。\n本次调整要求：${modifier}\n必须保留所有仍然有效的信息，严格沿用 ---VIDEO_OVERVIEW---、---REVERSE_PROMPT---、---SCRIPT---、---CHARACTER_PROMPTS---、---SHOT_PROMPTS---、---JSON--- 六个标记并完整重发全部分区。继续遵守本次设置：识别角色对白=${options.detectDialogue ? '开启' : '关闭'}；生成角色提示词=${options.generateCharacterPrompts ? '开启' : '关闭'}；原视频时长=${file.duration?.toFixed(3) ?? '从附件读取'} 秒；单镜头不得超过 10 秒。`
      : buildVideoPrompt({ mode, duration: file.duration, ...options })
    try {
      const payload = await invoke<AutomationPayload>('run_automation', {
        request: {
          command: refining ? 'refine' : 'analyze',
          geminiUrl: settings.geminiUrl,
          filePath: refining ? undefined : file.path,
          mediaType: 'video',
          prompt,
          browserBehavior: settings.browserBehavior,
          debug: settings.debug,
        },
      })
      if (!payload.ok || !payload.rawResponse) {
        throw new Error(payload.error?.message ?? 'Gemini 没有返回可读取的回答。')
      }
      const parsed = parseAutomationResponse(payload.rawResponse)
      setResult(parsed)
      setStage('completed')
      setStatus('完成')
      setConnection('connected')
      if (settings.saveHistory) {
        const item: HistoryItem = {
          id: crypto.randomUUID(),
          type: 'video',
          timestamp: Date.now(),
          filename: file.source?.title || file.name,
          filepath: file.path,
          mode,
          options,
          result: parsed,
          source: file.source,
        }
        const next = [item, ...history].slice(0, settings.maxHistory)
        setHistory(next)
        await saveHistory(next)
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message.replace(/^Error:\s*/, ''))
      setStage('error')
      setStatus('失败')
      if (/登录|验证/.test(message)) setConnection('disconnected')
    }
  }, [file, history, mode, options, result, settings])

  const runSimple = async (command: 'open' | 'check-login' | 'compatibility') => {
    if (!isTauri) return
    if (command === 'check-login') setConnection('checking')
    try {
      const payload = await invoke<AutomationPayload>('run_automation', {
        request: {
          command,
          geminiUrl: settings.geminiUrl,
          browserBehavior: command === 'open' ? 'show' : settings.browserBehavior,
          debug: settings.debug,
        },
      })
      if (!payload.ok) throw new Error(payload.error?.message)
      if (command === 'check-login' || command === 'compatibility') setConnection(payload.loggedIn ? 'connected' : 'disconnected')
      if (payload.checks) setChecks(payload.checks)
    } catch {
      setConnection('disconnected')
    }
  }

  const clearHistory = async () => {
    if (!history.length || window.confirm('确定清空全部本地历史记录？')) {
      setHistory([])
      await saveHistory([])
    }
  }
  const openHistoryItem = async (item: HistoryItem) => {
    await acceptPath(item.filepath, item.source)
    setMode(item.mode)
    setOptions(item.options ?? DEFAULT_ANALYSIS_OPTIONS)
    setResult(item.result)
  }
  const deleteHistoryItem = async (id: string) => {
    const next = history.filter((item) => item.id !== id)
    setHistory(next)
    await saveHistory(next)
  }
  const previewUrl = useMemo(() => file && !isUiPreview ? convertFileSrc(file.path) : '', [file])

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return
      if (event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void pickFile()
      }
      if (event.key === 'Enter' && file) {
        event.preventDefault()
        void analyze()
      }
      if (event.key.toLowerCase() === 'r' && file) {
        event.preventDefault()
        void analyze()
      }
      if (event.key === ',') {
        event.preventDefault()
        setView('settings')
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [analyze, file, pickFile])

  useEffect(() => {
    if (!isTauri) return
    const unlisten = listen<string>('menu-action', ({ payload }) => {
      if (payload === 'open-file') void pickFile()
      if ((payload === 'start-analysis' || payload === 'reanalyze') && file) void analyze()
      if (payload === 'settings') setView('settings')
    })
    return () => { void unlisten.then((fn) => fn()) }
  }, [analyze, file, pickFile])

  return <div className="app-shell">
    <header className="titlebar" data-tauri-drag-region><div className="brand"><div className="brand-mark"><Clapperboard size={16} /></div><div><strong>{view === 'settings' ? 'Video Reverse Prompt 设置' : 'Video Reverse Prompt'}</strong>{view !== 'settings' && <span>VIDEO → SCRIPT · CHARACTER · SHOT PROMPTS</span>}</div></div><nav><button onClick={() => setView('history')} className={view === 'history' ? 'active' : ''}><Clock3 size={15} />历史记录</button><button onClick={() => setView('settings')} className={view === 'settings' ? 'active' : ''}><SettingsIcon size={15} />设置</button></nav></header>
    <main className={view === 'settings' ? 'settings-main' : ''}>
      {view === 'main' && (!file ? <div className="home"><div className="hero-copy"><span className="eyebrow">VIDEO REVERSE ENGINEERING · HOTSTORY PIPELINE</span><h1>从参考视频，<br />还原整套生成提示词。</h1><p>导入公开短视频链接或本地视频，按原片时长反推画面、剧本、可选角色资产和逐镜头成片提示词；对白识别由你决定。</p><div className="hero-steps"><span><b>01</b>导入原片</span><i /><span><b>02</b>选择对白/角色</span><i /><span><b>03</b>复制生成</span></div></div><DropZone dragging={dragging} onPick={pickFile} sourceMode={sourceMode} onSourceMode={(next) => { setSourceMode(next); setLinkError('') }} videoUrl={videoUrl} onVideoUrl={(value) => { setVideoUrl(value); if (linkError) setLinkError('') }} onResolve={() => void resolveVideoLink()} resolving={resolvingLink} status={status} error={linkError} /></div> : <div className="workspace"><MediaPreview file={file} previewUrl={previewUrl} onClear={() => { setFile(null); setResult(null); setError(''); setStage('idle'); setStatus('') }} onMetadata={(width, height, duration) => setFile((current) => current ? { ...current, width, height, duration } : current)} /><ResultPanel mode={mode} onMode={setMode} options={options} onOptions={setOptions} duration={file.duration} stage={stage} status={status} result={result} error={error} onAnalyze={analyze} /></div>)}
      {view === 'history' && <div className="subpage"><div className="subpage-header"><div><span>VIDEO PACKAGES</span><h1>历史记录</h1></div><button className="icon-button" onClick={() => setView('main')}><X size={18} /></button></div><HistoryView items={history} onOpen={openHistoryItem} onDelete={deleteHistoryItem} onReanalyze={(item) => { void openHistoryItem(item) }} /></div>}
      {view === 'settings' && <div className="settings-subpage"><button className="settings-close icon-button" onClick={() => setView('main')} title="关闭设置"><X size={18} /></button><SettingsView settings={settings} onChange={setSettings} connection={connection} onOpenGemini={() => void runSimple('open')} onCheck={() => void runSimple('check-login')} onCompatibility={() => void runSimple('compatibility')} checks={checks} onClearHistory={clearHistory} /></div>}
    </main>
    <footer><span>原片只在开始反推后上传 · 使用你的 Gemini Web 会话</span><span><kbd>⌘</kbd><kbd>O</kbd> 选择视频</span></footer>
  </div>
}

export default App
