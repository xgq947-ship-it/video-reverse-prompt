import { Check, Copy, LoaderCircle, RotateCcw, Sparkles, Users, MessageSquareText } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { plannedShotCount } from '../prompts/videoPrompt'
import type { AnalysisMode, AnalysisOptions, AnalysisResult, AnalysisStage } from '../types'

const VIDEO_MODES: AnalysisMode[] = ['完整反推', '动作优先', '运镜优先', '分镜优先']
const VIDEO_TABS: [string, string][] = [
  ['总览', 'VIDEO_OVERVIEW'],
  ['反推提示词', 'REVERSE_PROMPT'],
  ['剧本', 'SCRIPT'],
  ['角色提示词', 'CHARACTER_PROMPTS'],
  ['成片提示词', 'SHOT_PROMPTS'],
  ['JSON', 'JSON'],
  ['原文', 'RAW'],
]

interface Props {
  mode: AnalysisMode
  onMode: (value: AnalysisMode) => void
  options: AnalysisOptions
  onOptions: (value: AnalysisOptions) => void
  duration?: number
  stage: AnalysisStage
  status: string
  result: AnalysisResult | null
  error: string
  onAnalyze: (modifier?: string) => void
}

export function ResultPanel({ mode, onMode, options, onOptions, duration, stage, status, result, error, onAnalyze }: Props) {
  const [active, setActive] = useState(result?.parseWarning ? 'RAW' : VIDEO_TABS[0][1])
  const [copied, setCopied] = useState(false)
  const busy = !['idle', 'completed', 'error'].includes(stage)
  const shotCount = plannedShotCount(duration)
  const content = useMemo(() => {
    if (!result) return ''
    if (active === 'RAW') return result.rawResponse
    if (active === 'JSON') return result.json ? JSON.stringify(result.json, null, 2) : result.sections.JSON ?? ''
    return result.sections[active] ?? ''
  }, [active, result])

  useEffect(() => {
    if (!result) {
      setActive(VIDEO_TABS[0][1])
      return
    }
    const firstAvailable = VIDEO_TABS.find(([, key]) => {
      if (key === 'RAW') return false
      if (key === 'JSON') return Boolean(result.json || result.sections.JSON)
      return Boolean(result.sections[key])
    })
    setActive(firstAvailable?.[1] ?? 'RAW')
  }, [result])

  const copy = async () => {
    if (!content) return
    await navigator.clipboard.writeText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString() && content) {
        event.preventDefault()
        void copy()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  return (
    <section className="result-panel panel">
      <div className="result-controls">
        <label>分析模式<select value={mode} onChange={(event) => onMode(event.target.value as AnalysisMode)} disabled={busy}>{VIDEO_MODES.map((item) => <option key={item}>{item}</option>)}</select></label>
        <div className="duration-plan"><span>原片时长</span><strong>{duration ? `${duration.toFixed(1)} 秒 · ${shotCount} 镜头` : '由视频读取'}</strong></div>
        <button className="primary-button" onClick={() => onAnalyze()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : result ? <RotateCcw size={16} /> : <Sparkles size={16} />}{busy ? status : result ? '重新生成' : '开始反推'}</button>
      </div>
      <div className="pipeline-options" aria-label="生成选项">
        <label className={options.detectDialogue ? 'active' : ''}><input type="checkbox" checked={options.detectDialogue} onChange={(event) => onOptions({ ...options, detectDialogue: event.target.checked })} disabled={busy} /><MessageSquareText size={15} /><span><strong>识别角色对白</strong><small>开启后生成含逐字台词的剧本</small></span></label>
        <label className={options.generateCharacterPrompts ? 'active' : ''}><input type="checkbox" checked={options.generateCharacterPrompts} onChange={(event) => onOptions({ ...options, generateCharacterPrompts: event.target.checked })} disabled={busy} /><Users size={15} /><span><strong>生成角色提示词</strong><small>可选角色参考图与表演主档案</small></span></label>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!result && !error && <div className="empty-result"><Sparkles size={28} strokeWidth={1.35} /><h3>{busy ? status : '准备生成视频提示词包'}</h3><p>{busy ? '正在分析原片并按时长拆分镜头，请勿关闭 Gemini 浏览器窗口' : '设置对白与角色选项后开始反推，生成剧本和可直接复制的逐镜头提示词。'}</p>{busy && <div className="progress-track"><span /></div>}</div>}
      {result && <div className="result-body">
        {result.parseWarning && <div className="warning-box">{result.parseWarning}</div>}
        <div className="tabs">{VIDEO_TABS.map(([label, key]) => <button className={active === key ? 'active' : ''} key={key} onClick={() => setActive(key)}>{label}</button>)}</div>
        <div className="result-copy"><button className="quiet-button" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : active === 'SHOT_PROMPTS' ? '复制全部镜头' : '复制'}</button></div>
        <pre className="result-text">{content || '此部分没有可显示的内容，请查看原文。'}</pre>
        <div className="refine-actions"><button disabled={busy} onClick={() => onAnalyze('逐项检查并补强所有动作、身体重心、视线、手部、道具和物理细节，不得缩短任何已有有效提示词。')}>强化动作</button><button disabled={busy} onClick={() => onAnalyze('逐项检查并补强机位、景别、空间距离、单一运镜、焦点和光线逻辑，不得缩短任何已有有效提示词。')}>强化镜头</button>{options.detectDialogue && <button disabled={busy} onClick={() => onAnalyze('重新核对视频音轨与口型，只保留真正可辨认的逐字对白，校正说话人、时间码、声线和口型同步，绝不猜测。')}>校准对白</button>}<button disabled={busy} onClick={() => onAnalyze('重新核对总时长、镜头数与每条时间码，确保连续无空隙、无重叠、单镜头不超过 10 秒，并完整输出六个分区。')}>校准时长</button></div>
      </div>}
    </section>
  )
}
