// Overhedge: plugin status colours (Tasks page `color`, components Badge `color`); see OVERHEDGE.md
// "Plugin status colours".
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/**
 * A colour a plugin may hand to Orca: `#rgb` or `#rrggbb` only (no names, alpha, functions or
 * spaces), so nothing but a plain hex value can reach a React `style` object.
 */
export const PLUGIN_HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isPluginHexColor(value: unknown): value is string {
  return typeof value === 'string' && PLUGIN_HEX_COLOR_PATTERN.test(value)
}

export const pluginHexColorSchema = lazyZodSchema(() =>
  z.string().regex(PLUGIN_HEX_COLOR_PATTERN, 'must be a #rgb or #rrggbb colour')
)

/** Status colours on the Tasks page: item `status.color` and option `color` are drawn. */
export const PLUGIN_TASK_SOURCE_STATUS_COLOR_FEATURE = 'status-color'
