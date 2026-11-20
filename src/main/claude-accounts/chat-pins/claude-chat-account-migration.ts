// Overhedge: move Claude chats between managed accounts by re-pinning them. The running child is
// replaced by upstream's outgrown-child path: at the chat's next send, once no turn or child work is
// owed, the host stops the old process (serialized, proven exit) and resumes the same session id
// under the pinned account in the same tab, keeping the Orca session id that orchestration keys on.
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import {
  claudeAccountLabel,
  matchClaudeAccount,
  writeClaudeChatPin
} from './claude-chat-account-pins'
import type { ClaudeChatAccountPins } from './claude-chat-account-pin-store'

/** The names a person can type for each account: its full email (when it has one) and its id. */
export function claudeAccountNames(accounts: readonly ClaudeManagedAccount[]): string {
  return (
    accounts
      .map((account) => (account.email ? `${account.email} (id ${account.id})` : `id ${account.id}`))
      .join(', ') || 'none'
  )
}

export type ClaudeMigrationRole = 'worker' | 'chat' | 'coordinator'
export type ClaudeMigrationStep = { orcaSessionId: string; role: ClaudeMigrationRole }

/** Workers first, plain chats next, coordinators last; each chat once, with its strongest role. */
export function orderClaudeChatMigration(
  steps: readonly ClaudeMigrationStep[]
): ClaudeMigrationStep[] {
  const rank: Record<ClaudeMigrationRole, number> = { worker: 0, chat: 1, coordinator: 2 }
  // A chat named explicitly that is also a worker still moves as a worker.
  const strength: Record<ClaudeMigrationRole, number> = { chat: 0, worker: 1, coordinator: 2 }
  const byId = new Map<string, ClaudeMigrationStep>()
  for (const step of steps) {
    const seen = byId.get(step.orcaSessionId)
    if (!seen || strength[step.role] > strength[seen.role]) {
      byId.set(step.orcaSessionId, step)
    }
  }
  return [...byId.values()]
    .map((step, index) => ({ step, index }))
    .sort((a, b) => rank[a.step.role] - rank[b.step.role] || a.index - b.index)
    .map(({ step }) => step)
}

export function planClaudeChatMigration(input: {
  chatIds?: readonly string[]
  withWorkersOf?: readonly string[]
  allOnAccountId?: string
  workersOf: (coordinatorOrcaSessionId: string) => readonly string[]
  chatsOnAccount: (accountId: string) => readonly string[]
}): ClaudeMigrationStep[] {
  const steps: ClaudeMigrationStep[] = []
  for (const coordinator of input.withWorkersOf ?? []) {
    for (const worker of input.workersOf(coordinator)) {
      if (worker !== coordinator) {
        steps.push({ orcaSessionId: worker, role: 'worker' })
      }
    }
    steps.push({ orcaSessionId: coordinator, role: 'coordinator' })
  }
  for (const id of input.chatIds ?? []) {
    steps.push({ orcaSessionId: id, role: 'chat' })
  }
  if (input.allOnAccountId) {
    for (const id of input.chatsOnAccount(input.allOnAccountId)) {
      steps.push({ orcaSessionId: id, role: 'chat' })
    }
  }
  return orderClaudeChatMigration(steps)
}

export function resolveClaudeMigrationTarget(
  accounts: readonly ClaudeManagedAccount[],
  query: string
): { ok: true; account: ClaudeManagedAccount } | { ok: false; message: string } {
  const match = matchClaudeAccount(accounts, query)
  if (!match) {
    return {
      ok: false,
      message: `No Claude account is named "${query}"; nothing changed. Valid names: ${claudeAccountNames(accounts)}.`
    }
  }
  if ('ambiguous' in match) {
    return {
      ok: false,
      message: `"${query}" names several accounts; nothing changed. Use an id: ${claudeAccountNames(match.ambiguous)}.`
    }
  }
  return { ok: true, account: match }
}

export function describeClaudeMigrationPlan(
  steps: readonly ClaudeMigrationStep[],
  /** Null: the chats are unpinned and follow the global selection again. */
  target: Pick<ClaudeManagedAccount, 'id' | 'email'> | null,
  options: { dryRun: boolean; currentAccountOf?: (orcaSessionId: string) => string | null }
): string[] {
  const lines = [
    target
      ? `${options.dryRun ? 'Would move' : 'Moved'} ${steps.length} chat(s) to ${claudeAccountLabel(target)} (${target.id}):`
      : `${options.dryRun ? 'Would unpin' : 'Unpinned'} ${steps.length} chat(s); they follow the global selection again:`
  ]
  steps.forEach((step, index) => {
    const from = options.currentAccountOf?.(step.orcaSessionId)
    lines.push(
      `  ${index + 1}. ${step.role.padEnd(11)} ${step.orcaSessionId}${from ? `  (from ${from})` : ''}`
    )
  })
  return lines
}

/** Writes pins in plan order, so workers are re-pinned before their coordinator; null unpins.
 *  Chat ids are keyed by their /clear root, terminal panes by `terminal:<paneKey>`. */
export function applyClaudeChatMigration(
  pins: Pick<ClaudeChatAccountPins, 'set' | 'update'>,
  steps: readonly ClaudeMigrationStep[],
  targetAccountId: string | null
): void {
  for (const step of steps) {
    if (step.orcaSessionId.startsWith('terminal:')) {
      pins.set(step.orcaSessionId, targetAccountId)
    } else {
      writeClaudeChatPin(pins, step.orcaSessionId, targetAccountId)
    }
  }
}
