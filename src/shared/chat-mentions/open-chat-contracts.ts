// Overhedge: chat mentions of open chats (the "Open chats" group of the composer's `@` menu).
// See OVERHEDGE.md, "Chat mentions of open chats".
import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import {
  AGENT_STATUS_STATES,
  type AgentStatusState
} from '../agent-status/contracts/agent-status-types'
import { structuredAgentSessionIdFromTabId } from '../agent-session/view/structured-agent-session-tab-id'
import { parsePaneKey } from '../workspace-layout/stable-pane-id'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../agent-session/identity/orca-session-address'

/** One open chat or agent terminal another chat can mention: what `agent.listOpenChats` returns
 *  for its own host. */
export type OpenChatRow = {
  /** Where mail reaches it: `orca_session_id:<id>` for a chat, its `term_...` handle for a terminal. */
  address: string
  kind: 'chat' | 'terminal'
  agent: string | null
  state: AgentStatusState
  workspace: string
  repo?: string
  /** The Orca title (the chat's name, else its task's). */
  title: string | null
  /** The name the user gave it: an Orca rename or `/rename` of a chat, a `/rename` (or `--name`)
   *  of a terminal Claude. Absent when it only has a title Orca or the agent made up. */
  userName?: string
  /** Set when a live Claude Code session on this host carries `userName` as its session name, so
   *  a Claude here can also reach it with SendMessage. */
  claudePeer?: true
  /** The structured chat session the row's pane shows (the composer's own is left out). */
  chatSessionId?: string
  updatedAt: number
}

/** One host's open chats. `hostId` is `local` for the host that answered, `runtime:<id>` for a
 *  paired server; `legacy` marks a server whose Orca predates `agent.listOpenChats` (no names). */
export type OpenChatHostListing = {
  hostId: string
  environmentId?: string
  label?: string
  /** The `--on` value that reaches this server from the host that listed it. */
  selector?: string
  chats: OpenChatRow[]
  unreachable?: true
  legacy?: true
}

export type OpenChatListResult = { hosts: OpenChatHostListing[] }

export const OPEN_CHAT_LIST_METHOD = 'agent.listOpenChats'

const openChatRow = lazyZodSchema(() =>
  z.object({
    address: z.string().min(1),
    kind: z.enum(['chat', 'terminal']),
    agent: z.string().nullable(),
    state: z.enum(AGENT_STATUS_STATES),
    workspace: z.string(),
    repo: z.string().optional(),
    title: z.string().nullable(),
    userName: z.string().optional(),
    claudePeer: z.literal(true).optional(),
    chatSessionId: z.string().optional(),
    updatedAt: z.number().finite()
  })
)

/** A host's own answer, as another host reads it: rows it lists for hosts beyond it are dropped. */
export const openChatListAnswer = lazyZodSchema(() =>
  z.object({
    hosts: z.array(
      z.object({
        hostId: z.string(),
        chats: z.array(z.unknown())
      })
    )
  })
)

/** The rows of a host's own listing that parse; a bad row is skipped, never the whole host. */
export function openChatRowsOfAnswer(answer: unknown): OpenChatRow[] {
  const parsed = openChatListAnswer.safeParse(answer)
  if (!parsed.success) {
    return []
  }
  const own = parsed.data.hosts.find((host) => host.hostId === 'local')
  return (own?.chats ?? []).flatMap((row) => {
    const result = openChatRow.safeParse(row)
    return result.success ? [result.data] : []
  })
}

// The parts of an `agent.list` row a host that predates `agent.listOpenChats` answers with.
const legacyAgentListAnswer = lazyZodSchema(() =>
  z.object({
    agents: z.array(
      z.object({
        orcaSessionId: z.string().nullable().optional(),
        kind: z.string(),
        agent: z.string().nullable().optional(),
        state: z.enum(AGENT_STATUS_STATES),
        workspace: z.string(),
        repo: z.string().optional(),
        hostId: z.string().optional(),
        paneKey: z.string(),
        title: z.string().nullable().optional(),
        updatedAt: z.number().finite()
      })
    )
  })
)

/** The chat session a pane key shows; null for a terminal agent's pane. */
export function chatSessionIdOfPaneKey(paneKey: string): string | null {
  const tabId = parsePaneKey(paneKey)?.tabId ?? paneKey
  return structuredAgentSessionIdFromTabId(tabId)
}

// A PTY terminal's mail handle, as orchestration send takes it.
const TERMINAL_ADDRESS = /^term_[A-Za-z0-9_-]+$/

/** The address a listed agent is reached at: its Orca session for a chat, its terminal handle for
 *  a terminal (a terminal's Orca session id can't be sent to). Null when it has neither. */
export function openChatAddress(row: {
  kind: 'chat' | 'terminal'
  orcaSessionId?: string | null
  terminalAddress?: string | null
}): string | null {
  if (row.kind === 'terminal') {
    return row.terminalAddress && TERMINAL_ADDRESS.test(row.terminalAddress)
      ? row.terminalAddress
      : null
  }
  return row.orcaSessionId && isOrcaSessionId(row.orcaSessionId)
    ? formatOrcaSessionAddress(row.orcaSessionId)
    : null
}

/** An older host's `agent.list` answer as open chats: chats only (its terminals' handles are not
 *  listed), without user names, and only its own (`local`) rows. */
export function openChatRowsOfLegacyAgentList(answer: unknown): OpenChatRow[] {
  const parsed = legacyAgentListAnswer.safeParse(answer)
  if (!parsed.success) {
    return []
  }
  return parsed.data.agents.flatMap((row): OpenChatRow[] => {
    const chatSessionId = chatSessionIdOfPaneKey(row.paneKey)
    const address =
      row.kind === 'chat' && chatSessionId !== null
        ? openChatAddress({ kind: 'chat', orcaSessionId: row.orcaSessionId })
        : null
    if (!address || (row.hostId ?? 'local') !== 'local') {
      return []
    }
    return [
      {
        address,
        kind: 'chat',
        agent: row.agent ?? null,
        state: row.state,
        workspace: row.workspace,
        ...(row.repo ? { repo: row.repo } : {}),
        title: row.title ?? null,
        ...(chatSessionId ? { chatSessionId } : {}),
        updatedAt: row.updatedAt
      }
    ]
  })
}
