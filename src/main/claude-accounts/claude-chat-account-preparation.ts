// Overhedge: launch inputs for a chat pinned to one managed Claude account.
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV
} from '../../shared/claude-profile-routing'
import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

type RouterReads = Pick<
  ClaudeProfileRouter,
  'pointerPath' | 'coveredBySystemDefault' | 'accountHome' | 'systemDefaultHome'
>

/** Like the router's own preparation, but for `accountId` instead of the global selection. */
export function claudeAccountPreparation(
  router: RouterReads,
  accountId: string
): ClaudeRuntimeAuthPreparation {
  const home = router.coveredBySystemDefault(accountId) ? null : router.accountHome(accountId)
  return {
    configDir: home ?? router.systemDefaultHome(),
    runtime: 'host',
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: {
      [CLAUDE_PROFILE_POINTER_ENV]: router.pointerPath,
      ...(home ? { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home } : {})
    },
    provenance: home ? `profile:${accountId}` : 'system'
  }
}
