// Overhedge: per-chat Claude account pins. Kept in its own file next to the router's pointer so the
// session record schema stays untouched; absent pins mean "follow the global selection" as upstream.
// Chat pins are keyed by the chat's /clear lineage root (its canonical Orca session id), the id
// orchestration's dispatch rows use, so a /clear keeps the pin and workers still find coordinators.
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { claudeChatAccountPinsFor, type ClaudeChatAccountPins } from './claude-chat-account-pin-store'

export function terminalChatPinKey(handle: string): string {
  return `terminal:${handle}`
}

/** A chat's /clear lineage, newest first, ending at its root; null while records cannot be read. */
export type ClaudeChatLineage = (orcaSessionId: string) => readonly string[] | null
const NO_LINEAGE: ClaudeChatLineage = () => null
let chatLineage: ClaudeChatLineage = NO_LINEAGE

export function installClaudeChatLineage(lineage: ClaudeChatLineage | undefined): void {
  chatLineage = lineage ?? NO_LINEAGE
}

function lineageOf(orcaSessionId: string): readonly string[] {
  const lineage = chatLineage(orcaSessionId)
  return lineage && lineage.length > 0 ? lineage : [orcaSessionId]
}

/** The id a chat's pin and orchestration rows are keyed by: its /clear root. */
export function canonicalClaudeChatId(orcaSessionId: string): string {
  const lineage = lineageOf(orcaSessionId)
  return lineage.at(-1) ?? orcaSessionId
}

/** The chat's pin: the root's, else one an older build wrote under a later id of the lineage. */
export function readClaudeChatPin(
  pins: Pick<ClaudeChatAccountPins, 'get'>,
  orcaSessionId: string
): string | null {
  const lineage = lineageOf(orcaSessionId)
  const root = lineage.at(-1) ?? orcaSessionId
  return pins.get(root) ?? lineage.map((id) => pins.get(id)).find((pin) => pin !== null) ?? null
}

/** Pin (or with null, unpin) the chat under its root and drop pins older builds left on its
 *  other lineage ids, so one key decides. */
export function writeClaudeChatPin(
  pins: Pick<ClaudeChatAccountPins, 'update'>,
  orcaSessionId: string,
  accountId: string | null
): void {
  const lineage = lineageOf(orcaSessionId)
  const root = lineage.at(-1) ?? orcaSessionId
  pins.update((chats) => {
    for (const id of lineage) {
      delete chats[id]
    }
    // A pin an older build wrote under a later /clear id of this chat (found from its root).
    for (const id of Object.keys(chats)) {
      if (!id.startsWith('terminal:') && canonicalClaudeChatId(id) === root) {
        delete chats[id]
      }
    }
    if (accountId) {
      chats[root] = accountId
    }
  })
}

const normalized = new WeakSet<ClaudeChatAccountPins>()

/** Once per process, once records are readable: re-key pins older builds wrote under a chat's
 *  current id to its /clear root. Of several ids of one chat, the newest (longest lineage) wins. */
export function normalizeLegacyClaudeChatPins(pins: ClaudeChatAccountPins): void {
  if (normalized.has(pins)) {
    return
  }
  const moves = new Map<string, { id: string; depth: number }>()
  for (const id of Object.keys(pins.all())) {
    if (id.startsWith('terminal:')) {
      continue
    }
    const lineage = chatLineage(id)
    if (lineage === null) {
      // Records not loaded yet: try again on a later read.
      return
    }
    const root = lineage.at(-1) ?? id
    const best = moves.get(root)
    if (!best || lineage.length > best.depth) {
      moves.set(root, { id, depth: lineage.length })
    }
  }
  normalized.add(pins)
  const legacy = [...moves.entries()].filter(([root, { id }]) => root !== id)
  const strays = Object.keys(pins.all()).filter(
    (id) => !id.startsWith('terminal:') && moves.get(canonicalClaudeChatId(id))?.id !== id
  )
  if (legacy.length === 0 && strays.length === 0) {
    return
  }
  try {
    pins.update((chats) => {
      const chosen = new Map([...moves].map(([root, { id }]) => [root, chats[id]]))
      for (const id of Object.keys(chats)) {
        if (!id.startsWith('terminal:')) {
          delete chats[id]
        }
      }
      for (const [root, accountId] of chosen) {
        if (accountId) {
          chats[root] = accountId
        }
      }
    })
  } catch {
    // Unwritable: reads still find legacy keys through the lineage walk.
  }
}

