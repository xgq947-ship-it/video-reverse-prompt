import { Check, Copy, FileVideo2, LoaderCircle, RotateCcw, Settings2, Sparkles, Tags, WandSparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AnalysisMode, AnalysisResult, AnalysisStage, ProductionResult, StoryboardMode } from '../types'

const VIDEO_MODES: AnalysisMode[] = ['完整反推', '动作优先', '运镜优先', '分镜优先']
const REVERSE_TABS: [string, string][] = [
  ['总览', 'VIDEO_OVERVIEW'],
  ['时间线', 'TIMELINE'],
  ['动作', 'MOTION_PROMPT'],
  ['镜头', 'CAMERA_PROMPT'],
  ['Kling', 'KLING'],
  ['Seedance', 'SEEDANCE'],
  ['Veo', 'VEO'],
  ['Runway', 'RUNWAY'],
  ['JSON', 'JSON'],
  ['原文', 'RAW'],
]
const PRODUCTION_TABS: [string, string][] = [
  ['短视频剧本', 'SCRIPT'],
  ['角色提示词', 'CHARACTER_PROMPTS'],
  ['多分镜提示词', 'SHOT_PROMPTS'],
  ['生成包 JSON', 'JSON'],
  ['生成原文', 'RAW'],
]

interface Props {
  mode: AnalysisMode
  onMode: (value: AnalysisMode) => void
  duration?: number
  stage: AnalysisStage
  status: string
  result: AnalysisResult | null
  error: string
  onAnalyze: (modifier?: string) => void
  productionResult: ProductionResult | null
  productionStage: AnalysisStage
  productionStatus: string
  productionError: string
  storyboardMode: StoryboardMode
  onStoryboardMode: (value: StoryboardMode) => void
  protagonistTags: [string, string]
  onProtagonistTags: (value: [string, string]) => void
  onGenerateProduction: () => void
  generationLabel: string
  onOpenGenerationSettings: () => void
}

function resultContent(result: AnalysisResult | ProductionResult | null, key: string): string {
  if (!result) return ''
  if (key === 'RAW') return result.rawResponse
  if (key === 'JSON') return result.json ? JSON.stringify(result.json, null, 2) : result.sections.JSON ?? ''
  return result.sections[key] ?? ''
}

