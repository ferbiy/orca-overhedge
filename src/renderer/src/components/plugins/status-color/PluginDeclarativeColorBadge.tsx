// Overhedge: components panel Badge `color`; see OVERHEDGE.md "Plugin status colours".
import type React from 'react'
import { Badge } from '@/components/ui/badge'
import type { PluginDeclarativeTone } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { PluginDeclarativeBadge } from '../declarative/PluginDeclarativeDisplay'
import { PluginStatusColorDot } from './PluginStatusColorDot'
import { pluginStatusPillStyle } from './plugin-status-color-style'

/** A Badge in the plugin's own colour (tinted, with a dot); without a valid one, the tone's Badge. */
export function PluginDeclarativeColorBadge({
  tone,
  color,
  children
}: {
  tone: PluginDeclarativeTone | undefined
  color: string | undefined
  children: React.ReactNode
}): React.JSX.Element {
  const style = pluginStatusPillStyle(color)
  if (!style) {
    return <PluginDeclarativeBadge tone={tone}>{children}</PluginDeclarativeBadge>
  }
  return (
    <Badge variant="outline" style={style}>
      <PluginStatusColorDot color={color} className="size-1.5" />
      {children}
    </Badge>
  )
}
