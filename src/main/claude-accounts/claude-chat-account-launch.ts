// Overhedge: pin a new Claude chat to an account before its first process starts. The launch
// reserves both identities the chat can end up with (its terminal pane and its chat-UI session id),
// pins both, and drops the one the launch did not use. Explicit `--account` and, for orchestration
// workers, the coordinator's effective account both go through here.
import { createHash, randomUUID } from 'node:crypto'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import { createStructuredAgentSessionId } from '../../shared/agent-session/structured-agent-session-create'
import { claudeChatAccountPinsFor } from './claude-chat-account-pin-store'
import {
  pinnedClaudeAccountForChat,
  pinnedClaudeAccountForTerminal,
  terminalChatPinKey
} from './claude-chat-account-pins'
import { resolveClaudeMigrationTarget } from './claude-chat-account-migration'

export type ClaudeLaunchAccountRouter = {
  pointerPath: string
  listAccounts(): readonly ClaudeManagedAccount[]
}

/** The keys a new chat is pinned under: `terminal:<paneKey>` and its Orca session id. */
export type ClaudeLaunchPinKeys = { paneKey?: string; sessionId?: string }

export const CLAUDE_LAUNCH_ACCOUNT_AGENT_ONLY =
  '--account applies only to Claude (--agent claude); other agents have no Orca-managed Claude account. Nothing was started.'

/** The managed account `query` names (id or full email), or a message listing the valid names. */
export function resolveClaudeLaunchAccount(
  router: ClaudeLaunchAccountRouter | null | undefined,
  query: string
): { ok: true; account: ClaudeManagedAccount } | { ok: false; message: string } {
  const accounts = router?.listAccounts() ?? []
  if (!router || accounts.length === 0) {
    return {
      ok: false,
      message:
        'This Orca host has no Orca-managed Claude accounts, so --account cannot be used. Nothing was started.'
    }
  }
  const resolved = resolveClaudeMigrationTarget(accounts, query)
  return resolved.ok
    ? resolved
    : { ok: false, message: resolved.message.replace('nothing changed', 'nothing was started') }
}

function uuidFromDigest(hex: string): string {
  const variant = '89ab'[Number.parseInt(hex[16], 16) & 3]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Fresh identities for a launch, or, for a replayable launch, ones derived from its operation id so
 *  a retry of the same operation reserves (and fingerprints) the same pane and session. */
export function reserveClaudeLaunchIdentity(
  operationId: string | undefined,
  random: () => string = randomUUID
): { paneKey: string; sessionId: string } {
  if (!operationId) {
    return {
      paneKey: makePaneKey(random(), random()),
      sessionId: createStructuredAgentSessionId('claude', random)
    }
  }
  const digest = (part: string) =>
    createHash('sha256').update(`overhedge-claude-launch:${part}:${operationId}`).digest('hex')
  return {
    paneKey: makePaneKey(uuidFromDigest(digest('tab')), uuidFromDigest(digest('leaf'))),
    sessionId: createStructuredAgentSessionId('claude', () => uuidFromDigest(digest('session')))
  }
}

/** Pin every reserved key of a new chat to `accountId` in one write. */
export function pinClaudeLaunch(
  router: Pick<ClaudeLaunchAccountRouter, 'pointerPath'>,
  accountId: string,
  keys: ClaudeLaunchPinKeys
): void {
  claudeChatAccountPinsFor(router).update((chats) => {
    if (keys.paneKey) {
      chats[terminalChatPinKey(keys.paneKey)] = accountId
    }
    if (keys.sessionId) {
      chats[keys.sessionId] = accountId
    }
  })
}

/** Drop the pin of the identity the launch did not use. Best effort: a stale key is harmless. */
export function dropUnusedClaudeLaunchPin(
  router: Pick<ClaudeLaunchAccountRouter, 'pointerPath'>,
  keys: ClaudeLaunchPinKeys,
  used: 'terminal' | 'structured'
): void {
  const unused =
    used === 'terminal'
      ? keys.sessionId
      : keys.paneKey
        ? terminalChatPinKey(keys.paneKey)
        : undefined
  if (!unused) {
    return
  }
  try {
    claudeChatAccountPinsFor(router).update((chats) => {
      delete chats[unused]
    })
  } catch {
    // Unwritable: the unused key names no chat, so it never decides a launch.
  }
}

/** A coordinator's effective pinned account (its own pin, else its own coordinator's), or null when
 *  it follows the global selection. Its Orca session id is tried before its terminal pane. */
export function coordinatorClaudeLaunchAccount(
  router: ClaudeLaunchAccountRouter | null | undefined,
  coordinator: { orcaSessionId?: string | null; paneKey?: string | null } | null
): string | null {
  if (!router || !coordinator) {
    return null
  }
  try {
    const bySession = coordinator.orcaSessionId
      ? pinnedClaudeAccountForChat(router, coordinator.orcaSessionId)
      : null
    if (bySession) {
      return bySession.accountId
    }
    return coordinator.paneKey
      ? (pinnedClaudeAccountForTerminal(router, coordinator.paneKey)?.accountId ?? null)
      : null
  } catch {
    // Pins unreadable: the worker follows the global selection, as before.
    return null
  }
}
