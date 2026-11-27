import type React from 'react'
import { useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useAppStore } from '@/store'
import type { TaskPageData } from '@/store/slices/ui/ui-slice-contract-core'
import { PluginTaskSourcePage } from './PluginTaskSourcePage'
import { usePluginTaskSourceSelection, usePluginTaskSources } from './plugin-task-source-state'

/** Opening a built-in item (Cmd-J, a workspace card) must show it even if a plugin tab was last. */
export function opensBuiltinTaskItem(data: TaskPageData): boolean {
  return Boolean(
    data.openGitHubWorkItem || data.openGitLabWorkItem || data.openLinearIssue || data.openJiraIssue
  )
}

/**
 * Overhedge fork: the Tasks page shows a plugin task source in place of the built-in pipeline,
 * so none of the built-in provider fetches mount while a plugin tab is open.
 */
export function withPluginTaskSources(Builtin: React.ComponentType): React.ComponentType {
  function TaskPageWithPluginSources(): React.JSX.Element {
    const { sources, ready } = usePluginTaskSources()
    const activeKey = usePluginTaskSourceSelection((state) => state.activeKey)
    const select = usePluginTaskSourceSelection((state) => state.select)
    const builtinItem = useAppStore((state) => opensBuiltinTaskItem(state.taskPageData))

    useEffect(() => {
      if (builtinItem) {
        select(null)
      }
    }, [builtinItem, select])

    if (activeKey && !builtinItem) {
      const source = sources.find((candidate) => candidate.key === activeKey)
      if (source) {
        return <PluginTaskSourcePage key={source.key} source={source} />
      }
      if (!ready) {
        return (
          <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        )
      }
    }
    return <Builtin />
  }
  return TaskPageWithPluginSources
}