/** Orchestration: the coordinator chat that dispatched this worker chat (both canonical), if any.
 *  Several ids name one coordinator when it may be pinned under either (Orca session id, then
 *  `terminal:<pane>`); terminal workers are looked up as `terminal:<pane>`. */
type CoordinatorLookup = (canonicalOrcaSessionId: string) => string | readonly string[] | null
let coordinatorLookup: CoordinatorLookup | undefined

export function installClaudeChatCoordinatorLookup(lookup: CoordinatorLookup | undefined): void {
  coordinatorLookup = lookup
}

export type ClaudeChatAccountSource = 'pin' | 'coordinator' | 'global'

/** Precedence: the chat's own pin, then its coordinator's pin, then the global selection (null).
 *  A pin naming a removed account counts as no pin. */
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
  // Most hosts pin nothing: answer without lineage or orchestration lookups.
  if (!pins.hasAny()) {
    return null
  }
  normalizeLegacyClaudeChatPins(pins)
  const knownAccountIds = router.listAccounts().map((account) => account.id)
  const pinned = readClaudeChatPin(pins, orcaSessionId)
  // A stale own pin (removed account) still lets a coordinator's pin apply.
  const coordinatorPinned =
    pinned && knownAccountIds.includes(pinned)
      ? null
      : inheritedCoordinatorPin(pins, canonicalClaudeChatId(orcaSessionId), knownAccountIds)
  return resolveClaudeChatAccount({ pinned, coordinatorPinned, knownAccountIds })
}

/** How many coordinator levels a worker looks up for a pin (worker, its coordinator's coordinator…). */
const MAX_COORDINATOR_DEPTH = 8

function inheritedCoordinatorPin(
  pins: Pick<ClaudeChatAccountPins, 'get'>,
  worker: string,
  knownAccountIds: readonly string[]
): string | null {
  if (!coordinatorLookup) {
    return null
  }
  const seen = new Set([worker])
  let current = worker
  try {
    for (let depth = 0; depth < MAX_COORDINATOR_DEPTH; depth++) {
      const found = coordinatorLookup(current)
      const candidates = (typeof found === 'string' ? [found] : (found ?? [])).filter(
        (id) => !seen.has(id)
      )
      if (candidates.length === 0) {
        return null
      }
      for (const coordinator of candidates) {
        const pin = readClaudeChatPin(pins, coordinator)
        if (pin && knownAccountIds.includes(pin)) {
          return pin
        }
        seen.add(coordinator)
      }
      current = candidates[0]
    }
  } catch {
    // Orchestration unreadable: nothing to inherit.
  }
  return null
}

/** The account a terminal pane's Claude launches under: the pane's own pin, else its coordinator's
 *  (orchestration worker panes), else null for the global selection. */
export function pinnedClaudeAccountForTerminal(
  router: { pointerPath: string; listAccounts(): readonly ClaudeManagedAccount[] },
  paneKey: string
): { accountId: string; source: Exclude<ClaudeChatAccountSource, 'global'> } | null {
  const pins = claudeChatAccountPinsFor(router)
  if (!pins.hasAny()) {
    return null
  }
  const knownAccountIds = router.listAccounts().map((account) => account.id)
  const key = terminalChatPinKey(paneKey)
  const pinned = pins.get(key)
  const coordinatorPinned =
    pinned && knownAccountIds.includes(pinned)
      ? null
      : inheritedCoordinatorPin(pins, key, knownAccountIds)
  return resolveClaudeChatAccount({ pinned, coordinatorPinned, knownAccountIds })
}

export function claudeAccountLabel(account: Pick<ClaudeManagedAccount, 'id' | 'email'>): string {
  return account.email || account.id
}

/** Exact match only: the account id, its full email, or its label; case-insensitive. */
export function matchClaudeAccount<T extends Pick<ClaudeManagedAccount, 'id' | 'email'>>(
  accounts: readonly T[],
  query: string
): T | { ambiguous: T[] } | null {
  const q = query.trim().toLowerCase()
  if (!q) {
    return null
  }
  const matches = accounts.filter(
    (account) =>
      account.id.toLowerCase() === q ||
      (account.email !== '' && account.email.toLowerCase() === q) ||
      claudeAccountLabel(account).toLowerCase() === q
  )
  if (matches.length === 1) {
    return matches[0]
  }
  return matches.length > 1 ? { ambiguous: matches } : null
}
