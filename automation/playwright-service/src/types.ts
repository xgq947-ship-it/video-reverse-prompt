import type { ImportedVideoFile } from './media/downloader.js'

export type BrowserBehavior = 'show' | 'background' | 'minimize'
export type MediaType = 'video'

export interface AutomationRequest {
  command: 'open' | 'check-login' | 'compatibility' | 'analyze' | 'refine' | 'resolve-video'
  geminiUrl?: string
  filePath?: string
  mediaType?: MediaType
  prompt?: string
  mediaInput?: string
  outputDir?: string
  browserBehavior?: BrowserBehavior
  debug?: boolean
}

export interface AutomationResult {
  ok: boolean
  loggedIn?: boolean
  checks?: Record<string, boolean>
  rawResponse?: string
  importedVideo?: ImportedVideoFile
  error?: { code: string; message: string; detail?: string }
}

export interface WireMessage {
  type: 'progress' | 'result' | 'log'
  stage?: string
  message?: string
  payload?: AutomationResult
}
