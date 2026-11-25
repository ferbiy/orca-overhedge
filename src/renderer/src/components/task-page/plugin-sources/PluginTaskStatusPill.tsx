import type React from 'react'
import { cn } from '@/lib/class-names'
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
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE_CLASSES[status.tone]
      )}
    >
      {status.label}
    </span>
  )
}
