import type { ClaudeAccountRecipe } from '../../shared/agent-session/lifecycle/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../claude-accounts/claude-profile-router'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { resolveStructuredClaudeAccountHomePath } from '../runtime/agent-session/environment/structured-agent-account-home'
import { pinnedClaudeAccountForChat } from '../claude-accounts/claude-chat-account-pins'

/** The account a launch runs under is the current selection; the receipt records what it used. */
export async function prepareClaudeLaunchAccount(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  /** Overhedge: the chat's Orca session id; a pinned chat launches under its pin. */
  orcaSessionId?: string
): Promise<ClaudeAccountRecipe> {
  if (!router) {
    return { route: 'system', home: recordHome, configDir: env.CLAUDE_CONFIG_DIR ?? null }
  }
  const pin = pinnedClaudeAccountForChat(router, orcaSessionId)
  const preparation = pin
    ? await router.prepareLaunchForAccount(pin.accountId)
    : await router.prepareLaunch()
  const home =
    preparation.provenance === 'system'
      ? await resolveStructuredClaudeAccountHomePath({
          launchEnv: env,
          wslDistro: null,
          getClaudeConfigDirectory: () => router.systemDefaultHome()
        })
      : preparation.configDir
  applyClaudeEnvPatch(env, preparation.envPatch)
  return preparation.provenance.startsWith('profile:')
    ? { route: 'managed', accountId: preparation.provenance.slice('profile:'.length), home }
    : { route: 'system', home, configDir: env.CLAUDE_CONFIG_DIR ?? null }
}
