import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PluginTaskDetail,
  PluginTaskFilter,
  PluginTaskItem
} from '../../../../../shared/plugins/tasks/plugin-task-source-schema'
import { invokePluginTaskSource, type PluginTaskSourceTarget } from './plugin-task-source-client'
import { effectivePluginTaskFilters } from './plugin-task-filter-selection'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

/** Overhedge fork: list and detail state for one plugin task source. */

const AUTO_REFRESH_MS = 120_000

/** Filters travel as a JSON key so an equal object does not refetch; this reads it back. */
function parseFiltersKey(key: string): Record<string, string> {
  const parsed: unknown = JSON.parse(key)
  const result: Record<string, string> = {}
  if (parsed && typeof parsed === 'object') {
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        result[id] = value
      }
    }
  }
  return result
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type PluginTaskListState = {
  items: PluginTaskItem[]
  filters: PluginTaskFilter[]
  /** The values sent with the last request, by filter id. */
  selectedFilters: Record<string, string>
  notice: string | null
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  refresh: () => void
  loadMore: () => void
}

export function usePluginTaskList(
  target: PluginTaskSourceTarget,
  query: string,
  picked: Readonly<Record<string, string>>
): PluginTaskListState {
  const [items, setItems] = useState<PluginTaskItem[]>([])
  const [offered, setOffered] = useState<PluginTaskFilter[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  // Why: a slow answer for an older query must not replace a newer one.
  const generation = useRef(0)
  // Why from the last answer: the source names its filters, so the first request sends none.
  const selectedFilters = useMemo(
    () => effectivePluginTaskFilters(offered, picked),
    [offered, picked]
  )
  const filtersKey = JSON.stringify(selectedFilters)

  const { pluginKey, sourceId } = target

  // Why revision in the deps: Refresh and the timer bump it to ask again with the same query.
  useEffect(() => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    invokePluginTaskSource({ pluginKey, sourceId }, 'list', {
      query,
      filters: parseFiltersKey(filtersKey)
    })
      .then((result) => {
        if (current !== generation.current) {
          return
        }
        setItems(result.items)
        setOffered(result.filters ?? [])
        setNotice(result.notice ?? null)
        setNextCursor(result.nextCursor ?? null)
      })
      .catch((caught: unknown) => {
        if (current === generation.current) {
          setError(errorText(caught))
        }
      })
      .finally(() => {
        if (current === generation.current) {
          setLoading(false)
        }
      })
  }, [pluginKey, sourceId, query, filtersKey, revision])

  useEffect(
    () =>
      installWindowVisibilityInterval({
        run: () => setRevision((value) => value + 1),
        intervalMs: AUTO_REFRESH_MS,
        slowWhileUnfocused: true
      }),
    []
  )

  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) {
      return
    }
    const current = generation.current
    setLoadingMore(true)
    invokePluginTaskSource({ pluginKey, sourceId }, 'list', {
      query,
      filters: parseFiltersKey(filtersKey),
      cursor: nextCursor
    })
      .then((result) => {
        if (current !== generation.current) {
          return
        }
        setItems((previous) => {
          const seen = new Set(previous.map((item) => item.id))
          return [...previous, ...result.items.filter((item) => !seen.has(item.id))]
        })
        setNextCursor(result.nextCursor ?? null)
      })
      .catch((caught: unknown) => {
        if (current === generation.current) {
          setError(errorText(caught))
        }
      })
      .finally(() => setLoadingMore(false))
  }, [pluginKey, sourceId, query, filtersKey, nextCursor, loadingMore])

  return {
    items,
    filters: offered,
    selectedFilters,
    notice,
    nextCursor,
    loading,
    loadingMore,
    error,
    refresh,
    loadMore
  }
}

export type PluginTaskDetailState = {
  detail: PluginTaskDetail | null
  loading: boolean
  error: string | null
  setDetail: (detail: PluginTaskDetail) => void
  reload: () => void
}

export function usePluginTaskDetail(
  target: PluginTaskSourceTarget,
  itemId: string | null,
  canGet: boolean
): PluginTaskDetailState {
  const [detail, setDetail] = useState<PluginTaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const { pluginKey, sourceId } = target

  // Why revision in the deps: reload() bumps it to fetch the same item again.
  useEffect(() => {
    const current = ++generation.current
    setDetail(null)
    setError(null)
    if (!itemId || !canGet) {
      setLoading(false)
      return
    }
    setLoading(true)
    invokePluginTaskSource({ pluginKey, sourceId }, 'get', { itemId })
      .then((result) => {
        if (current === generation.current) {
          setDetail(result)
        }
      })
      .catch((caught: unknown) => {
        if (current === generation.current) {
          setError(errorText(caught))
        }
      })
      .finally(() => {
        if (current === generation.current) {
          setLoading(false)
        }
      })
  }, [pluginKey, sourceId, itemId, canGet, revision])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { detail, loading, error, setDetail, reload }
}
