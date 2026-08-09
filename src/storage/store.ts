import { load } from '@tauri-apps/plugin-store'
import type { HistoryItem, Settings } from '../types'
import { DEFAULT_SETTINGS } from '../types'

const isTauri = '__TAURI_INTERNALS__' in window

export async function loadSettings(): Promise<Settings> {
  if (!isTauri) return { ...DEFAULT_SETTINGS }
  const store = await load('video-reverse-prompt.json', { autoSave: true, defaults: {} })
  return { ...DEFAULT_SETTINGS, ...(await store.get<Partial<Settings>>('settings') ?? {}) }
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!isTauri) return
  const store = await load('video-reverse-prompt.json', { autoSave: true, defaults: {} })
  await store.set('settings', settings)
}

export async function loadHistory(): Promise<HistoryItem[]> {
  if (!isTauri) return []
  const store = await load('video-reverse-prompt.json', { autoSave: true, defaults: {} })
  return await store.get<HistoryItem[]>('history') ?? []
}

export async function saveHistory(history: HistoryItem[]): Promise<void> {
  if (!isTauri) return
  const store = await load('video-reverse-prompt.json', { autoSave: true, defaults: {} })
  await store.set('history', history)
}
