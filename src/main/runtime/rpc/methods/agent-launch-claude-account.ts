// Overhedge: agent.launch `claudeAccount` (`--account` on `orca agent launch` and
// `orca worktree create --agent claude`). Validates before anything is created, reserves the new
// chat's pane and session id, and pins both so the first Claude process already runs under it.
import type { AgentLaunchResult } from '../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import {
  CLAUDE_LAUNCH_ACCOUNT_AGENT_ONLY,
  dropUnusedClaudeLaunchPin,
  pinClaudeLaunch,
  reserveClaudeLaunchIdentity,
  resolveClaudeLaunchAccount,
  type ClaudeLaunchAccountRouter,
  type ClaudeLaunchPinKeys
} from '../../../claude-accounts/claude-chat-account-launch'
import { InvalidArgumentError, type RpcContext } from '../core'
import { denyRpcMethodForCaller, OWNER_RPC_CALLER_SCOPE } from '../rpc-caller-scope'

export type AgentLaunchClaudeAccount<P> = {
  params: Omit<P, 'claudeAccount'>
  /** Call with the launch's result; drops the pin of the identity it did not use. */
  settle: (result: AgentLaunchResult) => void
}

/** Pin changes need what `orca account migrate` needs. */
export function claudeAccountPinDenial(context: Pick<RpcContext, 'callerScope'>): string | null {
  return denyRpcMethodForCaller(
    context.callerScope ?? OWNER_RPC_CALLER_SCOPE,
    'accounts.migrateClaudeChats',
    'accounts-admin'
  )
    ? 'This client may not choose a Claude account (it lacks the accounts-admin permission). Nothing was started.'
    : null
}

export function reserveAgentLaunchClaudeAccount<P extends AgentLaunchParams>(
  params: P,
  context: Pick<RpcContext, 'callerScope'>,
  router: ClaudeLaunchAccountRouter | null | undefined = getClaudeProfileRouter()
): AgentLaunchClaudeAccount<P> {
  const { claudeAccount, ...rest } = params
  if (claudeAccount === undefined) {
    return { params: rest, settle: () => {} }
  }
  if (params.agent !== 'claude') {
    throw new InvalidArgumentError(CLAUDE_LAUNCH_ACCOUNT_AGENT_ONLY)
  }
  if (params.reuseTerminal) {
    throw new InvalidArgumentError(
      '--account starts a new Claude chat; it cannot pick the account of a reused terminal. Nothing was started.'
    )
  }
  const denial = claudeAccountPinDenial(context)
  if (denial) {
    throw new InvalidArgumentError(denial)
  }
  const resolved = resolveClaudeLaunchAccount(router, claudeAccount)
  if (!resolved.ok || !router) {
    throw new InvalidArgumentError(resolved.ok ? 'No Claude account router.' : resolved.message)
  }
  const reserved = reserveClaudeLaunchIdentity(params.operationId)
  const paneKey = params.paneKey ?? reserved.paneKey
  const sessionId = params.sessionId ?? reserved.sessionId
  const keys: ClaudeLaunchPinKeys = { paneKey, sessionId }
  pinClaudeLaunch(router, resolved.account.id, keys)
  return {
    params: { ...rest, paneKey, sessionId },
    settle: (result) => dropUnusedClaudeLaunchPin(router, keys, result.outcome.kind)
  }
}

/** Run a launch with its `claudeAccount` resolved and pinned first (or refused, creating nothing). */
export async function launchWithClaudeAccount<
  P extends AgentLaunchParams,
  C extends Pick<RpcContext, 'callerScope'>
>(
  params: P,
  context: C,
  run: (params: Omit<P, 'claudeAccount'>, context: C) => Promise<AgentLaunchResult>
): Promise<AgentLaunchResult> {
  const account = reserveAgentLaunchClaudeAccount(params, context)
  const result = await run(account.params, context)
  account.settle(result)
  return result
}
