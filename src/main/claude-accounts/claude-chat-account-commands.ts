// Overhedge: server-side `/orca-account` and `/orca-migrate` chat commands and `orca account migrate`.
// Everything here is reached only when a user types those commands or runs that CLI verb.
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  canonicalClaudeChatId,
  claudeAccountLabel,
  installClaudeChatCoordinatorLookup,
  installClaudeChatLineage,
  pinnedClaudeAccountForChat,
  pinnedClaudeAccountForTerminal,
  readClaudeChatPin,
  terminalChatPinKey,
  type ClaudeChatLineage
} from './claude-chat-account-pins'
import { claudeAccountPreparation } from './claude-chat-account-preparation'
import { claudeChatAccountPinsFor } from './claude-chat-account-pin-store'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../shared/claude-profile-routing'
import {
  applyClaudeChatMigration,
  claudeAccountNames,
  describeClaudeMigrationPlan,
  planClaudeChatMigration,
  resolveClaudeMigrationTarget
} from './claude-chat-account-migration'
import type { ClaudeProfileRouter } from './claude-profile-router'

type SqlDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] } }
export type OrchestrationDbLike = { db: SqlDb } | null

function isObject(value: unknown): value is Record<string, unknown> {
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

export type ClaudeChatRecordLike = {
  sessionId: string
  provider: string
  acquiredAccount?: unknown
}

export type ClaudeTerminalChat = { paneKey: string; claudeSessionId: string | null }

export type ClaudeChatAccountDeps = {
  router: Pick<
    ClaudeProfileRouter,
    'pointerPath' | 'coveredBySystemDefault' | 'accountHome' | 'systemDefaultHome'
  > & {
    listAccounts(): readonly ClaudeManagedAccount[]
    selectedProfile(): { accountId: string } | null
  }
  records: () => readonly ClaudeChatRecordLike[]
  /** Terminal panes running Claude, from agent-status hooks; `terminal:<paneKey>` chat ids. */
  terminals?: () => readonly ClaudeTerminalChat[]
  orchestrationDb: () => OrchestrationDbLike
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

const TERMINAL_PREFIX = 'terminal:'

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

/** Wires pin inheritance (worker to coordinator) and /clear lineage into the pin lookups. */
export function installClaudeChatWorkerInheritance(
  db: () => unknown,
  lineage?: ClaudeChatLineage
): void {
  installClaudeChatLineage(lineage)
  installClaudeChatCoordinatorLookup((worker) =>
    coordinatorCandidatesOfWorker(orchestrationDbOf(db()), worker)
  )
}

function acquiredManagedAccountId(record: ClaudeChatRecordLike): string | null {
  const acquired = record.acquiredAccount
  const recipe = isObject(acquired) ? acquired.recipe : undefined
  return isObject(recipe) && recipe.route === 'managed' && typeof recipe.accountId === 'string'
    ? recipe.accountId
    : null
}

/** The account a chat runs (or will next run) under, and why. */
export function claudeChatAccount(
  deps: ClaudeChatAccountDeps,
  record: ClaudeChatRecordLike
): { accountId: string | null; source: 'pin' | 'coordinator' | 'global' } {
  const pin = pinnedClaudeAccountForChat(deps.router, record.sessionId)
  if (pin) {
    return pin
  }
  return { accountId: deps.router.selectedProfile()?.accountId ?? null, source: 'global' }
}

/** A terminal pane runs its own pin, else its coordinator's, else the global selection (the
 *  pane's claude function re-reads it at every launch). */
function terminalPaneAccount(deps: ClaudeChatAccountDeps, paneKey: string): string | null {
  return (
    pinnedClaudeAccountForTerminal(deps.router, paneKey)?.accountId ??
    deps.router.selectedProfile()?.accountId ??
    null
  )
}

function claudeChatsOnAccount(deps: ClaudeChatAccountDeps, accountId: string): string[] {
  const panes = (deps.terminals?.() ?? [])
    .filter((pane) => terminalPaneAccount(deps, pane.paneKey) === accountId)
    .map((pane) => terminalChatPinKey(pane.paneKey))
  return [...chatUiChatsOnAccount(deps, accountId), ...panes]
}

function chatUiChatsOnAccount(deps: ClaudeChatAccountDeps, accountId: string): string[] {
  return deps
    .records()
    .filter((record) => record.provider === 'claude')
    .filter((record) => {
      const current = claudeChatAccount(deps, record)
      return current.source === 'global'
        ? (acquiredManagedAccountId(record) ?? current.accountId) === accountId
        : current.accountId === accountId
    })
    .map((record) => canonicalClaudeChatId(record.sessionId))
}

export type ClaudeChatMigrationRequest = {
  /** The target account; absent with `unpin`. */
  to?: string
  /** Remove the chats' pins so they follow the global selection again. */
  unpin?: boolean
  chatIds?: string[]
  withWorkersOf?: string[]
  allOn?: string
  dryRun?: boolean
}

function chatIdFor(id: string): string {
  return id.startsWith('terminal:') ? id : canonicalClaudeChatId(id)
}

export type ClaudeChatMigrationResult = {
  ok: boolean
  lines: string[]
  moved: string[]
  /** Terminal panes among the moved chats, in plan order (workers first). */
  terminalPanes?: ClaudeTerminalChat[]
  /** The target account's config dir; null when unpinning. */
  home?: string | null
}

export function runClaudeChatMigration(
  deps: ClaudeChatAccountDeps,
  request: ClaudeChatMigrationRequest,
  options: { terminalLines?: boolean } = {}
): ClaudeChatMigrationResult {
  const accounts = deps.router.listAccounts()
  if (accounts.length === 0) {
    return { ok: false, lines: [NO_MANAGED_ACCOUNTS], moved: [] }
  }
  if (request.unpin === true && request.to !== undefined) {
    return { ok: false, lines: ['Pass either --to <account> or --unpin, not both.'], moved: [] }
  }
  if (request.unpin !== true && !request.to) {
    return { ok: false, lines: ['Pass --to <account> or --unpin.'], moved: [] }
  }
  let target: ClaudeManagedAccount | null = null
  if (request.unpin !== true) {
    const resolved = resolveClaudeMigrationTarget(accounts, request.to ?? '')
    if (!resolved.ok) {
      return { ok: false, lines: [resolved.message], moved: [] }
    }
    target = resolved.account
  }
  let allOnAccountId: string | undefined
  if (request.allOn) {
    const source = resolveClaudeMigrationTarget(accounts, request.allOn)
    if (!source.ok) {
      return { ok: false, lines: [source.message], moved: [] }
    }
    allOnAccountId = source.account.id
  }
  const terminals = new Map(
    (deps.terminals?.() ?? []).map((pane) => [terminalChatPinKey(pane.paneKey), pane])
  )
  const records = deps.records().filter((record) => record.provider === 'claude')
  const byCanonical = new Map<string, ClaudeChatRecordLike>()
  for (const record of records) {
    byCanonical.set(canonicalClaudeChatId(record.sessionId), record)
  }
  const known = new Set([...byCanonical.keys(), ...terminals.keys()])
  const steps = planClaudeChatMigration({
    chatIds: request.chatIds?.map(chatIdFor),
    withWorkersOf: request.withWorkersOf?.map(chatIdFor),
    allOnAccountId,
    // A worker row names both an Orca session id and a pane; keep the identity this host runs.
    workersOf: (coordinator) =>
      workersOfCoordinator(deps.orchestrationDb(), coordinator).filter(
        (id) => !id.startsWith(TERMINAL_PREFIX) || terminals.has(id)
      ),
    chatsOnAccount: (accountId) => claudeChatsOnAccount(deps, accountId)
  })
  const unknown = steps.filter((step) => !known.has(step.orcaSessionId))
  const movable = steps.filter((step) => known.has(step.orcaSessionId))
  const labelOf = (id: string | null): string | null => {
    const account = accounts.find((entry) => entry.id === id)
    return account ? claudeAccountLabel(account) : null
  }
  const lines = describeClaudeMigrationPlan(movable, target, {
    dryRun: request.dryRun === true,
    currentAccountOf: (id) => {
      const record = byCanonical.get(id)
      const pane = terminals.get(id)
      return record
        ? labelOf(claudeChatAccount(deps, record).accountId)
        : pane
          ? labelOf(terminalPaneAccount(deps, pane.paneKey))
          : null
    }
  })
  for (const step of unknown) {
    lines.push(`  skipped ${step.orcaSessionId}: not a Claude chat on this host`)
  }
  if (!request.dryRun) {
    applyClaudeChatMigration(claudeChatAccountPinsFor(deps.router), movable, target?.id ?? null)
    if (movable.some((step) => !terminals.has(step.orcaSessionId))) {
      lines.push(
        'Chat-UI chats switch at their next message, after the current turn ends (same tab, same session).'
      )
    }
  }
  const home = target ? claudeAccountPreparation(deps.router, target.id).configDir : null
  const terminalPanes = movable.flatMap((step) => terminals.get(step.orcaSessionId) ?? [])
  if (options.terminalLines !== false) {
    for (const pane of terminalPanes) {
      lines.push(terminalMigrationInstruction(pane, home))
    }
  }
  return { ok: true, lines, moved: movable.map((step) => step.orcaSessionId), terminalPanes, home }
}

/** The shell line that resumes a terminal chat under `home` (null: the global selection). Clearing
 *  Orca's injected marker makes the pane's claude function keep this config dir. */
export function claudeTerminalResumeLine(home: string | null, claudeSessionId: string | null): string {
  const resume = claudeSessionId ? ` --resume ${quotePosixShell(claudeSessionId)}` : ''
  return home === null
    ? `CLAUDE_CONFIG_DIR= claude${resume}`
    : `${CLAUDE_INJECTED_CONFIG_DIR_ENV}= CLAUDE_CONFIG_DIR=${quotePosixShell(home)} claude${resume}`
}

/** Not restarted in place: the user runs this once in that terminal after its turn ends. */
export function terminalMigrationInstruction(
  pane: ClaudeTerminalChat,
  home: string | null,
  why?: string
): string {
  const line = claudeTerminalResumeLine(home, pane.claudeSessionId)
  const prefix = `  terminal ${pane.paneKey}: ${why ? `not restarted automatically (${why}); ` : ''}`
  if (home === null) {
    return `${prefix}unpinned; new shells in this pane follow the global account. To switch the running Claude now, type /exit when idle, then run: ${line}`
  }
  return `${prefix}when idle, type /exit, then run: ${line}`
}

export const NO_MANAGED_ACCOUNTS =
  'This Orca host has no managed Claude accounts, so there is nothing to pin. Add one with `orca account add`; until then every chat uses the System default login.'

export function describeChatAccount(
  deps: ClaudeChatAccountDeps,
  record: ClaudeChatRecordLike,
  accounts: readonly ClaudeManagedAccount[]
): string {
  const current = claudeChatAccount(deps, record)
  const label = (id: string | null) => {
    const account = accounts.find((entry) => entry.id === id)
    return account ? claudeAccountLabel(account) : 'System default'
  }
  const why =
    current.source === 'pin'
      ? 'pinned to this chat'
      : current.source === 'coordinator'
        ? 'inherited from its coordinator'
        : 'follows the global selection'
  const rawPin = readClaudeChatPin(claudeChatAccountPinsFor(deps.router), record.sessionId)
  const stale =
    rawPin && !accounts.some((account) => account.id === rawPin)
      ? [
          `Warning: this chat is pinned to account ${rawPin}, which no longer exists on this host; it follows ${current.source === 'coordinator' ? 'its coordinator' : 'the global selection'} until you move it.`
        ]
      : []
  return [
    ...stale,
    `This chat's Claude account: ${label(current.accountId)} (${why}).`,
    `Accounts: ${claudeAccountNames(accounts)}.`,
    'Pin this chat with /orca-account <account>, unpin it with /orca-account auto; a coordinator and its workers with /orca-migrate <account> --with-workers.'
  ].join('\n')
}