export function ResultPanel({
  mode,
  onMode,
  duration,
  stage,
  status,
  result,
  error,
  onAnalyze,
  productionResult,
  productionStage,
  productionStatus,
  productionError,
  storyboardMode,
  onStoryboardMode,
  protagonistTags,
  onProtagonistTags,
  onGenerateProduction,
  generationLabel,
  onOpenGenerationSettings,
}: Props) {
  const [phase, setPhase] = useState<'reverse' | 'production'>('reverse')
  const [active, setActive] = useState(REVERSE_TABS[0][1])
  const [copied, setCopied] = useState(false)
  const analysisBusy = !['idle', 'completed', 'error'].includes(stage)
  const productionBusy = !['idle', 'completed', 'error'].includes(productionStage)
  const busy = analysisBusy || productionBusy
  const tenSecondSegmentCount = duration ? Math.max(1, Math.ceil(duration / 10)) : null
  const sourceShotCount = useMemo(() => {
    if (!result?.json || typeof result.json !== 'object' || Array.isArray(result.json)) return null
    const shots = (result.json as Record<string, unknown>).shots
    return Array.isArray(shots) ? shots.length : null
  }, [result])
  const selectedResult = phase === 'production' ? productionResult : result
  const content = useMemo(() => resultContent(selectedResult, active), [active, selectedResult])

  useEffect(() => {
    if (!result) {
      setPhase('reverse')
      setActive(REVERSE_TABS[0][1])
    }
  }, [result])

  useEffect(() => {
    if (!productionResult) return
    setPhase('production')
    setActive('SHOT_PROMPTS')
  }, [productionResult])

  const selectTab = (nextPhase: 'reverse' | 'production', key: string) => {
    setPhase(nextPhase)
    setActive(key)
  }

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
        <label>Gemini 反推模式<select value={mode} onChange={(event) => onMode(event.target.value as AnalysisMode)} disabled={busy}>{VIDEO_MODES.map((item) => <option key={item}>{item}</option>)}</select></label>
        <div className="duration-plan"><span>原片时长</span><strong>{duration ? `${duration.toFixed(1)} 秒${storyboardMode === 'ten_second_groups' && tenSecondSegmentCount ? ` · ${tenSecondSegmentCount} 个生成片段` : storyboardMode === 'source_shots' && sourceShotCount ? ` · ${sourceShotCount} 个原片分镜` : ''}` : '由视频读取'}</strong></div>
        <button className="primary-button" onClick={() => onAnalyze()} disabled={busy}>{analysisBusy ? <LoaderCircle className="spin" size={16} /> : result ? <RotateCcw size={16} /> : <Sparkles size={16} />}{analysisBusy ? status : result ? '重新反推' : '开始反推'}</button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!result && !error && <div className="empty-result"><FileVideo2 size={30} strokeWidth={1.3} /><h3>{analysisBusy ? status : '第一步：Gemini 视频反推'}</h3><p>{analysisBusy ? '正在按 Reverse Prompt 原版流程分析原片，请勿关闭 Gemini 登录窗口。' : '先生成原版时间线、动作、运镜和各视频模型提示词；完成后再生成短视频剧本。'}</p>{analysisBusy && <div className="progress-track"><span /></div>}</div>}

      {result && <div className="result-body">
        <div className="pipeline-status">
          <button className={phase === 'reverse' ? 'active done' : 'done'} onClick={() => selectTab('reverse', 'VIDEO_OVERVIEW')}><b>1</b><span>Gemini 视频反推<small>已完成</small></span></button>
          <i />
          <button className={phase === 'production' ? 'active' : ''} disabled={!productionResult} onClick={() => productionResult && selectTab('production', 'SHOT_PROMPTS')}><b>2</b><span>剧本 · 角色 · 多分镜<small>{productionBusy ? productionStatus : productionResult ? '已完成' : '等待生成'}</small></span></button>
        </div>

        <div className="production-callout">
          <div><WandSparkles size={19} /><span><strong>第二步：生成短视频剧本</strong><small>选择生成片段划分方式；可为 1–2 个主角指定已有标签，留空则自动生成人物描述。</small></span></div>
          <div className="production-options">
            <div className="storyboard-mode" role="group" aria-label="分镜划分方式">
              <button type="button" className={storyboardMode === 'ten_second_groups' ? 'active' : ''} onClick={() => onStoryboardMode('ten_second_groups')} disabled={busy}><strong>每 10 秒一段</strong><small>段内可保留多个原分镜，减少生成次数</small></button>
              <button type="button" className={storyboardMode === 'source_shots' ? 'active' : ''} onClick={() => onStoryboardMode('source_shots')} disabled={busy}><strong>沿用原片分镜</strong><small>按原剪辑点和原时长逐个生成</small></button>
            </div>
            <div className="protagonist-tags"><span><Tags size={12} />主角标签（可选）</span><label><b>@</b><input value={protagonistTags[0]} onChange={(event) => onProtagonistTags([event.target.value.replace(/^@/, ''), protagonistTags[1]])} placeholder="主角1标签" disabled={busy} maxLength={32} /></label><label><b>@</b><input value={protagonistTags[1]} onChange={(event) => onProtagonistTags([protagonistTags[0], event.target.value.replace(/^@/, '')])} placeholder="主角2标签" disabled={busy} maxLength={32} /></label></div>
          </div>
          <div className="production-actions"><button className="model-link" onClick={onOpenGenerationSettings} disabled={productionBusy}><Settings2 size={13} />{generationLabel}</button><button className="production-button" onClick={onGenerateProduction} disabled={busy}>{productionBusy ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}{productionBusy ? productionStatus : '生成短视频剧本'}</button></div>
          {productionBusy && <div className="production-progress"><span /></div>}
          {productionError && <div className="inline-generation-error">{productionError}</div>}
        </div>

        {(phase === 'reverse' || productionResult) && <>
          {(phase === 'reverse' ? result.parseWarning : productionResult?.parseWarning) && <div className="warning-box">{phase === 'reverse' ? result.parseWarning : productionResult?.parseWarning}</div>}
          <div className="tabs">
            {(phase === 'reverse' ? REVERSE_TABS : PRODUCTION_TABS).map(([label, key]) => <button className={active === key ? 'active' : ''} key={`${phase}-${key}`} onClick={() => selectTab(phase, key)}>{label}</button>)}
          </div>
          <div className="result-copy"><button className="quiet-button" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : active === 'SHOT_PROMPTS' ? '复制全部分镜' : '复制'}</button></div>
          <pre className="result-text">{content || '此部分没有可显示的内容，请查看原文。'}</pre>
          {phase === 'reverse' ? <div className="refine-actions"><button disabled={busy} onClick={() => onAnalyze('逐项检查并补强所有动作、身体重心、视线、手部、道具和物理细节，不得缩短任何已有有效提示词。')}>强化动作</button><button disabled={busy} onClick={() => onAnalyze('逐项检查并补强机位、景别、空间距离、单一运镜、焦点和光线逻辑，不得缩短任何已有有效提示词。')}>强化镜头</button><button disabled={busy} onClick={() => onAnalyze('重新核对总时长、全部 Shot 与每条时间码，确保时间线连续并完整输出原版九个分区。')}>校准时间线</button></div> : <div className="refine-actions production-footer"><span>{generationLabel} · {storyboardMode === 'ten_second_groups' ? '10 秒生成片段' : '原片分镜时长'}{protagonistTags.some((tag) => tag.trim()) ? ' · 使用主角标签' : ' · AI 人物描述'}</span><button disabled={busy} onClick={onGenerateProduction}><RotateCcw size={12} />按当前设置重新生成</button></div>}
        </>}
      </div>}
    </section>
  )
}
