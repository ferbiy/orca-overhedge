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
import {
  coordinatorCandidatesOfWorker,
  isObject,
  orchestrationDbOf,
  TERMINAL_PREFIX,
  workersOfCoordinator,
  type OrchestrationDbLike
} from './claude-chat-account-orchestration'

export {
  coordinatorCandidatesOfWorker,
  coordinatorOfWorker,
  orchestrationDbOf,
  workersOfCoordinator,
  type OrchestrationDbLike
} from './claude-chat-account-orchestration'

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

/** The account a terminal pane's Claude was launched under, as far as Orca knows: its own pin,
 *  else its coordinator's. An unpinned pane followed the global selection *at its launch*, which
 *  Orca does not record, so its account is unknown (null); never the selection now. */
function terminalPaneAccount(deps: ClaudeChatAccountDeps, paneKey: string): string | null {
  return pinnedClaudeAccountForTerminal(deps.router, paneKey)?.accountId ?? null
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
  if (allOnAccountId) {
    for (const [id, pane] of terminals) {
      if (terminalPaneAccount(deps, pane.paneKey) === null) {
        lines.push(
          `  skipped ${id}: not pinned, so Orca cannot tell which account its running Claude uses; select it with --chat ${id}`
        )
      }
    }
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
