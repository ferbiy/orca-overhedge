// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import type {
  PluginTaskBoardColumn,
  PluginTaskItem
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'
import {
  invokePluginTaskSource,
  type PluginCommandInvoker,
  type PluginTaskSourceTarget
} from './plugin-task-source-client'
import {
  movePluginTaskItem,
  replacePluginTaskItem,
  revertPluginTaskItemMove
} from './plugin-task-board-columns'

export type PluginTaskItemsUpdate = (
  update: (items: readonly PluginTaskItem[]) => PluginTaskItem[]
) => void

export type PluginTaskBoardMoveOutcome =
  | { ok: true; message?: string }
  | { ok: false; error: string }

/**
 * A card dropped on a column: shown there at once, then the source's move action runs (the same
 * `action` command and status path as the detail pane's Status menu). Its answered item replaces
 * the card; a failure puts the card back where it was.
 */
export async function runPluginTaskBoardMove(args: {
  target: PluginTaskSourceTarget
  item: PluginTaskItem
  column: PluginTaskBoardColumn
  moveActionId: string
  updateItems: PluginTaskItemsUpdate
  invoke?: PluginCommandInvoker
}): Promise<PluginTaskBoardMoveOutcome> {
  const { target, item, column, moveActionId, updateItems, invoke } = args
  updateItems((items) => movePluginTaskItem(items, item.id, column))
  try {
    const result = await invokePluginTaskSource(
      target,
      'action',
      { itemId: item.id, actionId: moveActionId, value: column.value },
      invoke
    )
    const answered = result.detail?.item
    if (answered && answered.id === item.id) {
      updateItems((items) => replacePluginTaskItem(items, answered))
    }
    return result.message ? { ok: true, message: result.message } : { ok: true }
  } catch (error) {
    updateItems((items) => revertPluginTaskItemMove(items, item, column))
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
