import type React from 'react'
import { cn } from '@/lib/class-names'
import { PluginStatusColorDot } from '@/components/plugins/status-color/PluginStatusColorDot'
import { pluginStatusPillStyle } from '@/components/plugins/status-color/plugin-status-color-style'
import type {
  PluginTaskItem,
  PluginTaskStatusTone
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'

const TONE_CLASSES: Record<PluginTaskStatusTone, string> = {
  open: 'border-border/50 bg-muted/40 text-muted-foreground',
  active: 'border-status-warning-border bg-status-warning-background text-status-warning',
  blocked: 'border-destructive/30 bg-destructive/10 text-destructive',
  review: 'border-foreground/30 bg-accent text-foreground',
  done: 'border-status-success-border bg-status-success-background text-status-success',
  closed: 'border-border/40 bg-transparent text-muted-foreground'
}

export function PluginTaskStatusPill({
  status
}: {
  status: PluginTaskItem['status']
}): React.JSX.Element | null {
  if (!status) {
    return null
  }
  // Why: a source's own colour (e.g. ClickUp's) wins over the tone, drawn like Linear's state pill.
  const colorStyle = pluginStatusPillStyle(status.color)
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        colorStyle ? undefined : TONE_CLASSES[status.tone]
      )}
      style={colorStyle}
    >
      <PluginStatusColorDot color={status.color} />
      {status.label}
    </span>
  )
}
