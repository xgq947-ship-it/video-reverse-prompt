import { ArrowRight, Film, Link2, LoaderCircle, ShieldCheck, Upload } from 'lucide-react'

export type SourceMode = 'file' | 'link'

interface DropZoneProps {
  dragging: boolean
  onPick: () => void
  sourceMode: SourceMode
  onSourceMode: (mode: SourceMode) => void
  videoUrl: string
  onVideoUrl: (value: string) => void
  onResolve: () => void
  resolving: boolean
  status: string
  error: string
}

export function DropZone({
  dragging,
  onPick,
  sourceMode,
  onSourceMode,
  videoUrl,
  onVideoUrl,
  onResolve,
  resolving,
  status,
  error,
}: DropZoneProps) {
  return (
    <section className={`source-card ${dragging ? 'is-dragging' : ''}`}>
      <div className="source-tabs" role="tablist" aria-label="视频导入方式">
        <button type="button" role="tab" aria-selected={sourceMode === 'file'} className={sourceMode === 'file' ? 'active' : ''} onClick={() => onSourceMode('file')} disabled={resolving}>
          <Upload size={14} />本地视频
        </button>
        <button type="button" role="tab" aria-selected={sourceMode === 'link'} className={sourceMode === 'link' ? 'active' : ''} onClick={() => onSourceMode('link')} disabled={resolving}>
          <Link2 size={14} />视频链接
        </button>
      </div>
      {sourceMode === 'file' ? (
        <button className="drop-zone" onClick={onPick} type="button">
          <div className="drop-icon"><Film size={25} strokeWidth={1.7} /></div>
          <h2>拖入一个视频</h2>
          <p>或点击选择本地文件</p>
          <div className="formats">
            <span><Film size={13} /> MP4 · MOV · M4V · WEBM</span>
          </div>
        </button>
      ) : (
        <form className="link-import" onSubmit={(event) => { event.preventDefault(); onResolve() }}>
          <div className="link-hero-icon"><Link2 size={23} strokeWidth={1.7} /></div>
          <div className="link-heading">
            <h2>粘贴短视频链接</h2>
            <p>也可以直接粘贴含链接的整段分享文案</p>
          </div>
          <div className={`link-field ${error ? 'has-error' : ''}`}>
            <Link2 size={17} />
            <input
              value={videoUrl}
              onChange={(event) => onVideoUrl(event.target.value)}
              placeholder="https://v.douyin.com/..."
              aria-label="短视频分享链接或分享文案"
              disabled={resolving}
            />
            <button type="submit" disabled={resolving || !videoUrl.trim()}>
              {resolving ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
              {resolving ? '解析中' : '解析视频'}
            </button>
          </div>
          {error ? <div className="link-feedback error"><span>{error}</span><button type="button" onClick={onResolve}>重试</button></div> : resolving ? <div className="link-feedback loading"><LoaderCircle className="spin" size={14} /><span>{status || '正在解析视频'}</span></div> : null}
          <div className="platforms" aria-label="支持的平台">
            <span>抖音</span><span>TikTok</span><span>X / Twitter</span><span>小红书</span><span>B 站</span><span>视频直链</span>
          </div>
          <div className="link-privacy"><ShieldCheck size={14} /><span>优先获取无水印高清源，下载后保存在本机；仅支持公开且你有权使用的内容。</span></div>
        </form>
      )}
    </section>
  )
}
