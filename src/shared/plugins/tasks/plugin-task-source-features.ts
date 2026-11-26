// Overhedge: what the fork's Tasks page draws beyond the base plugin task source contract; see
// OVERHEDGE.md "Plugin status colours" and "Plugin task board".
import { PLUGIN_TASK_SOURCE_STATUS_COLOR_FEATURE } from './plugin-status-color'

/**
 * A Kanban board: the page shows a List / Board switch when a `list` answer carries `board`
 * (ordered columns and the action a drop runs), and sends `column` to load more of one column.
 */
export const PLUGIN_TASK_SOURCE_BOARD_FEATURE = 'board'

/** Sent as `features` with every command (list, get, action), so a source can feature-detect. */
export const PLUGIN_TASK_SOURCE_FEATURES: readonly string[] = [
  PLUGIN_TASK_SOURCE_STATUS_COLOR_FEATURE,
  PLUGIN_TASK_SOURCE_BOARD_FEATURE
]
