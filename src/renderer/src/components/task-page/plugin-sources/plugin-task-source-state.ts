import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { PluginTaskSourceOperation } from '../../../../../shared/plugins/tasks/plugin-task-source-commands'
import {
  ensurePluginPanelsLoaded,
  isLivePlugin,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'

/** Overhedge fork: which plugin task source the Tasks page shows, if any. */

export type ActivePluginTaskSource = {
  key: string
  pluginKey: string
  sourceId: string
  pluginName: string
  title: string
  /** Lucide name of the plugin's first panel, so the tab looks like its sidebar panel. */
  icon?: string
  operations: PluginTaskSourceOperation[]
}

const LAST_SOURCE_STORAGE_KEY = 'overhedge.tasks.pluginSource'

export function pluginTaskSourceKey(pluginKey: string, sourceId: string): string {
  return `${pluginKey}::${sourceId}`
}

export function collectActivePluginTaskSources(
  plugins: readonly PluginHostListEntry[]
): ActivePluginTaskSource[] {
  return plugins
    .filter((plugin) => isLivePlugin(plugin) || plugin.status === 'errored')
    .flatMap((plugin) =>
      (plugin.taskSources ?? []).map((source) => ({
        key: pluginTaskSourceKey(plugin.pluginKey, source.id),
        pluginKey: plugin.pluginKey,
        sourceId: source.id,
        pluginName: plugin.name,
        title: source.title,
        ...(plugin.panels[0]?.icon ? { icon: plugin.panels[0].icon } : {}),
        operations: source.operations
      }))
    )
}

function readRemembered(): string | null {
  try {
    return window.localStorage.getItem(LAST_SOURCE_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeRemembered(key: string | null): void {
  try {
    if (key) {
      window.localStorage.setItem(LAST_SOURCE_STORAGE_KEY, key)
    } else {
      window.localStorage.removeItem(LAST_SOURCE_STORAGE_KEY)
    }
  } catch {
    // Why: storage can be blocked; the choice then lasts only for this window.
  }
}

type PluginTaskSourceSelection = {
  /** Null shows the built-in providers. Starts from the last session's pick. */
  activeKey: string | null
  select: (key: string | null) => void
}

export const usePluginTaskSourceSelection = create<PluginTaskSourceSelection>()((set) => ({
  activeKey: readRemembered(),
  select: (key) => {
    writeRemembered(key)
    set({ activeKey: key })
  }
}))

export function usePluginTaskSources(): {
  sources: ActivePluginTaskSource[]
  ready: boolean
} {
  const plugins = usePluginPanelsStore((state) => state.plugins)
  const fetchStatus = usePluginPanelsStore((state) => state.fetchStatus)
  useEffect(() => {
    ensurePluginPanelsLoaded()
  }, [])
  const sources = useMemo(() => collectActivePluginTaskSources(plugins), [plugins])
  return { sources, ready: fetchStatus === 'ready' || fetchStatus === 'error' }
}
