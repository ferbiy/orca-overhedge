import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import { PluginTaskDetailPane } from './PluginTaskDetailPane'
import { PluginTaskSourceButtons } from './PluginTaskSourceButtons'
import { PluginTaskStatusPill } from './PluginTaskStatusPill'
import {
  type ActivePluginTaskSource,
  usePluginTaskSourceSelection
} from './plugin-task-source-state'
import { usePluginTaskList } from './use-plugin-task-source-data'

const SEARCH_DEBOUNCE_MS = 300

/** Overhedge fork: the Tasks page for one plugin task source. */
export function PluginTaskSourcePage({
  source
}: {
  source: ActivePluginTaskSource
}): React.JSX.Element {
  const t = useTranslate()
  const closeTaskPage = useAppStore((state) => state.closeTaskPage)
  const select = usePluginTaskSourceSelection((state) => state.select)
  const target = useMemo(
    () => ({ pluginKey: source.pluginKey, sourceId: source.sourceId }),
    [source.pluginKey, source.sourceId]
  )
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const list = usePluginTaskList(target, query, picked)
  const filters = list.selectedFilters

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const selected = list.items.find((item) => item.id === selectedId) ?? null

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3 bg-background px-4 py-3">
      <div className="flex flex-none flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-full"
              onClick={closeTaskPage}
              aria-label={t('overhedge.taskSources.close', 'Close tasks')}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('overhedge.taskSources.close', 'Close tasks')}
          </TooltipContent>
        </Tooltip>
        <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => select(null)}
              aria-label={t('overhedge.taskSources.builtIn', 'GitHub, GitLab, Linear and Jira')}
            >
              <ArrowLeft className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('overhedge.taskSources.builtIn', 'GitHub, GitLab, Linear and Jira')}
          </TooltipContent>
        </Tooltip>
        <PluginTaskSourceButtons activeKey={source.key} />
        <span className="ml-1 truncate text-sm font-medium text-foreground">{source.title}</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('overhedge.taskSources.search', 'Search tasks')}
              density="compact"
              inset="leadingIcon"
              className="w-[240px]"
            />
          </div>
          {list.filters.map((filter) => (
            <Select
              key={filter.id}
              value={filters[filter.id] ?? filter.defaultValue ?? filter.options[0]?.value}
              onValueChange={(value) =>
                setPicked((previous) => ({ ...previous, [filter.id]: value }))
              }
            >
              <SelectTrigger size="xs" className="w-[160px]" aria-label={filter.label}>
                <SelectValue placeholder={filter.label} />
              </SelectTrigger>
              <SelectContent>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.count === undefined
                      ? option.label
                      : `${option.label} (${option.count})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}
          <Button
            variant="outline"
            size="icon-sm"
            onClick={list.refresh}
            aria-label={t('overhedge.taskSources.refresh', 'Refresh')}
          >
            <RefreshCw className={cn('size-3.5', list.loading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      {list.notice ? (
        <div className="flex-none rounded-md border border-border/50 bg-muted/35 px-3 py-1.5 text-xs text-muted-foreground">
          {list.notice}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-h-0 w-[min(46%,560px)] flex-none flex-col overflow-y-auto scrollbar-sleek rounded-md border border-border/50">
          {list.error ? (
            <div className="space-y-2 p-3 text-sm">
              <p className="text-destructive">{list.error}</p>
              <Button variant="outline" size="sm" onClick={list.refresh}>
                {t('overhedge.taskSources.retry', 'Try again')}
              </Button>
            </div>
          ) : list.loading && list.items.length === 0 ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              {t('overhedge.taskSources.loading', 'Loading tasks…')}
            </div>
          ) : list.items.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t('overhedge.taskSources.empty', 'No tasks match.')}
            </p>
          ) : (
            <ul className="divide-y divide-border/40">
              {list.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    aria-current={item.id === selectedId}
                    className={cn(
                      'flex w-full flex-col gap-1 px-3 py-2 text-left transition hover:bg-muted/40',
                      item.id === selectedId && 'bg-muted/60'
                    )}
                  >
                    <span className="truncate text-sm text-foreground">{item.title}</span>
                    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                      <PluginTaskStatusPill status={item.status} />
                      {item.priority ? <span>{item.priority}</span> : null}
                      {item.owner ? <span className="truncate">{item.owner}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
              {list.nextCursor ? (
                <li className="p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    disabled={list.loadingMore}
                    onClick={list.loadMore}
                  >
                    {list.loadingMore ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                    {t('overhedge.taskSources.loadMore', 'Load more')}
                  </Button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
        <div className="min-h-0 min-w-0 flex-1 rounded-md border border-border/50">
          {selected ? (
            <PluginTaskDetailPane
              key={selected.id}
              target={target}
              item={selected}
              canGet={source.operations.includes('get')}
              canAct={source.operations.includes('action')}
              onChanged={list.refresh}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">
              {t('overhedge.taskSources.pick', 'Pick a task to see its details.')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
