import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'
import { pinnedClaudeAccountForChat } from '../../../claude-accounts/chat-pins/claude-chat-account-pins'
import { pinnedClaudeLaunchAccountHome } from '../../../claude-accounts/chat-pins/claude-chat-account-pin-home'

/** The account a launch runs under is the current selection; the receipt records what it used. */
export async function prepareClaudeLaunchAccount(
  router:
    | Pick<
        ClaudeProfileRouter,
        'prepareLaunch' | 'prepareLaunchForAccount' | 'systemDefaultHome' | 'pointerPath' | 'listAccounts'
      >
    | undefined,
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
  // A pin names its account's own folder (the System default login's for a covered account);
  // resolving the home again would read the global selection and launch under that instead.
  const home = pin
    ? preparation.configDir
    : preparation.provenance === 'system'
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

/** Pins the account a launch would run under now, without preparing its folder: managed settings
 *  can refuse flags per account, so flag checks must ask as that account. */
export async function withClaudeLaunchAccountPin(
  router: ClaudeProfileRouter | undefined,
  env: Record<string, string>,
  recordHome: string,
  /** Overhedge: the chat's Orca session id; a pinned chat's flags are checked as its pin. */
  orcaSessionId?: string
): Promise<Record<string, string>> {
  const pinned =
    router && orcaSessionId ? pinnedClaudeLaunchAccountHome(orcaSessionId, router) : null
  const home = pinned
    ? pinned.path
    : router
      ? await resolveStructuredClaudeAccountHomePath({
          launchEnv: env,
          wslDistro: null,
          purpose: 'identity',
          getClaudeConfigDirectory: () => router.systemDefaultHome()
        })
      : recordHome
  return { ...env, ...claudeConfigDirEnvPatch(home, { env }) }
}
