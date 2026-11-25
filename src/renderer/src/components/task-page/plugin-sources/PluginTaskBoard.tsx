// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import type React from 'react'
import { useState } from 'react'
import { LoaderCircle, MoveRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  readJiraBoardIssueDragData,
  writeJiraBoardIssueDragData
} from '@/lib/work-items/jira/jira-board-drag-payload'
import type {
  PluginTaskBoardColumn,
  PluginTaskItem
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'
import { PluginStatusColorDot } from '@/components/plugins/status-color/PluginStatusColorDot'
import type { PluginTaskBoardSection } from './plugin-task-board-columns'
import { PluginTaskStatusPill } from './PluginTaskStatusPill'

export type PluginTaskBoardProps = {
  sections: readonly PluginTaskBoardSection[]
  selectedId: string | null
  /** Cards whose move is running; they cannot be dragged again until it ends. */
  pendingIds: ReadonlySet<string>
  /** False without the source's `action` command: the board is read-only. */
  canMove: boolean
  onOpen: (item: PluginTaskItem) => void
  onMove: (item: PluginTaskItem, column: PluginTaskBoardColumn) => void
  /** Whether a column may have more items than shown. */
  hasMore: (column: PluginTaskBoardColumn) => boolean
  loadingColumn: string | null
  onLoadMore: (column: PluginTaskBoardColumn) => void
}

function initials(name: string): string {
  const words = name.split(/[\s,._@-]+/).filter((word) => word !== '')
  return words.slice(0, 2).map((word) => word.slice(0, 1).toUpperCase()).join('') || '?'
}

/**
 * Columns side by side (horizontal scroll) with cards, in the look of the Jira board. Cards move
 * by drag and drop with the Jira board's drag payload (HTML5, Electron-safe), or by the card's
 * Move menu from the keyboard.
 */
export function PluginTaskBoard({
  sections,
  selectedId,
  pendingIds,
  canMove,
  onOpen,
  onMove,
  hasMore,
  loadingColumn,
  onLoadMore
}: PluginTaskBoardProps): React.JSX.Element {
  const t = useTranslate()
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const targets = sections.flatMap((section) => (section.column ? [section.column] : []))

  const dragStart = (item: PluginTaskItem, event: React.DragEvent<HTMLDivElement>): void => {
    if (!canMove || pendingIds.has(item.id)) {
      event.preventDefault()
      return
    }
    if (!writeJiraBoardIssueDragData(event.dataTransfer, { key: item.id })) {
      event.preventDefault()
      return
    }
    setDraggingId(item.id)
  }

  const dragOver = (section: PluginTaskBoardSection, event: React.DragEvent<HTMLElement>): void => {
    if (!section.column || !draggingId) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverKey(section.key)
  }

  const drop = (section: PluginTaskBoardSection, event: React.DragEvent<HTMLElement>): void => {
    const column = section.column
    if (!column) {
      return
    }
    event.preventDefault()
    setDragOverKey(null)
    const payload = readJiraBoardIssueDragData(event.dataTransfer)
    // Electron hides getData during a drag, so fall back to the card the drag started from.
    const id =
      payload.status === 'issue' ? payload.ref.key : payload.status === 'hidden' ? draggingId : null
    setDraggingId(null)
    const item = id === null ? undefined : sections.flatMap((s) => s.items).find((i) => i.id === id)
    if (!item || pendingIds.has(item.id) || section.items.some((i) => i.id === item.id)) {
      return
    }
    onMove(item, column)
  }

  return (
    <div className="flex min-h-full min-w-0 items-start gap-3 overflow-x-auto p-3 scrollbar-sleek">
      {sections.map((section) => (
        <section
          key={section.key}
          aria-label={section.label}
          onDragOver={(event) => dragOver(section, event)}
          onDragLeave={() => setDragOverKey((key) => (key === section.key ? null : key))}
          onDrop={(event) => drop(section, event)}
          className={cn(
            'w-72 shrink-0 rounded-md border border-border/50 bg-muted/20 transition-[border-color,box-shadow]',
            dragOverKey === section.key && 'border-ring/70 ring-1 ring-ring/70'
          )}
        >
          <div className="flex h-9 items-center justify-between gap-2 border-b border-border/50 px-3">
            {section.status ? (
              <PluginTaskStatusPill status={section.status} />
            ) : (
              <span className="text-xs text-muted-foreground">
                {t('overhedge.taskSources.board.noStatus', 'No status')}
              </span>
            )}
            <span className="text-2xs text-muted-foreground">{section.items.length}</span>
          </div>
          <div className="min-h-16 space-y-2 p-2">
            {section.items.length === 0 ? (
              <div className="flex h-12 items-center justify-center rounded-md border border-dashed border-border/50 text-2xs text-muted-foreground">
                {t('overhedge.taskSources.board.emptyColumn', 'No tasks')}
              </div>
            ) : null}
            {section.items.map((item) => (
              <PluginTaskBoardCard
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                dragging={item.id === draggingId}
                pending={pendingIds.has(item.id)}
                canMove={canMove}
                moveTargets={targets.filter((column) => column.value !== section.column?.value)}
                onOpen={onOpen}
                onMove={onMove}
                onDragStart={dragStart}
                onDragEnd={() => {
                  setDraggingId(null)
                  setDragOverKey(null)
                }}
              />
            ))}
            {section.column && hasMore(section.column) ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-xs"
                disabled={loadingColumn !== null}
                onClick={() => {
                  if (section.column) {
                    onLoadMore(section.column)
                  }
                }}
              >
                {loadingColumn === section.column.value ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : null}
                {t('overhedge.taskSources.loadMore', 'Load more')}
              </Button>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  )
}

function PluginTaskBoardCard({
  item,
  selected,
  dragging,
  pending,
  canMove,
  moveTargets,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd
}: {
  item: PluginTaskItem
  selected: boolean
  dragging: boolean
  pending: boolean
  canMove: boolean
  moveTargets: readonly PluginTaskBoardColumn[]
  onOpen: (item: PluginTaskItem) => void
  onMove: (item: PluginTaskItem, column: PluginTaskBoardColumn) => void
  onDragStart: (item: PluginTaskItem, event: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const draggable = canMove && !pending
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      aria-current={selected ? 'true' : undefined}
      aria-disabled={pending ? 'true' : undefined}
      onDragStart={(event) => onDragStart(item, event)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(item)
        }
      }}
      className={cn(
        'group/card cursor-pointer rounded-md border border-border/50 bg-background px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        draggable && 'cursor-grab active:cursor-grabbing',
        selected && 'bg-accent',
        dragging && 'opacity-50',
        pending && 'cursor-wait opacity-70'
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground">
            <span className="truncate">{item.id}</span>
            {item.priority ? (
              <span className="truncate font-sans text-3xs">{item.priority}</span>
            ) : null}
            {pending ? <LoaderCircle className="size-3 shrink-0 animate-spin" /> : null}
          </div>
          <h3 className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
            {item.title}
          </h3>
        </div>
        {canMove && moveTargets.length > 0 ? (
          <div className="flex shrink-0 items-center md:opacity-0 md:transition-opacity md:group-hover/card:opacity-100 md:group-focus-within/card:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={pending}
                  aria-label={t('overhedge.taskSources.board.move', 'Move {{value0}}', {
                    value0: item.title
                  })}
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoveRight className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {moveTargets.map((column) => (
                  <DropdownMenuItem
                    key={column.value}
                    onClick={(event) => {
                      event.stopPropagation()
                      onMove(item, column)
                    }}
                  >
                    <PluginStatusColorDot color={column.color} />
                    {column.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>
      {item.owner ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-3xs">
            {initials(item.owner)}
          </span>
          <span className="truncate">{item.owner}</span>
        </div>
      ) : null}
    </div>
  )
}
