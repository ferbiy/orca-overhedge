// Overhedge: per-chat account pins for terminal Claude tabs, keyed by the pane (`<tabId>:<leafId>`),
// which survives restore and restart of the pane's shell.
import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../../shared/agent-accounts/claude/claude-profile-routing'
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import { pinnedClaudeAccountForTerminal } from './claude-chat-account-pins'
import { claudeAccountPreparation } from './claude-chat-account-preparation'
import type { ClaudeProfileRouter } from '../profiles/routing/claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from '../runtime-auth/runtime-auth-types'
import type { ClaudeAccountSelectionTarget } from '../selection/runtime-selection'

type PinRouter = Pick<
  ClaudeProfileRouter,
  'pointerPath' | 'coveredBySystemDefault' | 'accountHome' | 'systemDefaultHome'
> & { listAccounts(): readonly ClaudeManagedAccount[] }

/** The pinned account home for a terminal pane, or null to keep upstream's global routing. */
export function pinnedClaudeTerminalHome(
  router: PinRouter | undefined,
  paneKey: string | undefined,
  target?: ClaudeAccountSelectionTarget
): string | null {
  if (!router || !paneKey || target?.runtime === 'wsl') {
    return null
  }
  // Own pin, else (orchestration worker panes) the coordinator's pin, as for chat-UI workers.
  const accountId = pinnedClaudeAccountForTerminal(router, paneKey)?.accountId
  if (!accountId) {
    return null
  }
  try {
    return claudeAccountPreparation(router, accountId).configDir
  } catch {
    return null
  }
}

/** Set the pinned config dir without Orca's injected marker: the claude shell function then treats
 *  it as the pane's own override and never follows the global pointer. */
export function applyClaudeTerminalPin<Env extends Record<string, string> | undefined>(
  home: string | null,
  env: Env,
  auth: ClaudeRuntimeAuthPreparation | null
): { env: Env | Record<string, string>; auth: ClaudeRuntimeAuthPreparation | null } {
  if (!home) {
    return { env, auth }
  }
  const { [CLAUDE_INJECTED_CONFIG_DIR_ENV]: _marker, ...rest } = env ?? {}
  const pinned = { ...rest, CLAUDE_CONFIG_DIR: home }
  if (!auth) {
    return { env: pinned, auth }
  }
  const authEnv = Object.fromEntries(
    Object.entries(auth.envPatch).filter(
      ([key]) => key !== CLAUDE_INJECTED_CONFIG_DIR_ENV && key !== 'CLAUDE_CONFIG_DIR'
    )
  )
  return {
    env: pinned,
    auth: {
      ...auth,
      configDir: home,
      envPatch: { ...authEnv, CLAUDE_CONFIG_DIR: home }
    }
  }
}
