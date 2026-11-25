// Overhedge: plugin status colours; see OVERHEDGE.md "Plugin status colours".
import type { CSSProperties } from 'react'
import {
  getLinearStateMarkerStyle,
  getLinearStatePillStyle
} from '@/components/task-page/linear/issues/linear-state-pill-style'
import { isPluginHexColor } from '../../../../../shared/plugins/tasks/plugin-status-color'

// Why: the colour comes from a plugin. It was checked when the answer was parsed; checking again
// here keeps anything but a plain hex value out of `style`, whoever calls these.

/** Linear's state pill (tinted background and border, text mixed toward the foreground). */
export function pluginStatusPillStyle(color: string | undefined): CSSProperties | undefined {
  return isPluginHexColor(color) ? getLinearStatePillStyle(color) : undefined
}

/** Linear's state dot, readable on light and dark backgrounds. */
export function pluginStatusDotStyle(color: string | undefined): CSSProperties | undefined {
  return isPluginHexColor(color) ? getLinearStateMarkerStyle(color) : undefined
}
