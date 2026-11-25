import {
  pluginTaskSourceCommandId,
  type PluginTaskSourceOperation
} from '../../../../../shared/plugins/tasks/plugin-task-source-commands'
import {
  parsePluginTaskSourceResult,
  type PluginTaskActionParams,
  type PluginTaskListParams,
  type PluginTaskSourceResult
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'

/**
 * Overhedge fork: calls a plugin task source through the plugin's own worker command. The worker
 * runs in this desktop's main process, so this works the same when projects live on a paired
 * Orca server: the plugin reaches its tracker from here, and starting work goes through its
 * `workspace.create`, which takes the project's host.
 */

export type PluginTaskSourceTarget = { pluginKey: string; sourceId: string }

type ParamsFor<O extends PluginTaskSourceOperation> = O extends 'list'
  ? PluginTaskListParams
  : O extends 'get'
    ? { itemId: string }
    : PluginTaskActionParams

export type PluginCommandInvoker = (args: {
  pluginKey: string
  commandId: string
  args?: unknown
}) => Promise<unknown>

const defaultInvoker: PluginCommandInvoker = (args) => window.api.plugins.invokeCommand(args)

export class PluginTaskSourceError extends Error {}

export async function invokePluginTaskSource<O extends PluginTaskSourceOperation>(
  target: PluginTaskSourceTarget,
  operation: O,
  params: ParamsFor<O>,
  invoke: PluginCommandInvoker = defaultInvoker
): Promise<PluginTaskSourceResult<O>> {
  let raw: unknown
  try {
    raw = await invoke({
      pluginKey: target.pluginKey,
      commandId: pluginTaskSourceCommandId(target.sourceId, operation),
      args: params
    })
  } catch (error) {
    throw new PluginTaskSourceError(cleanIpcError(error))
  }
  const parsed = parsePluginTaskSourceResult(operation, raw)
  if (!parsed.ok) {
    throw new PluginTaskSourceError(
      `The plugin sent an invalid ${operation} result (${parsed.error})`
    )
  }
  return parsed.value
}

/** Electron prefixes IPC rejections with the channel; the plugin's own message is the useful part. */
function cleanIpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
