import type React from 'react'
import { ListTodo } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { resolvePluginIconGlyph } from '@/components/plugins/plugin-icon-glyphs'
import { usePluginTaskSourceSelection, usePluginTaskSources } from './plugin-task-source-state'

/** Overhedge fork: one Tasks source button per plugin task source, after the built-in ones. */
export function PluginTaskSourceButtons({
  activeKey
}: {
  activeKey: string | null
}): React.JSX.Element | null {
  const { sources } = usePluginTaskSources()
  const select = usePluginTaskSourceSelection((state) => state.select)
  if (sources.length === 0) {
    return null
  }
  return (
    <>
      {sources.map((source) => {
        const Icon = resolvePluginIconGlyph(source.icon, ListTodo)
        const active = source.key === activeKey
        return (
          <Tooltip key={source.key}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => select(source.key)}
                data-task-source={`plugin:${source.key}`}
                aria-label={source.title}
                aria-pressed={active}
                className={cn(
                  'group flex h-8 w-8 items-center justify-center rounded-md border transition',
                  active
                    ? 'border-foreground/40 bg-muted/70 text-foreground shadow-sm'
                    : 'border-border/40 bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                )}
              >
                <Icon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {source.title}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}
