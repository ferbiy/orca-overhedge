/**
 * Overhedge fork: plugin task sources on the Tasks page, carried by plugin commands.
 *
 * A plugin offers a task source by declaring worker commands named
 * `taskSource.<sourceId>.list` (required; its title is the tab's title), `.get` and `.action`
 * (optional) and registering them with `orca.commands.register`. The manifest stays valid on
 * stock Orca, where `contributes.taskSources` is still reserved and must be empty, and the
 * existing command channel (IPC, worker request, timeout, cancel) carries the calls, so main and
 * the worker protocol stay untouched. The data shapes follow upstream PR #26282 so a plugin can
 * move to a real `taskSources` point by changing only how it registers.
 */

export const PLUGIN_TASK_SOURCE_COMMAND_PREFIX = 'taskSource'

export const PLUGIN_TASK_SOURCE_OPERATIONS = ['list', 'get', 'action'] as const

export type PluginTaskSourceOperation = (typeof PLUGIN_TASK_SOURCE_OPERATIONS)[number]

/** One task source a plugin offers, as main lists it for the renderer. */
export type PluginHostTaskSource = {
  id: string
  title: string
  operations: PluginTaskSourceOperation[]
}

const SOURCE_ID_RE = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/

export function pluginTaskSourceCommandId(
  sourceId: string,
  operation: PluginTaskSourceOperation
): string {
  return `${PLUGIN_TASK_SOURCE_COMMAND_PREFIX}.${sourceId}.${operation}`
}

export function parsePluginTaskSourceCommandId(
  commandId: string
): { sourceId: string; operation: PluginTaskSourceOperation } | null {
  const parts = commandId.split('.')
  if (parts.length !== 3 || parts[0] !== PLUGIN_TASK_SOURCE_COMMAND_PREFIX) {
    return null
  }
  const [, sourceId, operation] = parts
  if (!SOURCE_ID_RE.test(sourceId)) {
    return null
  }
  return (PLUGIN_TASK_SOURCE_OPERATIONS as readonly string[]).includes(operation)
    ? { sourceId, operation: operation as PluginTaskSourceOperation }
    : null
}

export function isPluginTaskSourceCommandId(commandId: string): boolean {
  return parsePluginTaskSourceCommandId(commandId) !== null
}

/** Sources declared by a plugin's commands; a source needs a `list` command. */
export function collectPluginTaskSources(
  commands: readonly { id: string; title: string }[]
): PluginHostTaskSource[] {
  const byId = new Map<string, { title?: string; operations: Set<PluginTaskSourceOperation> }>()
  for (const command of commands) {
    const parsed = parsePluginTaskSourceCommandId(command.id)
    if (!parsed) {
      continue
    }
    const entry = byId.get(parsed.sourceId) ?? { operations: new Set() }
    entry.operations.add(parsed.operation)
    if (parsed.operation === 'list') {
      entry.title = command.title
    }
    byId.set(parsed.sourceId, entry)
  }
  return [...byId].flatMap(([id, entry]) =>
    entry.title === undefined
      ? []
      : [
          {
            id,
            title: entry.title,
            operations: PLUGIN_TASK_SOURCE_OPERATIONS.filter((op) => entry.operations.has(op))
          }
        ]
  )
}

/** The list-entry fields for a plugin's commands: task-source commands become `taskSources` and
 *  leave `commands`, so the palette, shortcuts and the plugin page never offer them. */
export function splitPluginTaskSourceCommands<T extends { id: string; title: string }>(
  commands: readonly T[]
): { commands: T[]; taskSources?: PluginHostTaskSource[] } {
  const taskSources = collectPluginTaskSources(commands)
  const rest = commands.filter((command) => !isPluginTaskSourceCommandId(command.id))
  return taskSources.length > 0 ? { commands: rest, taskSources } : { commands: rest }
}

/** A projected plugin list entry with its task-source commands moved to `taskSources`. */
export function withPluginTaskSources<T extends { commands: { id: string; title: string }[] }>(
  entry: T
): T & { taskSources?: PluginHostTaskSource[] } {
  const split = splitPluginTaskSourceCommands(entry.commands)
  return split.taskSources ? { ...entry, ...split } : entry
}
