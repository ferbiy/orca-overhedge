import type { PluginTaskFilter } from '../../../../../shared/plugins/tasks/plugin-task-source-schema'

/** The filter values to send: only picks the source still offers, so the request and the pickers
 *  agree. A filter without a pick is left to the source's own default. */
export function effectivePluginTaskFilters(
  offered: readonly PluginTaskFilter[],
  picked: Readonly<Record<string, string>>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const filter of offered) {
    const value = picked[filter.id]
    if (value !== undefined && filter.options.some((option) => option.value === value)) {
      result[filter.id] = value
    }
  }
  return result
}
