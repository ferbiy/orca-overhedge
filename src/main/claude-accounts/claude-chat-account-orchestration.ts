// Overhedge: orchestration lookups for per-chat Claude account pins: which chats a coordinator
// dispatched, and which coordinator dispatched a worker. Chat-UI chats are keyed by Orca session id
// (their /clear root), terminal chats by `terminal:<pane>`.
import { canonicalClaudeChatId } from './claude-chat-account-pins'

type SqlDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] } }
export type OrchestrationDbLike = { db: SqlDb } | null

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** The orchestration database when `value` exposes a prepared-statement handle; else null. */
export function orchestrationDbOf(value: unknown): OrchestrationDbLike {
  if (!isObject(value) || !isObject(value.db)) {
    return null
  }
  const db = value.db
  const prepare = db.prepare
  if (typeof prepare !== 'function') {
    return null
  }
  return {
    db: {
      prepare: (sql) => {
        const statement: unknown = prepare.call(db, sql)
        if (!isObject(statement) || typeof statement.all !== 'function') {
          throw new Error('orchestration statement has no all()')
        }
        const all = statement.all
        return {
          all: (...args) => {
            const result: unknown = all.apply(statement, args)
            return Array.isArray(result) ? result : []
          }
        }
      }
    }
  }
}

function rows(db: OrchestrationDbLike, sql: string, arg: string): string[] {
  if (!db) {
    return []
  }
  try {
    return db.db
      .prepare(sql)
      .all(arg)
      .map((row) => (isObject(row) ? row.id : undefined))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    // Older or missing schema: no orchestration lineage, so nothing to inherit or include.
    return []
  }
}

export const TERMINAL_PREFIX = 'terminal:'

/** Workers a coordinator dispatched; dispatch rows hold /clear roots, so both sides are canonical.
 *  A terminal coordinator (`terminal:<pane>`) is matched by its pane; terminal workers come back as
 *  `terminal:<pane>` and chat-UI workers as their Orca session id. */
export function workersOfCoordinator(db: OrchestrationDbLike, coordinator: string): string[] {
  const terminal = coordinator.startsWith(TERMINAL_PREFIX)
  const root = terminal ? coordinator.slice(TERMINAL_PREFIX.length) : canonicalClaudeChatId(coordinator)
  const creator = terminal ? 'creator_pane_key' : 'creator_orca_session_id'
  const workers = [
    ...rows(
      db,
      `SELECT DISTINCT assignee_orca_session_id AS id FROM dispatch_contexts
       WHERE ${creator} = ? AND assignee_orca_session_id IS NOT NULL
         AND (creator_orca_session_id IS NULL OR assignee_orca_session_id <> creator_orca_session_id)`,
      root
    ),
    ...rows(
      db,
      `SELECT DISTINCT '${TERMINAL_PREFIX}' || assignee_pane_key AS id FROM dispatch_contexts
       WHERE ${creator} = ? AND assignee_pane_key IS NOT NULL
         AND (creator_pane_key IS NULL OR assignee_pane_key <> creator_pane_key)`,
      root
    )
  ]
  return [...new Set(workers)].filter((worker) => worker !== root && worker !== coordinator)
}

/** The newest real coordinator of a worker; self-created bookkeeping rows never count. */
export function coordinatorOfWorker(db: OrchestrationDbLike, worker: string): string | null {
  return coordinatorCandidatesOfWorker(db, worker)[0] ?? null
}

/** The ids the newest real coordinator of a worker may be pinned under: its Orca session id and,
 *  for a terminal coordinator, `terminal:<pane>`. A terminal worker is matched by its pane. */
export function coordinatorCandidatesOfWorker(db: OrchestrationDbLike, worker: string): string[] {
  const terminal = worker.startsWith(TERMINAL_PREFIX)
  const key = terminal ? worker.slice(TERMINAL_PREFIX.length) : canonicalClaudeChatId(worker)
  // Both ids come from the same (newest real) dispatch row; a self-created row never counts.
  const newest = terminal
    ? `FROM dispatch_contexts WHERE assignee_pane_key = ?
         AND (creator_pane_key IS NULL OR creator_pane_key <> assignee_pane_key)
       ORDER BY rowid DESC LIMIT 1`
    : `FROM dispatch_contexts WHERE assignee_orca_session_id = ?
         AND (creator_orca_session_id IS NULL OR creator_orca_session_id <> assignee_orca_session_id)
         AND (creator_orca_session_id IS NOT NULL OR creator_pane_key IS NOT NULL)
       ORDER BY rowid DESC LIMIT 1`
  return [
    ...rows(db, `SELECT creator_orca_session_id AS id ${newest}`, key),
    ...rows(db, `SELECT '${TERMINAL_PREFIX}' || creator_pane_key AS id ${newest}`, key)
  ].filter((id) => id !== worker && id !== key)
}
