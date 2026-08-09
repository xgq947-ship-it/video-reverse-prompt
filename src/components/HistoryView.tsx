import { Clipboard, Clock3, RotateCcw, Trash2 } from 'lucide-react'
import type { HistoryItem } from '../types'

interface Props { items: HistoryItem[]; onOpen: (item: HistoryItem) => void; onDelete: (id: string) => void; onReanalyze: (item: HistoryItem) => void }

export function HistoryView({ items, onOpen, onDelete, onReanalyze }: Props) {
  if (!items.length) return <div className="history-empty"><Clock3 size={28} /><h3>暂无历史记录</h3><p>完成的视频生成包会保存在本机。</p></div>
  return <div className="history-list">{items.map((item) => <article key={item.id} className="history-item" onClick={() => onOpen(item)}><div className="history-type video">VID</div><div className="history-main"><strong>{item.filename}</strong><span>{item.mode} · {item.productionResult ? '剧本分镜已生成' : 'Gemini 反推'} · {new Date(item.timestamp).toLocaleString('zh-CN')}</span></div><div className="history-actions"><button title="复制提示词" onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(item.productionResult?.sections.SHOT_PROMPTS ?? item.result.sections.SEEDANCE ?? item.result.rawResponse) }}><Clipboard size={14} /></button><button title="再次分析" onClick={(event) => { event.stopPropagation(); onReanalyze(item) }}><RotateCcw size={14} /></button><button title="删除" onClick={(event) => { event.stopPropagation(); onDelete(item.id) }}><Trash2 size={14} /></button></div></article>)}</div>
}
