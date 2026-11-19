// Overhedge: server-side `/account` and `/migrate` chat commands and `orca account migrate`.
// Everything here is reached only when a user types those commands or runs that CLI verb.
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  claudeAccountLabel,
  claudeChatAccountPinsFor,
  installClaudeChatCoordinatorLookup,
  pinnedClaudeAccountForChat,
  terminalChatPinKey
} from './claude-chat-account-pins'
import { claudeAccountPreparation } from './claude-chat-account-preparation'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import {
  applyClaudeChatMigration,
  describeClaudeMigrationPlan,
  planClaudeChatMigration,
  resolveClaudeMigrationTarget
} from './claude-chat-account-migration'
import type { ClaudeProfileRouter } from './claude-profile-router'

type SqlDb = { prepare(sql: string): { all(...args: unknown[]): unknown[] } }
export type OrchestrationDbLike = { db: SqlDb } | null

export type ClaudeChatRecordLike = {
  sessionId: string
  provider: string
  acquiredAccount?: unknown
}

export type ClaudeTerminalChat = { paneKey: string; claudeSessionId: string | null }

export type ClaudeChatAccountDeps = {
  router: Pick<
    ClaudeProfileRouter,
    | 'pointerPath'
    | 'listAccounts'
    | 'selectedProfile'
    | 'coveredBySystemDefault'
    | 'accountHome'
    | 'systemDefaultHome'
  >
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
      .map((row) => Object.values(row as Record<string, unknown>)[0])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  } catch {
    // Older or missing schema: no orchestration lineage, so nothing to inherit or include.
    return []
  }
}

export function workersOfCoordinator(db: OrchestrationDbLike, coordinator: string): string[] {
  return [
    ...new Set(
      rows(
        db,
        `SELECT DISTINCT assignee_orca_session_id FROM dispatch_contexts
         WHERE creator_orca_session_id = ? AND assignee_orca_session_id IS NOT NULL`,
        coordinator
      )
    )
  ]
}

export function coordinatorOfWorker(db: OrchestrationDbLike, worker: string): string | null {
  return (
    rows(
      db,
      `SELECT creator_orca_session_id FROM dispatch_contexts
       WHERE assignee_orca_session_id = ? AND creator_orca_session_id IS NOT NULL
       ORDER BY rowid DESC LIMIT 1`,
      worker
    ).find((id) => id !== worker) ?? null
  )
}

export function installClaudeChatWorkerInheritance(db: () => unknown): void {
  installClaudeChatCoordinatorLookup((worker) =>
    coordinatorOfWorker(db() as OrchestrationDbLike, worker)
  )
}

