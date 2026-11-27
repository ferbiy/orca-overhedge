// Overhedge: the "Open chats" rows of the composer's `@` menu. See OVERHEDGE.md, "Chat mentions
// of open chats".
import StatusIndicator from '@/components/sidebar/workspace-card/surface/StatusIndicator'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import type { OrchestrationAgentReference } from '../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import type { OpenChatHostListing } from '../../../../../shared/chat-mentions/open-chat-contracts'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../../shared/agent-session/identity/orca-session-address'
import type { NativeChatRoomMention } from '../composer/native-chat-composer-types'
import { crewPartyStatus } from '../../orchestration-crew/crew-party-status'
import {
  rankNativeChatCrewMentions,
  type CrewAgentMentions
} from '../../orchestration-crew/native-chat-crew-mentions'
import { encodeOpenChatHostKey, openChatKindLabel } from './open-chat-reference'

const OPEN_CHAT_VALUE = 'open-chat:'
const SEPARATOR = ' · '
/** Bare `@` lists this many open chats (the most recent, named ones first); typing finds the rest. */
export const OPEN_CHATS_SHOWN_BARE = 6

/** A host's open chats as the composer reads them: `sameHost` when the chat being written runs
 *  there too, so mail needs no `--on` and a Claude there can SendMessage its peers. */
export type OpenChatSourceListing = OpenChatHostListing & { sameHost: boolean; hostLabel: string }

/** An `@` menu value that names an open chat. */
export function isOpenChatMentionValue(value: string): boolean {
  return value.startsWith(OPEN_CHAT_VALUE)
}

/** The leading crew-agent values of the `@` menu's agent rows, before its open chats. */
export function crewAgentValueCount(agentValues: readonly string[]): number {
  const index = agentValues.findIndex(isOpenChatMentionValue)
  return index === -1 ? agentValues.length : index
}

type Candidate = {
  value: string
  name: string
  named: boolean
  sameHost: boolean
  updatedAt: number
  workspace: string
  hostLabel: string
  kindLabel: string
  title: string | null
  address: string
  reference: OrchestrationAgentReference
  state: string
  agent: string | null
}

/** The chat being written: left out of its own list. */
export type OpenChatSelf = { sessionId: string }

function isSelf(self: OpenChatSelf, row: { address: string; chatSessionId?: string }): boolean {
  if (row.chatSessionId === self.sessionId) {
    return true
  }
  return isOrcaSessionId(self.sessionId) && row.address === formatOrcaSessionAddress(self.sessionId)
}

function candidatesOf(
  listings: readonly OpenChatSourceListing[],
  self: OpenChatSelf,
  skipAddresses: ReadonlySet<string>
): Candidate[] {
  const candidates: Candidate[] = []
  for (const listing of listings) {
    for (const row of listing.chats) {
      if (isSelf(self, row) || (listing.sameHost && skipAddresses.has(row.address))) {
        continue
      }
      const name = (row.userName ?? row.title ?? '').trim() || row.workspace
      const kindLabel = openChatKindLabel(row.kind, row.agent)
      candidates.push({
        value: `${OPEN_CHAT_VALUE}${listing.hostId}:${row.address}`,
        name,
        named: row.userName !== undefined,
        sameHost: listing.sameHost,
        updatedAt: row.updatedAt,
        workspace: row.workspace,
        hostLabel: listing.hostLabel,
        kindLabel,
        title: row.title,
        address: row.address,
        state: row.state,
        agent: row.agent,
        reference: {
          label: name,
          address: row.address,
          hostKey: encodeOpenChatHostKey({
            host: listing.hostId,
            ...(listing.sameHost || !listing.selector ? {} : { on: listing.selector }),
            hostLabel: listing.hostLabel,
            workspace: row.workspace,
            kind: row.kind,
            agent: row.agent,
            ...(listing.sameHost && row.claudePeer && row.userName ? { peer: row.userName } : {})
          }),
          ...(row.agent ? { agentType: row.agent } : {})
        }
      })
    }
  }
  // This chat's host first, then the user's named chats, then the most recent.
  return candidates.sort(
    (a, b) =>
      Number(b.sameHost) - Number(a.sameHost) ||
      Number(b.named) - Number(a.named) ||
      b.updatedAt - a.updatedAt
  )
}

/** The start of the id an address carries, past `orca_session_id:` and a `claude_`/`term_` prefix. */
function shortId(address: string): string {
  return address
    .slice(address.indexOf(':') + 1)
    .replace(/^[a-z]+_/, '')
    .slice(0, 8)
}

/** The grey words after a row's name. A name shared with another listed chat gets
 *  `workspace · host · agent` (and its id's start, if even that repeats); a unique name only says
 *  what isn't the default: another host, or anything but a Claude chat. */
