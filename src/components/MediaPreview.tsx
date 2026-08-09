import { BadgeCheck, Film, Link2, X } from 'lucide-react'
import type { MediaFile } from '../types'
import { formatBytes, formatDuration } from '../utils/format'

interface Props { file: MediaFile; previewUrl: string; onClear: () => void; onMetadata: (width: number, height: number, duration?: number) => void }

const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音',
  tiktok: 'TikTok',
  twitter: 'X / Twitter',
  xiaohongshu: '小红书',
  bilibili: 'B 站',
  direct: '视频直链',
}

function watermarkLabel(value?: string): string {
  if (value === 'removed') return '无水印源'
  if (value === 'original') return '原始高清源'
  if (value === 'present') return '备用视频源'
  return '已本地化'
}

export function MediaPreview({ file, previewUrl, onClear, onMetadata }: Props) {
  const source = file.source
  return (
    <section className="preview-panel panel">
      <div className="panel-title"><span>{source ? '链接视频预览' : '本地视频预览'}</span><button className="icon-button" onClick={onClear} title="移除视频"><X size={16} /></button></div>
      <div className="media-frame">
        <video src={previewUrl || undefined} controls onLoadedMetadata={(event) => onMetadata(event.currentTarget.videoWidth, event.currentTarget.videoHeight, event.currentTarget.duration)} />
      </div>
      <div className="file-info">
        {source && <div className="source-summary"><span className="source-platform"><Link2 size={12} />{PLATFORM_LABELS[source.platform] || source.platform}</span><span className={`source-quality ${source.watermarkStatus === 'present' ? 'fallback' : ''}`}><BadgeCheck size={12} />{watermarkLabel(source.watermarkStatus)}</span>{source.author && <span className="source-author">{source.author}</span>}</div>}
        <div className="file-name"><Film size={15} /><span title={source?.title || file.name}>{source?.title || file.name}</span></div>
        <dl>
          <div><dt>大小</dt><dd>{formatBytes(file.size)}</dd></div>
          <div><dt>分辨率</dt><dd>{file.width ? `${file.width} × ${file.height}` : '读取中'}</dd></div>
          <div><dt>时长</dt><dd>{formatDuration(file.duration)}</dd></div>
          <div><dt>格式</dt><dd>{file.extension.toUpperCase()}</dd></div>
        </dl>
      </div>
    </section>
  )
}
