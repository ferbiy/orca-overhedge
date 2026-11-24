// overhedge: a prompt typed in a Remote Control client (claude.ai or the Claude app) reaches the
// CLI over its bridge, not from Orca. The CLI queues it like any prompt and, with
// --replay-user-messages, echoes it on stdout as a user replay under the bridge message's uuid.
// No Orca dispatch waiter claims that echo, and user bubbles otherwise come only from Orca's own
// submissions, so the prompt would never show and its reply would open a turn with no prompt.

import { claudeRemoteControl } from '../../remote-control/claude-remote-control-registry'
import {
  claudeMessageBody,
  claudeRecord,
  type ClaudeMessageEnvelope
} from '../journal/claude-structured-item-translation'
import type { ClaudeSession } from '../claude-structured-session-state'

/** `opens`: the prompt starts its own turn. `joins`: it was folded into the running turn. */
export type ClaudeRemoteControlUserTurn = 'opens' | 'joins'

/** CLI-made replays (command expansions, local command and bash output) are not a typed prompt. */
const CLI_WRAPPED = /^\s*<(?:command-name|command-message|command-args|local-command-|bash-)/u

/** For a root user replay that no Orca send claimed: how it enters the chat when Remote Control
 *  runs on this child and the replay is a person's prompt; null otherwise (left as upstream). */
export function claudeRemoteControlUserTurn(
  session: Pick<ClaudeSession, 'connection' | 'translator'>,
  message: Record<string, unknown>,
  envelope: ClaudeMessageEnvelope
): ClaudeRemoteControlUserTurn | null {
  if (message.isReplay !== true || !claudeRemoteControl.isOnFor(session.connection)) {
    return null
  }
  const origin = claudeRecord(message.origin)
  if (origin && origin.kind !== 'human') {
    return null
  }
  const body = envelope.role === 'user' ? claudeMessageBody(envelope) : null
  const first = body?.blocks[0]
  if (!first || (first.type === 'text' && CLI_WRAPPED.test(first.text))) {
    return null
  }
  return session.translator?.turnCycle.ownsLiveProviderCycle === true ? 'joins' : 'opens'
}