function acquiredManagedAccountId(record: ClaudeChatRecordLike): string | null {
  const acquired = record.acquiredAccount as
    | { recipe?: { route?: string; accountId?: string } }
    | undefined
  return acquired?.recipe?.route === 'managed' && typeof acquired.recipe.accountId === 'string'
    ? acquired.recipe.accountId
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

function claudeChatsOnAccount(deps: ClaudeChatAccountDeps, accountId: string): string[] {
  return deps
    .records()
    .filter((record) => record.provider === 'claude')
    .filter((record) => {
      const current = claudeChatAccount(deps, record)
      return current.source === 'global'
        ? (acquiredManagedAccountId(record) ?? current.accountId) === accountId
        : current.accountId === accountId
    })
    .map((record) => record.sessionId)
}

export type ClaudeChatMigrationRequest = {
  to: string
  chatIds?: string[]
  withWorkersOf?: string[]
  allOn?: string
  dryRun?: boolean
}

export function runClaudeChatMigration(
  deps: ClaudeChatAccountDeps,
  request: ClaudeChatMigrationRequest
): { ok: boolean; lines: string[]; moved: string[] } {
  const accounts = deps.router.listAccounts()
  const target = resolveClaudeMigrationTarget(accounts, request.to)
  if (!target.ok) {
    return { ok: false, lines: [target.message], moved: [] }
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
  const known = new Set([
    ...deps
      .records()
      .filter((record) => record.provider === 'claude')
      .map((record) => record.sessionId),
    ...terminals.keys()
  ])
  const steps = planClaudeChatMigration({
    chatIds: request.chatIds,
    withWorkersOf: request.withWorkersOf,
    allOnAccountId,
    workersOf: (coordinator) => workersOfCoordinator(deps.orchestrationDb(), coordinator),
    chatsOnAccount: (accountId) => claudeChatsOnAccount(deps, accountId)
  })
  const unknown = steps.filter((step) => !known.has(step.orcaSessionId))
  const movable = steps.filter((step) => known.has(step.orcaSessionId))
  const labelOf = (id: string | null): string | null => {
    const account = accounts.find((entry) => entry.id === id)
    return account ? claudeAccountLabel(account) : null
  }
  const byId = new Map(deps.records().map((record) => [record.sessionId, record]))
  const lines = describeClaudeMigrationPlan(movable, target.account, {
    dryRun: request.dryRun === true,
    currentAccountOf: (id) => {
      const record = byId.get(id)
      return record ? labelOf(claudeChatAccount(deps, record).accountId) : null
    }
  })
  for (const step of unknown) {
    lines.push(`  skipped ${step.orcaSessionId}: not a Claude chat on this host`)
  }
  if (!request.dryRun) {
    applyClaudeChatMigration(claudeChatAccountPinsFor(deps.router), movable, target.account.id)
    if (movable.some((step) => !terminals.has(step.orcaSessionId))) {
      lines.push(
        'Chat-UI chats switch at their next message, after the current turn ends (same tab, same session).'
      )
    }
  }
  const home = claudeAccountPreparation(deps.router, target.account.id).configDir
  for (const step of movable) {
    const pane = terminals.get(step.orcaSessionId)
    if (pane) {
      lines.push(terminalMigrationInstruction(pane, home))
    }
  }
  return { ok: true, lines, moved: movable.map((step) => step.orcaSessionId) }
}

/** Not restarted in place yet: the user runs this once in that terminal after its turn ends. */
export function terminalMigrationInstruction(pane: ClaudeTerminalChat, home: string): string {
  const resume = pane.claudeSessionId ? ` --resume ${quotePosixShell(pane.claudeSessionId)}` : ''
  return `  terminal ${pane.paneKey}: when idle, type /exit, then run: CLAUDE_CONFIG_DIR=${quotePosixShell(home)} claude${resume}`
}

export type AccountSlashCommand =
  | { kind: 'show' }
  | { kind: 'move'; to: string; withWorkers: boolean }

/** Exactly `/account`, `/account <label>`, `/migrate <label> [--with-workers]`; else null. */
export function parseAccountSlashCommand(text: string): AccountSlashCommand | null {
  const trimmed = text.trim()
  const match = /^\/(account|migrate)(?:\s+(.*))?$/s.exec(trimmed)
  if (!match) {
    return null
  }
  const [, verb, rest = ''] = match
  const words = rest.split(/\s+/).filter(Boolean)
  const withWorkers = words.includes('--with-workers')
  const args = words.filter((word) => word !== '--with-workers')
  if (args.length > 1 || (withWorkers && verb !== 'migrate')) {
    return null
  }
  if (args.length === 0) {
    return verb === 'account' && !withWorkers ? { kind: 'show' } : null
  }
  return { kind: 'move', to: args[0], withWorkers }
}

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
  const available = accounts.map(
    (account) => `${claudeAccountLabel(account)} (${account.id.slice(0, 8)})`
  )
  const rawPin = claudeChatAccountPinsFor(deps.router).get(record.sessionId)
  const stale =
    rawPin && !accounts.some((account) => account.id === rawPin)
      ? [
          `Warning: this chat is pinned to account ${rawPin}, which no longer exists on this host; it follows the global selection until you move it.`
        ]
      : []
  return [
    ...stale,
    `This chat's Claude account: ${label(current.accountId)} (${why}).`,
    `Available: ${available.join(', ') || 'none'}.`,
    'Move this chat with /account <label>; a coordinator and its workers with /migrate <label> --with-workers.'
  ].join('\n')
}
