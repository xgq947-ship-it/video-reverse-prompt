import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { Clock3, Clapperboard, Settings as SettingsIcon, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { parseAutomationResponse, parseProductionResponse } from './automation/parser'
import { DropZone } from './components/DropZone'
import type { SourceMode } from './components/DropZone'
import { HistoryView } from './components/HistoryView'
import { MediaPreview } from './components/MediaPreview'
import { ResultPanel } from './components/ResultPanel'
import { SettingsView } from './components/SettingsView'
import { buildVideoPrompt } from './prompts/videoPrompt'
import { loadHistory, loadSettings, saveHistory, saveSettings } from './storage/store'
import type { AnalysisMode, AnalysisResult, AnalysisStage, HistoryItem, MediaFile, MediaSource, ProductionResult, Settings } from './types'
import { DEFAULT_SETTINGS } from './types'

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
  generatorStatus?: Record<string, string | boolean>
  error?: { code: string; message: string; detail?: string }
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm'])
const isTauri = '__TAURI_INTERNALS__' in window
const isUiPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).has('ui-preview')
const isProductionPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get('ui-preview') === 'production'
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
const UI_PREVIEW_RESULT: AnalysisResult = {
  kind: 'video',
  sections: {
    VIDEO_OVERVIEW: '90 秒、16:9 的人物叙事短片；自然侧光，克制写实的电影质感。',
    TIMELINE: '00:00—00:10 主角在窗边停留。\n00:10—00:20 主角转身走向门口。\n后续镜头沿原片节奏连续展开。',
    MOTION_PROMPT: '人物先保持低重心静止，视线转向门口，随后以短而稳定的步态移动。',
    CAMERA_PROMPT: '自然标准视角，摄影机从阴影面缓慢推进，焦点跟随人物视线和步态。',
    KLING: 'Kling 优化提示词示例。',
    SEEDANCE: 'Seedance 优化提示词示例。',
    VEO: 'Veo 优化提示词示例。',
    RUNWAY: 'Runway 优化提示词示例。',
    JSON: '{"duration":90,"shots":[]}',
  },
  json: { duration: 90, shots: [] },
  rawResponse: 'Gemini 原版视频反推完整回答。',
}
const UI_PREVIEW_PRODUCTION_RESULT: ProductionResult = {
  sections: {
    SCRIPT: '# 短视频剧本\n\n## 00:00 - 00:10\n\n### 旁白\n\n她在窗边停了几秒。\n\n### 镜头\n\n人物抬眼看向门口。',
    CHARACTER_PROMPTS: '## CHAR_01 · 年轻女性\n\n### 角色参考图提示词\n\n同一位真实质感演员的三联棚拍电影选角页……',
    SHOT_PROMPTS: '## shot_01 · 窗边停留 · 0.000—10.000 秒\n\n[[CHAR_01]] 第一帧已经站在窗边，眼神先于头部转向门口……\n\n音频（使用模型原生音频）\n室内轻微风声。',
    JSON: '{"duration_seconds":90,"characters":[{"id":"char_01"}],"shots":[{"shot_id":"shot_01"}]}',
  },
  json: { duration_seconds: 90, characters: [{ id: 'char_01' }], shots: [{ shot_id: 'shot_01' }] },
  rawResponse: 'HotStory 第二步完整生成结果。',
}

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function App() {
  const [file, setFile] = useState<MediaFile | null>(isUiPreview ? UI_PREVIEW_FILE : null)
  const [mode, setMode] = useState<AnalysisMode>('完整反推')
  const [result, setResult] = useState<AnalysisResult | null>(isProductionPreview ? UI_PREVIEW_RESULT : null)
  const [productionResult, setProductionResult] = useState<ProductionResult | null>(isProductionPreview ? UI_PREVIEW_PRODUCTION_RESULT : null)
  const [stage, setStage] = useState<AnalysisStage>('idle')
  const [productionStage, setProductionStage] = useState<AnalysisStage>(isProductionPreview ? 'completed' : 'idle')
  const [status, setStatus] = useState('')
  const [productionStatus, setProductionStatus] = useState(isProductionPreview ? '剧本、角色与多分镜提示词已完成' : '')
  const [error, setError] = useState('')
  const [productionError, setProductionError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState<'main' | 'history' | 'settings'>('main')
  const [settingsPage, setSettingsPage] = useState<'generator' | 'about'>('about')
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [connection, setConnection] = useState<'unknown' | 'connected' | 'disconnected' | 'checking'>('unknown')
  const [checks, setChecks] = useState<Record<string, boolean> | null>(null)
  const [sourceMode, setSourceMode] = useState<SourceMode>('link')
  const [videoUrl, setVideoUrl] = useState('')
  const [resolvingLink, setResolvingLink] = useState(false)
  const [linkError, setLinkError] = useState('')
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null)

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
      setResult(null)
      setProductionResult(null)
      setProductionStage('idle')
      setProductionStatus('')
      setProductionError('')
      setActiveHistoryId(null)
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
      if (['writing-script', 'creating-characters', 'planning-shots', 'generating-shots'].includes(payload.stage)) {
        setProductionStage(payload.stage)
        setProductionStatus(payload.message)
      } else {
        setStage(payload.stage)
        setStatus(payload.message)
      }
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
    setProductionResult(null)
    setProductionStage('idle')
    setProductionStatus('')
    setProductionError('')
    setStage('preparing')
    setStatus(refining ? '正在继续优化反推结果' : '准备 Gemini 视频反推')
    const prompt = refining
      ? `请基于本对话中上一份视频反推结果继续调整，不要要求重新上传附件。\n本次调整要求：${modifier}\n必须保留所有仍然有效的信息，并严格沿用 ---VIDEO_OVERVIEW---、---TIMELINE---、---MOTION_PROMPT---、---CAMERA_PROMPT---、---KLING---、---SEEDANCE---、---VEO---、---RUNWAY---、---JSON--- 九个原版标记，完整重发全部分区。`
      : buildVideoPrompt(mode)
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
        const itemId = crypto.randomUUID()
        const item: HistoryItem = {
          id: itemId,
          type: 'video',
          timestamp: Date.now(),
          filename: file.source?.title || file.name,
          filepath: file.path,
          mode,
          result: parsed,
          source: file.source,
        }
        const next = [item, ...history].slice(0, settings.maxHistory)
        setHistory(next)
        setActiveHistoryId(itemId)
        await saveHistory(next)
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setError(message.replace(/^Error:\s*/, ''))
      setStage('error')
      setStatus('失败')
      if (/登录|验证/.test(message)) setConnection('disconnected')
    }
  }, [file, history, mode, result, settings])

  const generateProduction = useCallback(async () => {
    if (!file || !result || !isTauri) return
    if (settings.generationProvider === 'deepseek' && !settings.deepseekApiKey.trim()) {
      setProductionError('请先在“设置 → 生成模型”中填写 DeepSeek API Key。')
      return
    }
    setProductionResult(null)
    setProductionError('')
    setProductionStage('writing-script')
    setProductionStatus('正在生成短视频剧本')
    try {
      const payload = await invoke<AutomationPayload>('run_automation', {
        request: {
          command: 'generate-production',
          reverseResponse: result.rawResponse,
          duration: file.duration,
          filename: file.source?.title || file.name,
          generator: {
            provider: settings.generationProvider,
            deepseekApiKey: settings.generationProvider === 'deepseek' ? settings.deepseekApiKey : undefined,
          },
          debug: settings.debug,
        },
      })
      if (!payload.ok || !payload.rawResponse) throw new Error(payload.error?.message ?? '生成模型没有返回可读取的结果。')
      const parsed = parseProductionResponse(payload.rawResponse)
      setProductionResult(parsed)
      setProductionStage('completed')
      setProductionStatus('剧本、角色与多分镜提示词已完成')
      if (settings.saveHistory) {
        const currentId = activeHistoryId
        let next: HistoryItem[]
        if (currentId && history.some((item) => item.id === currentId)) {
          next = history.map((item) => item.id === currentId ? { ...item, productionResult: parsed } : item)
        } else {
          const itemId = crypto.randomUUID()
          const historyItem: HistoryItem = {
            id: itemId,
            type: 'video',
            timestamp: Date.now(),
            filename: file.source?.title || file.name,
            filepath: file.path,
            mode,
            result,
            productionResult: parsed,
            source: file.source,
          }
          next = [historyItem, ...history].slice(0, settings.maxHistory)
          setActiveHistoryId(itemId)
        }
        setHistory(next)
        await saveHistory(next)
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      setProductionError(message.replace(/^Error:\s*/, ''))
      setProductionStage('error')
      setProductionStatus('生成失败')
    }
  }, [activeHistoryId, file, history, mode, result, settings])

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
    setResult(item.result)
    setProductionResult(item.productionResult ?? null)
    setProductionStage(item.productionResult ? 'completed' : 'idle')
    setProductionStatus(item.productionResult ? '剧本、角色与多分镜提示词已完成' : '')
    setActiveHistoryId(item.id)
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
    <header className="titlebar" data-tauri-drag-region><div className="brand"><div className="brand-mark"><Clapperboard size={16} /></div><div><strong>{view === 'settings' ? 'Video Reverse Prompt 设置' : 'Video Reverse Prompt'}</strong>{view !== 'settings' && <span>GEMINI REVERSE → HOTSTORY PRODUCTION</span>}</div></div><nav><button onClick={() => setView('history')} className={view === 'history' ? 'active' : ''}><Clock3 size={15} />历史记录</button><button onClick={() => { setSettingsPage('about'); setView('settings') }} className={view === 'settings' ? 'active' : ''}><SettingsIcon size={15} />设置</button></nav></header>
    <main className={view === 'settings' ? 'settings-main' : ''}>
      {view === 'main' && (!file ? <div className="home"><div className="hero-copy"><span className="eyebrow">GEMINI VIDEO REVERSE · HOTSTORY PIPELINE</span><h1>先反推原片，<br />再生成整套分镜。</h1><p>第一步沿用 Reverse Prompt 原版 Gemini 视频分析；完成后再用 DeepSeek 或 Codex CLI 生成短视频剧本、角色参考图提示词和可直接复制的多分镜视频提示词。</p><div className="hero-steps"><span><b>01</b>导入原片</span><i /><span><b>02</b>Gemini 反推</span><i /><span><b>03</b>生成剧本分镜</span></div></div><DropZone dragging={dragging} onPick={pickFile} sourceMode={sourceMode} onSourceMode={(next) => { setSourceMode(next); setLinkError('') }} videoUrl={videoUrl} onVideoUrl={(value) => { setVideoUrl(value); if (linkError) setLinkError('') }} onResolve={() => void resolveVideoLink()} resolving={resolvingLink} status={status} error={linkError} /></div> : <div className="workspace"><MediaPreview file={file} previewUrl={previewUrl} onClear={() => { setFile(null); setResult(null); setProductionResult(null); setError(''); setProductionError(''); setStage('idle'); setProductionStage('idle'); setStatus(''); setActiveHistoryId(null) }} onMetadata={(width, height, duration) => setFile((current) => current ? { ...current, width, height, duration } : current)} /><ResultPanel mode={mode} onMode={setMode} duration={file.duration} stage={stage} status={status} result={result} error={error} onAnalyze={analyze} productionResult={productionResult} productionStage={productionStage} productionStatus={productionStatus} productionError={productionError} onGenerateProduction={() => void generateProduction()} generationLabel={settings.generationProvider === 'deepseek' ? 'DeepSeek V4 Flash MAX' : 'Codex CLI'} onOpenGenerationSettings={() => { setSettingsPage('generator'); setView('settings') }} /></div>)}
      {view === 'history' && <div className="subpage"><div className="subpage-header"><div><span>VIDEO PACKAGES</span><h1>历史记录</h1></div><button className="icon-button" onClick={() => setView('main')}><X size={18} /></button></div><HistoryView items={history} onOpen={openHistoryItem} onDelete={deleteHistoryItem} onReanalyze={(item) => { void openHistoryItem(item) }} /></div>}
      {view === 'settings' && <div className="settings-subpage"><button className="settings-close icon-button" onClick={() => setView('main')} title="关闭设置"><X size={18} /></button><SettingsView settings={settings} onChange={setSettings} connection={connection} onOpenGemini={() => void runSimple('open')} onCheck={() => void runSimple('check-login')} onCompatibility={() => void runSimple('compatibility')} checks={checks} onClearHistory={clearHistory} initialPage={settingsPage} /></div>}
    </main>
    <footer><span>Gemini 负责原片反推 · DeepSeek/Codex 负责剧本、角色与多分镜提示词</span><span><kbd>⌘</kbd><kbd>O</kbd> 选择视频</span></footer>
  </div>
}

export default App
