// Overhedge: the account home a pinned Claude chat must run under (see claude-chat-account-pins.ts).
import type { LegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { getClaudeProfileRouter } from './claude-profile-installed-router'
import { pinnedClaudeAccountForChat } from './claude-chat-account-pins'
import { claudeAccountPreparation } from './claude-chat-account-preparation'

/** Null when the chat has no usable pin, so callers keep upstream's follow-the-selection path. */
export function pinnedClaudeLaunchAccountHome(
  orcaSessionId: string
): LegacyAgentSessionAccountHome | null {
  const router = getClaudeProfileRouter()
  const pin = router ? pinnedClaudeAccountForChat(router, orcaSessionId) : null
  if (!router || !pin) {
    return null
  }
  try {
    return {
      variable: 'CLAUDE_CONFIG_DIR',
      path: claudeAccountPreparation(router, pin.accountId).configDir
    }
  } catch {
    return null
  }
}
