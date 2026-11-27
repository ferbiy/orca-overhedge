// Overhedge: the Claude account a new orchestration worker starts under. An explicit `--account`
// wins; otherwise the coordinator's effective pinned account is resolved now, at worker-start, so the
// worker's first process does not depend on its dispatch row already naming its pane.
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import { getClaudeProfileRouter } from '../../../../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import {
  CLAUDE_LAUNCH_ACCOUNT_AGENT_ONLY,
  coordinatorClaudeLaunchAccount,
  resolveClaudeLaunchAccount,
  type ClaudeLaunchAccountRouter
} from '../../../../../../claude-accounts/chat-pins/claude-chat-account-launch'
import { OrchestrationError } from '../../../../../orchestration/orchestration-error'
import type { DispatchCreator } from '../../../../../orchestration/db/dispatch-depth'
import type { OrchestrationEntryCaller } from '../../../../../orchestration/addressing/orchestration-caller-identity'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { resolveDispatchCreator } from '../../runs/dispatch-creator'
import type { RpcContext } from '../../../../core'
import { claudeAccountPinDenial } from '../../../agent-launch/agent-launch-claude-account'
import type { WorkerStartInput } from './worker-start-input'

const NOTHING = { effectsApplied: false }

/** Validates an explicit `account` before anything is created; returns its account id. */
export function resolveWorkerStartClaudeAccount(
  params: Pick<WorkerStartInput, 'account' | 'agent' | 'on' | 'terminal'>,
  context: Pick<RpcContext, 'callerScope'>,
  router: ClaudeLaunchAccountRouter | null | undefined = getClaudeProfileRouter()
): string | undefined {
  if (params.account === undefined) {
    return undefined
  }
  if (params.on) {
    throw new OrchestrationError(
      'invalid_argument',
      '--account names an account on this Orca server and cannot combine with --on. No effects were applied.',
      NOTHING
    )
  }
  if (params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--account starts a new Claude worker and cannot combine with --terminal. No effects were applied.',
      NOTHING
    )
  }
  if (params.agent !== undefined && params.agent !== 'claude') {
    throw new OrchestrationError('invalid_argument', CLAUDE_LAUNCH_ACCOUNT_AGENT_ONLY, NOTHING)
  }
  const denial = claudeAccountPinDenial(context)
  if (denial) {
    throw new OrchestrationError('invalid_argument', denial, NOTHING)
  }
  const resolved = resolveClaudeLaunchAccount(router, params.account)
  if (!resolved.ok) {
    throw new OrchestrationError('invalid_argument', resolved.message, NOTHING)
  }
  return resolved.account.id
}

/** worker-start's RPC entry: checks an explicit `account` before anything else runs, and replaces
 *  it with the id of the managed account it names; startLocalWorker pins the new worker to it. */
export function withWorkerStartClaudeAccount<
  P extends Pick<WorkerStartInput, 'account' | 'agent' | 'on' | 'terminal'>
>(params: P, context: Pick<RpcContext, 'callerScope'>): P {
  const account = resolveWorkerStartClaudeAccount(params, context)
  return account === undefined ? params : { ...params, account }
}

/** The account to pin the new worker to, or null to follow the global selection. Called once the
 *  worker's agent is known (a configured default may resolve it) and before its Run is bound. */
export function workerClaudeLaunchAccount(args: {
  explicitAccountId: string | undefined
  agent: TuiAgent | undefined
  /** A reused terminal keeps whatever its agent already runs under. */
  reusesTerminal: boolean
  creator: () => DispatchCreator
  router?: ClaudeLaunchAccountRouter | null
}): string | null {
  if (args.agent !== 'claude') {
    if (args.explicitAccountId) {
      throw new OrchestrationError('invalid_argument', CLAUDE_LAUNCH_ACCOUNT_AGENT_ONLY, NOTHING)
    }
    return null
  }
  if (args.reusesTerminal) {
    return null
  }
  if (args.explicitAccountId) {
    return args.explicitAccountId
  }
  const router = args.router === undefined ? getClaudeProfileRouter() : args.router
  if (!router) {
    return null
  }
  let creator: DispatchCreator
  try {
    creator = args.creator()
  } catch {
    return null
  }
  if (creator.kind === 'system') {
    return null
  }
  return coordinatorClaudeLaunchAccount(router, {
    orcaSessionId: creator.orcaSessionId ?? null,
    paneKey: creator.kind === 'terminal' ? (creator.paneKey ?? null) : null
  })
}

/** startLocalWorker's resolved launch (`resolveLocalWorkerStartLaunch`), plus the Claude account the
 *  new worker is pinned to. Decided before the Run is bound, so a refused `--account` creates nothing;
 *  the agent is the effective one, including an agent a `--retry-of` carried over. */
export function withLocalWorkerClaudeAccount<
  R extends { agent: TuiAgent | undefined; launch: object }
>(
  prepared: R,
  claudeAccountStart: Parameters<typeof workerClaudeAccountFor>[0]
): Omit<R, 'launch'> & { launch: R['launch'] & { claudeAccountId: string | null } } {
  const claudeAccountId = workerClaudeAccountFor(claudeAccountStart, prepared.agent)
  return { ...prepared, launch: { ...prepared.launch, claudeAccountId } }
}

/** worker-start's call: explicit `--account` (already resolved to an account id by
 *  withWorkerStartClaudeAccount), else the coordinator's effective account. */
export function workerClaudeAccountFor(
  start: {
    params: Pick<WorkerStartInput, 'account' | 'from' | 'terminal'>
    runtime: OrcaRuntimeService
    callerSession?: OrchestrationEntryCaller
  },
  agent: TuiAgent | undefined
): string | null {
  return workerClaudeLaunchAccount({
    explicitAccountId: start.params.account,
    agent,
    reusesTerminal: Boolean(start.params.terminal),
    creator: () => resolveDispatchCreator(start.runtime, start.params.from, start.callerSession)
  })
}
