import type { ClaudeAccountRecipe } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-acquired-account'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { applyClaudeEnvPatch } from '../../../claude-accounts/runtime-auth/environment'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import { resolveStructuredClaudeAccountHomePath } from '../../../runtime/agent-session/environment/structured-agent-account-home'
import { pinnedClaudeAccountForChat } from '../../../claude-accounts/chat-pins/claude-chat-account-pins'
import { claudeAccountPreparation } from '../../../claude-accounts/chat-pins/claude-chat-account-preparation'
import { pinnedClaudeLaunchAccountHome } from '../../../claude-accounts/chat-pins/claude-chat-account-pin-home'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

/** Overhedge: a chat launch passes its record, so a pinned chat launches (and is probed) under its
 *  pin; other callers pass the record's home path, optionally with the chat id. */
type ClaudeLaunchHome = string | Pick<AgentSessionRecord, 'sessionId' | 'accountHome'>

function launchHomeParts(
  launchHome: ClaudeLaunchHome,
  orcaSessionId: string | undefined
): { recordHome: string; orcaSessionId: string | undefined } {
  return typeof launchHome === 'string'
    ? { recordHome: launchHome, orcaSessionId }
    : {
        recordHome: requireLegacyAgentSessionAccountHome(launchHome.accountHome).path,
        orcaSessionId: launchHome.sessionId
      }
}

/** The account a launch runs under is the current selection; the receipt records what it used. */
export async function prepareClaudeLaunchAccount(
  router:
    | Pick<
        ClaudeProfileRouter,
        | 'prepareLaunch'
        | 'prepareLaunchForAccount'
        | 'systemDefaultHome'
        | 'pointerPath'
        | 'listAccounts'
        | 'coveredBySystemDefault'
        | 'accountHome'
      >
    | undefined,
  env: Record<string, string>,
  launchHome: ClaudeLaunchHome,
  chatId?: string
): Promise<ClaudeAccountRecipe> {
  const { recordHome, orcaSessionId } = launchHomeParts(launchHome, chatId)
  if (!router) {
    return { route: 'system', home: recordHome, configDir: env.CLAUDE_CONFIG_DIR ?? null }
  }
  const pin = pinnedClaudeAccountForChat(router, orcaSessionId)
  const preparation = pin
    ? await router
        .prepareLaunchForAccount(pin.accountId)
        .then(() => claudeAccountPreparation(router, pin.accountId))
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
  launchHome: ClaudeLaunchHome,
  chatId?: string
): Promise<Record<string, string>> {
  const { recordHome, orcaSessionId } = launchHomeParts(launchHome, chatId)
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
