// Overhedge: per-chat account pins for terminal Claude tabs, keyed by the pane (`<tabId>:<leafId>`),
// which survives restore and restart of the pane's shell.
import { CLAUDE_INJECTED_CONFIG_DIR_ENV } from '../../shared/claude-profile-routing'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { claudeChatAccountPinsFor, terminalChatPinKey } from './claude-chat-account-pins'
import { claudeAccountPreparation } from './claude-chat-account-preparation'
import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

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
  const accountId = claudeChatAccountPinsFor(router).get(terminalChatPinKey(paneKey))
  if (!accountId || !router.listAccounts().some((account) => account.id === accountId)) {
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
  const {
    [CLAUDE_INJECTED_CONFIG_DIR_ENV]: _authMarker,
    CLAUDE_CONFIG_DIR: _authHome,
    ...authEnv
  } = auth.envPatch as Record<string, string>
  return {
    env: pinned,
    auth: {
      ...auth,
      configDir: home,
      envPatch: { ...authEnv, CLAUDE_CONFIG_DIR: home }
    }
  }
}
