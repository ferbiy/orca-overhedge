// Overhedge: per-chat Claude account pins. Kept in its own file next to the router's pointer so the
// session record schema stays untouched; absent pins mean "follow the global selection" as upstream.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'

/** Orca session id (chat UI) or `terminal:<handle>` (terminal tab) to managed account id. */
type PinFile = { version: 1; chats: Record<string, string> }

export const CLAUDE_CHAT_ACCOUNT_PINS_FILE = 'chat-account-pins.json'

export class ClaudeChatAccountPins {
  constructor(readonly path: string) {}

  private read(): PinFile {
    try {
      if (!existsSync(this.path)) {
        return { version: 1, chats: {} }
      }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PinFile>
      return parsed && typeof parsed.chats === 'object' && parsed.chats
        ? { version: 1, chats: { ...parsed.chats } }
        : { version: 1, chats: {} }
    } catch {
      // A corrupt pin file must not stop launches; chats then follow the global selection.
      return { version: 1, chats: {} }
    }
  }

  get(chatId: string): string | null {
    const value = this.read().chats[chatId]
    return typeof value === 'string' && value ? value : null
  }

  set(chatId: string, accountId: string | null): void {
    const file = this.read()
    if (accountId) {
      file.chats[chatId] = accountId
    } else {
      delete file.chats[chatId]
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileAtomically(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  }

  all(): Record<string, string> {
    return this.read().chats
  }
}

const byPath = new Map<string, ClaudeChatAccountPins>()

/** Pins live beside the router's `selected-host` pointer (`<userData>/claude-profiles`). */
export function claudeChatAccountPinsFor(router: { pointerPath: string }): ClaudeChatAccountPins {
  const path = join(dirname(router.pointerPath), CLAUDE_CHAT_ACCOUNT_PINS_FILE)
  let pins = byPath.get(path)
  if (!pins) {
    pins = new ClaudeChatAccountPins(path)
    byPath.set(path, pins)
  }
  return pins
}

export function terminalChatPinKey(handle: string): string {
  return `terminal:${handle}`
}

/** Orchestration: the coordinator chat that dispatched this worker chat, if any. */
type CoordinatorLookup = (orcaSessionId: string) => string | null
let coordinatorLookup: CoordinatorLookup | undefined

export function installClaudeChatCoordinatorLookup(lookup: CoordinatorLookup | undefined): void {
  coordinatorLookup = lookup
}

export type ClaudeChatAccountSource = 'pin' | 'coordinator' | 'global'

/** Precedence: the chat's own pin, then its coordinator's pin, then the global selection (null). */
export function resolveClaudeChatAccount(input: {
  pinned: string | null
  coordinatorPinned: string | null
  knownAccountIds: readonly string[]
}): { accountId: string; source: Exclude<ClaudeChatAccountSource, 'global'> } | null {
  const known = (id: string | null): id is string =>
    id !== null && input.knownAccountIds.includes(id)
  if (known(input.pinned)) {
    return { accountId: input.pinned, source: 'pin' }
  }
  if (known(input.coordinatorPinned)) {
    return { accountId: input.coordinatorPinned, source: 'coordinator' }
  }
  return null
}

/** The pinned account a chat launches under; null follows the global selection unchanged. */
export function pinnedClaudeAccountForChat(
  router: { pointerPath: string; listAccounts(): readonly ClaudeManagedAccount[] },
  orcaSessionId: string | null | undefined
): { accountId: string; source: Exclude<ClaudeChatAccountSource, 'global'> } | null {
  if (!orcaSessionId) {
    return null
  }
  const pins = claudeChatAccountPinsFor(router)
  const pinned = pins.get(orcaSessionId)
  let coordinatorPinned: string | null = null
  if (!pinned && coordinatorLookup) {
    try {
      const coordinator = coordinatorLookup(orcaSessionId)
      coordinatorPinned = coordinator ? pins.get(coordinator) : null
    } catch {
      coordinatorPinned = null
    }
  }
  return resolveClaudeChatAccount({
    pinned,
    coordinatorPinned,
    knownAccountIds: router.listAccounts().map((account) => account.id)
  })
}

export function claudeAccountLabel(account: Pick<ClaudeManagedAccount, 'id' | 'email'>): string {
  return account.email || account.id
}

/** Match by id, id prefix (4+ chars), email, or the email's local part; case-insensitive. */
export function matchClaudeAccount<T extends Pick<ClaudeManagedAccount, 'id' | 'email'>>(
  accounts: readonly T[],
  query: string
): T | { ambiguous: T[] } | null {
  const q = query.trim().toLowerCase()
  if (!q) {
    return null
  }
  const exact = accounts.find(
    (account) => account.id.toLowerCase() === q || account.email.toLowerCase() === q
  )
  if (exact) {
    return exact
  }
  const loose = accounts.filter(
    (account) =>
      account.email.toLowerCase().split('@')[0] === q ||
      (q.length >= 4 && account.id.toLowerCase().startsWith(q)) ||
      (q.length >= 3 && account.email.toLowerCase().startsWith(q))
  )
  if (loose.length === 1) {
    return loose[0]
  }
  return loose.length > 1 ? { ambiguous: loose } : null
}
