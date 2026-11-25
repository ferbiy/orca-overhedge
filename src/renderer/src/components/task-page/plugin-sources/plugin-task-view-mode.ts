// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import { create } from 'zustand'

export type PluginTaskViewMode = 'list' | 'board'

const VIEW_MODE_STORAGE_KEY = 'overhedge.tasks.pluginSource.view'
/** Sources remembered at most; a long tail of removed plugins cannot grow the key. */
const MAX_REMEMBERED = 20

type Remembered = Record<string, PluginTaskViewMode>

export function parseRememberedViewModes(raw: string | null): Remembered {
  if (!raw) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  const result: Remembered = {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'board' || value === 'list') {
        result[key] = value
      }
    }
  }
  return result
}

function readRemembered(): Remembered {
  try {
    return parseRememberedViewModes(window.localStorage.getItem(VIEW_MODE_STORAGE_KEY))
  } catch {
    return {}
  }
}

function writeRemembered(modes: Remembered): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, JSON.stringify(modes))
  } catch {
    // Why: storage can be blocked; the choice then lasts only for this window.
  }
}

/** The modes with `key` set last, so the oldest choices are the ones dropped at the cap. */
export function rememberViewMode(
  modes: Readonly<Remembered>,
  key: string,
  mode: PluginTaskViewMode
): Remembered {
  const entries: [string, PluginTaskViewMode][] = Object.entries(modes).filter(
    ([name]) => name !== key
  )
  entries.push([key, mode])
  return Object.fromEntries(entries.slice(-MAX_REMEMBERED))
}

type PluginTaskViewModes = {
  /** By source key; a source without an entry shows its list. */
  modes: Remembered
  setMode: (key: string, mode: PluginTaskViewMode) => void
}

export const usePluginTaskViewModes = create<PluginTaskViewModes>()((set, get) => ({
  modes: readRemembered(),
  setMode: (key, mode) => {
    const modes = rememberViewMode(get().modes, key, mode)
    writeRemembered(modes)
    set({ modes })
  }
}))
