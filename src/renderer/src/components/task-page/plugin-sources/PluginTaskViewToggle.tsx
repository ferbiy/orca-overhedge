// Overhedge: the Kanban board of a plugin task source; see OVERHEDGE.md "Plugin task board".
import type React from 'react'
import { LayoutGrid, List } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { PluginTaskViewMode } from './plugin-task-view-mode'

/** List / Board switch in the look of the Linear toolbar's view switch. */
export function PluginTaskViewToggle({
  mode,
  onChange
}: {
  mode: PluginTaskViewMode
  onChange: (mode: PluginTaskViewMode) => void
}): React.JSX.Element {
  const t = useTranslate()
  const options = [
    { id: 'list', label: t('overhedge.taskSources.view.list', 'List view'), Icon: List },
    { id: 'board', label: t('overhedge.taskSources.view.board', 'Board view'), Icon: LayoutGrid }
  ] as const
  return (
    <div
      role="group"
      className="flex items-center rounded-md border border-border/50 bg-background/70 p-0.5"
      aria-label={t('overhedge.taskSources.view.label', 'View')}
    >
      {options.map(({ id, label, Icon }) => (
        <Tooltip key={id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onChange(id)}
              aria-label={label}
              aria-pressed={mode === id}
              className={cn(
                'inline-flex size-6 items-center justify-center rounded text-muted-foreground transition hover:text-foreground',
                mode === id && 'bg-accent text-accent-foreground shadow-xs'
              )}
            >
              <Icon className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {label}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