function notesOf(candidates: readonly Candidate[]): Map<string, string | undefined> {
  const byName = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const key = candidate.name.toLocaleLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), candidate])
  }
  const notes = new Map<string, string | undefined>()
  for (const group of byName.values()) {
    const full = (candidate: Candidate) =>
      [candidate.workspace, candidate.hostLabel, candidate.kindLabel].join(SEPARATOR)
    for (const candidate of group) {
      if (group.length === 1) {
        const parts = [
          candidate.sameHost ? null : candidate.hostLabel,
          candidate.kindLabel === 'Claude chat' ? null : candidate.kindLabel
        ].filter((part): part is string => Boolean(part))
        notes.set(candidate.value, parts.length > 0 ? parts.join(SEPARATOR) : undefined)
        continue
      }
      const text = full(candidate)
      const twin = group.some((other) => other !== candidate && full(other) === text)
      const id = shortId(candidate.address)
      notes.set(candidate.value, twin ? `${text}${SEPARATOR}${id}` : text)
    }
  }
  return notes
}

/** The open chats the `@` menu offers, in the crew agents' shape so upstream's pill, keys and
 *  send serialization take them as they are. `skipAddresses`: agents the crew already lists. */
export function openChatMentions(
  listings: readonly OpenChatSourceListing[],
  self: OpenChatSelf,
  skipAddresses: ReadonlySet<string> = new Set()
): CrewAgentMentions {
  const candidates = candidatesOf(listings, self, skipAddresses)
  const notes = notesOf(candidates)
  const mentions: NativeChatRoomMention[] = []
  const references = new Map<string, OrchestrationAgentReference>()
  for (const candidate of candidates) {
    references.set(candidate.value, candidate.reference)
    const note = notes.get(candidate.value)
    mentions.push({
      key: candidate.value,
      name: candidate.name,
      // Matched by `@` and shown on hover: where it runs, and its Orca title under another name.
      detail: [
        candidate.workspace,
        candidate.hostLabel,
        candidate.kindLabel,
        candidate.title && candidate.title !== candidate.name ? candidate.title : null
      ]
        .filter(Boolean)
        .join(SEPARATOR),
      icon: (
        <AgentTypeIcon agentType={candidate.agent} size={14} className="mt-0.5 size-3.5 shrink-0" />
      ),
      noteIcon: (
        <StatusIndicator
          status={crewPartyStatus({ dot: undefined, status: candidate.state, taskFailed: false })}
          showTooltip={false}
        />
      ),
      ...(note ? { note } : {}),
      // A chat the user never named shows its Orca title, de-emphasised; it can still be picked.
      ...(candidate.named ? {} : { dimmed: true as const })
    })
  }
  return { mentions, references }
}

function wordStarts(text: string, needle: string): boolean {
  const lower = text.toLocaleLowerCase()
  if (lower.startsWith(needle)) {
    return true
  }
  for (let at = lower.indexOf(needle); at > 0; at = lower.indexOf(needle, at + 1)) {
    if (/[\s\-_./:()[\]]/.test(lower[at - 1] ?? '')) {
      return true
    }
  }
  return false
}

/** Open chats for `@query`: by name only (a file path typed after `@` must not pull in a chat
 *  through its workspace), names that start with it first. Bare `@` lists the first few. */
export function rankOpenChatMentions(
  mentions: readonly NativeChatRoomMention[],
  query: string
): string[] {
  const needle = query.trim().toLocaleLowerCase()
  const value = (mention: NativeChatRoomMention) => mention.key ?? mention.name
  if (!needle) {
    return mentions.slice(0, OPEN_CHATS_SHOWN_BARE).map(value)
  }
  const starts = mentions.filter((mention) => mention.name.toLocaleLowerCase().startsWith(needle))
  const words = mentions.filter(
    (mention) => !starts.includes(mention) && wordStarts(mention.name, needle)
  )
  return [...starts, ...words].map(value)
}

/** Upstream's crew ranking for the crew's rows, then the open chats under their own heading. */
export function rankAgentAndOpenChatMentions(
  mentions: readonly NativeChatRoomMention[],
  query: string
): string[] {
  const isOpen = (mention: NativeChatRoomMention) => isOpenChatMentionValue(mention.key ?? '')
  return [
    ...rankNativeChatCrewMentions(
      mentions.filter((mention) => !isOpen(mention)),
      query
    ),
    ...rankOpenChatMentions(mentions.filter(isOpen), query)
  ]
}

/** The crew's mentions with the open chats after them. */
export function withOpenChatMentions(
  crew: CrewAgentMentions,
  open: CrewAgentMentions
): CrewAgentMentions {
  if (open.mentions.length === 0) {
    return crew
  }
  return {
    mentions: [...crew.mentions, ...open.mentions],
    references: new Map([...crew.references, ...open.references])
  }
}
