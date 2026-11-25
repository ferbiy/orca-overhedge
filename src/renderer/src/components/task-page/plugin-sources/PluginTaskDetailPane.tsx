import type React from 'react'
import { useState } from 'react'
import { ChevronDown, ExternalLink, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import type {
  PluginTaskAction,
  PluginTaskItem
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'
import { invokePluginTaskSource, type PluginTaskSourceTarget } from './plugin-task-source-client'
import { PluginTaskStatusPill } from './PluginTaskStatusPill'
import { PluginStatusColorDot } from '@/components/plugins/status-color/PluginStatusColorDot'
import { usePluginTaskDetail } from './use-plugin-task-source-data'

/** Overhedge fork: the selected plugin task, its body and the actions its source offers. */
export function PluginTaskDetailPane({
  target,
  item,
  canGet,
  canAct,
  onChanged
}: {
  target: PluginTaskSourceTarget
  item: PluginTaskItem
  canGet: boolean
  canAct: boolean
  /** An action ran, so the list may be stale. */
  onChanged: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { detail, loading, error, setDetail, reload } = usePluginTaskDetail(target, item.id, canGet)
  const [running, setRunning] = useState<string | null>(null)
  // Why: the row paints at once; the fetched detail may carry a fresher item.
  const shown = detail?.item ?? item
  const actions = canAct ? (detail?.actions ?? []) : []

  const run = (action: PluginTaskAction, value?: string): void => {
    setRunning(action.id)
    invokePluginTaskSource(target, 'action', {
      itemId: item.id,
      actionId: action.id,
      ...(value !== undefined ? { value } : {})
    })
      .then((result) => {
        if (result.message) {
          toast.success(result.message)
        }
        if (result.detail) {
          setDetail(result.detail)
        } else {
          reload()
        }
        onChanged()
      })
      .catch((caught: unknown) => {
        toast.error(
          t('overhedge.taskSources.actionFailed', '{{value0}} failed: {{value1}}', {
            value0: action.label,
            value1: caught instanceof Error ? caught.message : String(caught)
          })
        )
      })
      .finally(() => setRunning(null))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-start gap-3 border-b border-border/50 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-[15px] font-semibold leading-snug text-foreground">{shown.title}</h2>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <PluginTaskStatusPill status={shown.status} />
            {shown.priority ? <span>{shown.priority}</span> : null}
            {shown.owner ? <span className="truncate">{shown.owner}</span> : null}
            {shown.labels?.map((label) => (
              <span key={label} className="rounded border border-border/50 px-1.5 py-0.5">
                {label}
              </span>
            ))}
          </div>
        </div>
        {shown.url ? (
          <Button
            variant="outline"
            size="sm"
            onClick={(event) => openAppHttpLink(shown.url ?? '', { event })}
          >
            <ExternalLink className="size-3.5" />
            {t('overhedge.taskSources.openInBrowser', 'Open in browser')}
          </Button>
        ) : null}
      </div>
      {actions.length > 0 ? (
        <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border/50 px-4 py-2">
          {actions.map((action) => (
            <PluginTaskActionControl
              key={action.id}
              action={action}
              busy={running === action.id}
              disabled={running !== null}
              onRun={(value) => run(action, value)}
            />
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-4 py-3">
        {loading ? (
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : detail?.bodyMarkdown ? (
          <CommentMarkdown
            content={detail.bodyMarkdown}
            variant="document"
            className="text-[14px] leading-relaxed"
          />
        ) : shown.summary ? (
          <p className="text-sm text-muted-foreground">{shown.summary}</p>
        ) : null}
      </div>
    </div>
  )
}

function PluginTaskActionControl({
  action,
  busy,
  disabled,
  onRun
}: {
  action: PluginTaskAction
  busy: boolean
  disabled: boolean
  onRun: (value?: string) => void
}): React.JSX.Element {
  const variant = action.primary ? 'default' : 'outline'
  const icon = busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null
  if (!action.options) {
    return (
      <Button variant={variant} size="sm" disabled={disabled} onClick={() => onRun()}>
        {icon}
        {action.label}
      </Button>
    )
  }
  const current = action.options.find((option) => option.value === action.value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size="sm" disabled={disabled}>
          {icon}
          {current ? `${action.label}: ` : action.label}
          {current ? <PluginStatusColorDot color={current.color} /> : null}
          {current ? current.label : null}
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {action.options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            disabled={option.value === action.value}
            onSelect={() => onRun(option.value)}
          >
            <PluginStatusColorDot color={option.color} />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
