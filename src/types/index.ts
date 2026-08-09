export type MediaType = 'video'
export type VideoMode = '完整反推' | '动作优先' | '运镜优先' | '分镜优先'
export type AnalysisMode = VideoMode

export interface AnalysisOptions {
  detectDialogue: boolean
  generateCharacterPrompts: boolean
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  detectDialogue: false,
  generateCharacterPrompts: false,
}

export interface MediaSource {
  kind: 'link'
  sourceUrl: string
  platform: string
  title?: string
  author?: string
  coverUrl?: string
  watermarkStatus?: string
}

export interface MediaFile {
  path: string
  name: string
  size: number
  extension: string
  type: MediaType
  width?: number
  height?: number
  duration?: number
  source?: MediaSource
}

export type AnalysisStage = 'idle' | 'resolving' | 'downloading' | 'preparing' | 'opening' | 'uploading' | 'processing' | 'sending' | 'analyzing' | 'extracting' | 'completed' | 'error'

export interface AnalysisResult {
  kind: MediaType
  sections: Record<string, string>
  json: unknown | null
  rawResponse: string
  parseWarning?: string
}

export interface HistoryItem {
  id: string
  type: MediaType
  timestamp: number
  filename: string
  filepath: string
  mode: AnalysisMode
  options: AnalysisOptions
  result: AnalysisResult
  source?: MediaSource
}

export interface Settings {
  geminiUrl: string
  browserBehavior: 'show' | 'background' | 'minimize'
  defaultVideoMode: VideoMode
  saveHistory: boolean
  maxHistory: number
  debug: boolean
  autoCheckUpdates: boolean
  lastUpdateCheck?: string
}

export const DEFAULT_SETTINGS: Settings = {
  geminiUrl: 'https://gemini.google.com/app',
  browserBehavior: 'background',
  defaultVideoMode: '完整反推',
  saveHistory: true,
  maxHistory: 100,
  debug: false,
  autoCheckUpdates: true,
}
