// Overhedge: move Claude chats between managed accounts by re-pinning them. The running child is
// replaced by upstream's outgrown-child path: at the chat's next send, once no turn or child work is
// owed, the host stops the old process (serialized, proven exit) and resumes the same session id
// under the pinned account in the same tab, keeping the Orca session id that orchestration keys on.
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  claudeAccountLabel,
  matchClaudeAccount,
  type ClaudeChatAccountPins
} from './claude-chat-account-pins'

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
      message: `No Claude account matches "${query}". Available: ${accounts.map(claudeAccountLabel).join(', ') || 'none'}.`
    }
  }
  if ('ambiguous' in match) {
    return {
      ok: false,
      message: `"${query}" matches several accounts: ${match.ambiguous.map(claudeAccountLabel).join(', ')}.`
    }
  }
  return { ok: true, account: match }
}

export function describeClaudeMigrationPlan(
  steps: readonly ClaudeMigrationStep[],
  target: Pick<ClaudeManagedAccount, 'id' | 'email'>,
  options: { dryRun: boolean; currentAccountOf?: (orcaSessionId: string) => string | null }
): string[] {
  const verb = options.dryRun ? 'Would move' : 'Moved'
  const lines = [`${verb} ${steps.length} chat(s) to ${claudeAccountLabel(target)} (${target.id}):`]
  steps.forEach((step, index) => {
    const from = options.currentAccountOf?.(step.orcaSessionId)
    lines.push(
      `  ${index + 1}. ${step.role.padEnd(11)} ${step.orcaSessionId}${from ? `  (from ${from})` : ''}`
    )
  })
  return lines
}

/** Writes pins in plan order, so workers are re-pinned before their coordinator. */
export function applyClaudeChatMigration(
  pins: Pick<ClaudeChatAccountPins, 'set'>,
  steps: readonly ClaudeMigrationStep[],
  targetAccountId: string
): void {
  for (const step of steps) {
    pins.set(step.orcaSessionId, targetAccountId)
  }
}
