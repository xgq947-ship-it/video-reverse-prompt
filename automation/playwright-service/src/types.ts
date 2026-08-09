import type { ImportedVideoFile } from './media/downloader.js'
import type { GeneratorConfig } from './generation/providers.js'

export type BrowserBehavior = 'show' | 'background' | 'minimize'
export type MediaType = 'video'

export interface AutomationRequest {
  command: 'open' | 'check-login' | 'compatibility' | 'analyze' | 'refine' | 'resolve-video' | 'generate-production' | 'generator-status'
  geminiUrl?: string
  filePath?: string
  mediaType?: MediaType
  prompt?: string
  mediaInput?: string
  outputDir?: string
  reverseResponse?: string
  duration?: number
  filename?: string
  generator?: GeneratorConfig
  browserBehavior?: BrowserBehavior
  debug?: boolean
}

export interface AutomationResult {
  ok: boolean
  loggedIn?: boolean
  checks?: Record<string, boolean>
  rawResponse?: string
  importedVideo?: ImportedVideoFile
  generatorStatus?: Record<string, string | boolean>
  error?: { code: string; message: string; detail?: string }
}

export interface WireMessage {
  type: 'progress' | 'result' | 'log'
  stage?: string
  message?: string
  payload?: AutomationResult
}
