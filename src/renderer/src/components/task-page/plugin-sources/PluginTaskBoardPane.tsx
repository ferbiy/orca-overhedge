// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import type React from 'react'
import { useMemo, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type {
  PluginTaskBoardColumn,
  PluginTaskItem
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'
import type { PluginTaskSourceTarget } from './plugin-task-source-client'
import { buildPluginTaskBoardSections } from './plugin-task-board-columns'
import { runPluginTaskBoardMove } from './plugin-task-board-move'
import type { PluginTaskListState } from './use-plugin-task-source-data'
import { PluginTaskBoard } from './PluginTaskBoard'

/** The board with its moves (optimistic, put back on failure) and per-column paging. */
export function PluginTaskBoardPane({
  target,
  list,
  canAct,
  selectedId,
  onOpen
}: {
  target: PluginTaskSourceTarget
  list: PluginTaskListState
  canAct: boolean
  selectedId: string | null
  onOpen: (item: PluginTaskItem) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set())
  const { board, items, updateItems } = list
  const sections = useMemo(
    () => (board ? buildPluginTaskBoardSections(items, board) : []),
    [items, board]
  )

  if (list.error) {
    return (
      <div className="space-y-2 p-3 text-sm">
        <p className="text-destructive">{list.error}</p>
        <Button variant="outline" size="sm" onClick={list.refresh}>
          {t('overhedge.taskSources.retry', 'Try again')}
        </Button>
      </div>
    )
  }
  if (!board) {
    return (
      <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        {t('overhedge.taskSources.loading', 'Loading tasks…')}
      </div>
    )
  }

  const move = (item: PluginTaskItem, column: PluginTaskBoardColumn): void => {
    setPendingIds((previous) => new Set(previous).add(item.id))
    void runPluginTaskBoardMove({
      target,
      item,
      column,
      moveActionId: board.moveActionId,
      updateItems
    }).then((outcome) => {
      setPendingIds((previous) => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
      if (!outcome.ok) {
        toast.error(
          t('overhedge.taskSources.board.moveFailed', 'Moving {{value0}} failed: {{value1}}', {
            value0: item.title,
            value1: outcome.error
          })
        )
      }
    })
  }

  return (
    <PluginTaskBoard
      sections={sections}
      selectedId={selectedId}
      pendingIds={pendingIds}
      canMove={canAct}
      onOpen={onOpen}
      onMove={move}
      hasMore={(column) => {
        const cursor = list.columnCursors[column.value]
        // Why: until a column was paged on its own, the shared list's next page may hold more of it.
        return cursor === undefined ? list.nextCursor !== null : cursor !== null
      }}
      loadingColumn={list.loadingColumn}
      onLoadMore={(column) => list.loadMoreColumn(column.value)}
    />
  )
}
