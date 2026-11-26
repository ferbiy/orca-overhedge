// Overhedge: plugin status colours; see OVERHEDGE.md "Plugin status colours".
import type React from 'react'
import { cn } from '@/lib/class-names'
import { pluginStatusDotStyle } from './plugin-status-color-style'

/** A small round swatch of a plugin's status colour; nothing when the colour is not a hex value. */
export function PluginStatusColorDot({
  color,
  className
}: {
  color: string | undefined
  className?: string
}): React.JSX.Element | null {
  const style = pluginStatusDotStyle(color)
  if (!style) {
    return null
  }
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', className)}
      style={style}
    />
  )
}
