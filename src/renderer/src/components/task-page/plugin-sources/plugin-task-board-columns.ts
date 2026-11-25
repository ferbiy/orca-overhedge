// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import type {
  PluginTaskBoard,
  PluginTaskBoardColumn,
  PluginTaskItem
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'

export type PluginTaskBoardSection = {
  key: string
  /** The source's column; null for a lane of items whose status no column names (not a drop target). */
  column: PluginTaskBoardColumn | null
  label: string
  status: NonNullable<PluginTaskItem['status']> | null
  items: PluginTaskItem[]
}

function labelKey(label: string): string {
  return label.trim().toLowerCase()
}

/** The column an item sits in: its `status.value`, else a column with the same label. */
export function pluginTaskItemColumn(
  item: PluginTaskItem,
  columns: readonly PluginTaskBoardColumn[]
): PluginTaskBoardColumn | null {
  const status = item.status
  if (!status) {
    return null
  }
  if (status.value !== undefined) {
    return columns.find((column) => column.value === status.value) ?? null
  }
  const label = labelKey(status.label)
  return columns.find((column) => labelKey(column.label) === label) ?? null
}

/**
 * The board's lanes: every column in the source's order (empty ones stay as drop targets), then
 * a lane per status no column names, so no listed item goes missing from the board.
 */
export function buildPluginTaskBoardSections(
  items: readonly PluginTaskItem[],
  board: PluginTaskBoard
): PluginTaskBoardSection[] {
  const sections = board.columns.map((column): PluginTaskBoardSection => ({
    key: `column:${column.value}`,
    column,
    label: column.label,
    status: { label: column.label, tone: column.tone, color: column.color, value: column.value },
    items: []
  }))
  const byValue = new Map(sections.map((section) => [section.column?.value, section]))
  const extras = new Map<string, PluginTaskBoardSection>()
  for (const item of items) {
    const column = pluginTaskItemColumn(item, board.columns)
    const section = column ? byValue.get(column.value) : undefined
    if (section) {
      section.items.push(item)
      continue
    }
    const key = item.status ? `status:${labelKey(item.status.label)}` : 'status:'
    const extra = extras.get(key)
    if (extra) {
      extra.items.push(item)
    } else {
      extras.set(key, {
        key,
        column: null,
        label: item.status?.label ?? '',
        status: item.status ?? null,
        items: [item]
      })
    }
  }
  return [...sections, ...extras.values()]
}

/** The items with one moved into `column` (status from the column), as shown while the move runs. */
export function movePluginTaskItem(
  items: readonly PluginTaskItem[],
  itemId: string,
  column: PluginTaskBoardColumn
): PluginTaskItem[] {
  return items.map((item) =>
    item.id === itemId
      ? {
          ...item,
          status: {
            label: column.label,
            tone: column.tone,
            color: column.color,
            value: column.value
          }
        }
      : item
  )
}

/**
 * Puts a failed move back: the item gets its old status again, but only while it still shows
 * the move (a refresh in between already brought the source's own answer).
 */
export function revertPluginTaskItemMove(
  items: readonly PluginTaskItem[],
  previous: PluginTaskItem,
  column: PluginTaskBoardColumn
): PluginTaskItem[] {
  return items.map((item) =>
    item.id === previous.id && item.status?.value === column.value
      ? { ...item, status: previous.status }
      : item
  )
}

/** The item as the source answered after the move, in place of the shown one. */
export function replacePluginTaskItem(
  items: readonly PluginTaskItem[],
  next: PluginTaskItem
): PluginTaskItem[] {
  return items.map((item) => (item.id === next.id ? next : item))
}
