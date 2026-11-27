// Overhedge: `agent.listOpenChats`, the rows of the composer's "Open chats" mentions. See
// OVERHEDGE.md, "Chat mentions of open chats".
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  chatSessionIdOfPaneKey,
  openChatAddress,
  type OpenChatRow
} from '../../shared/chat-mentions/open-chat-contracts'
import type { ClaudeLiveSession } from './claude-session-registry'

/** What the chat's record says about its name and its Claude conversation. */
export type OpenChatConversationFacts = {
  conversationName?: string | null
  conversationNameSource?: string | null
  /** The Claude session the chat runs now (its provider handle's head). */
  claudeSessionId?: string | null
}

/** The parts of a `worktree.ps` answer this reads. */
export type OpenChatPsSource = {
  worktrees: readonly (Pick<
    RuntimeWorktreePsSummary,
    'hostId' | 'displayName' | 'repo' | 'workspaceKind'
  > & {
    agents: readonly Pick<
      RuntimeWorktreeAgentRow,
      | 'paneKey'
      | 'address'
      | 'orcaSessionId'
      | 'state'
      | 'agentType'
      | 'taskTitle'
      | 'displayName'
      | 'conversationName'
      | 'updatedAt'
    >[]
  })[]
}

export type OpenChatLocalSources = {
  ps: OpenChatPsSource
  conversation: (chatSessionId: string) => OpenChatConversationFacts | null
  /** The Claude session a terminal agent's pane reported, from its hooks. */
  terminalProviderSessionId: (paneKey: string) => string | null
  claudeSessions: ReadonlyMap<string, ClaudeLiveSession>
}

function userNameOf(name: string | null | undefined, userGiven: boolean): string | undefined {
  const trimmed = name?.trim()
  return userGiven && trimmed ? trimmed : undefined
}

/** This host's open chats and agent terminals, with the names their users gave them. Rows the
 *  host lists for hosts beyond it (its SSH hosts) are left out: mail from here can't name them. */
export function projectOpenChats(sources: OpenChatLocalSources): OpenChatRow[] {
  const rows: OpenChatRow[] = []
  const seen = new Set<string>()
  for (const worktree of sources.ps.worktrees) {
    if ((worktree.hostId ?? 'local') !== 'local') {
      continue
    }
    for (const agent of worktree.agents) {
      const chatSessionId = chatSessionIdOfPaneKey(agent.paneKey)
      const kind = chatSessionId === null ? 'terminal' : 'chat'
      const address = openChatAddress({
        kind,
        orcaSessionId: agent.orcaSessionId,
        terminalAddress: agent.address
      })
      if (!address || seen.has(address)) {
        continue
      }
      seen.add(address)
      let userName: string | undefined
      let claudePeer = false
      if (chatSessionId !== null) {
        const facts =
          sources.conversation(chatSessionId) ??
          (agent.orcaSessionId ? sources.conversation(agent.orcaSessionId) : null)
        userName = userNameOf(facts?.conversationName, facts?.conversationNameSource === 'user')
        const live = facts?.claudeSessionId
          ? sources.claudeSessions.get(facts.claudeSessionId)
          : undefined
        claudePeer = userName !== undefined && live?.name === userName
      } else {
        const providerSessionId = sources.terminalProviderSessionId(agent.paneKey)
        const live = providerSessionId ? sources.claudeSessions.get(providerSessionId) : undefined
        userName = userNameOf(live?.name, live?.nameSource === 'user')
        claudePeer = userName !== undefined
      }
      rows.push({
        address,
        kind,
        agent: agent.agentType ?? null,
        state: agent.state,
        workspace: worktree.displayName,
        ...(worktree.repo && worktree.workspaceKind !== 'folder-workspace'
          ? { repo: worktree.repo }
          : {}),
        title: agent.conversationName ?? agent.displayName ?? agent.taskTitle ?? null,
        ...(userName ? { userName } : {}),
        ...(claudePeer ? { claudePeer: true as const } : {}),
        ...(chatSessionId ? { chatSessionId } : {}),
        updatedAt: agent.updatedAt
      })
    }
  }
  return rows
}
