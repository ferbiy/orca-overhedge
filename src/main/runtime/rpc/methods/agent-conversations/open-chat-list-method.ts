// Overhedge: `agent.listOpenChats`, the composer's "Open chats" mentions. See OVERHEDGE.md,
// "Chat mentions of open chats".
import { defineMethod } from '../../core'
import { OpenChatListParams } from '../../../../../shared/rpc-contract/open-chat-list-params'
import {
  OPEN_CHAT_LIST_METHOD,
  type OpenChatListResult
} from '../../../../../shared/chat-mentions/open-chat-contracts'
import { agentSessionProviderHandleChainHead } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { readAgentSessionRecordStore } from '../../../orchestration/addressing/session-lineage/structured-session-lineage'
import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import { claudeSessionRegistry } from '../../../../chat-mentions/claude-session-registry'
import { projectOpenChats } from '../../../../chat-mentions/open-chat-list'

// As `agent.list`: every workspace's open agents, so no workspace page hides one.
const OPEN_CHAT_WORKTREE_LIMIT = 10_000

/** This host's own open chats; the desktop reads each paired server's from that server.
 *  Read-only: never sends to, starts or wakes an agent. */
export const OPEN_CHAT_METHODS = [
  defineMethod({
    name: OPEN_CHAT_LIST_METHOD,
    permission: 'workspace',
    params: OpenChatListParams,
    handler: async (_params, { runtime }): Promise<OpenChatListResult> => {
      const [ps, claudeSessions] = await Promise.all([
        runtime.getWorktreePs(OPEN_CHAT_WORKTREE_LIMIT, true, false),
        claudeSessionRegistry.bySessionId()
      ])
      const records = readAgentSessionRecordStore()
      const chats = projectOpenChats({
        ps,
        claudeSessions,
        conversation: (sessionId) => {
          const record = records?.getRecord(sessionId)
          if (!record) {
            return null
          }
          const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
          return {
            conversationName: record.conversationName ?? null,
            conversationNameSource: record.conversationNameSource ?? null,
            claudeSessionId: head?.handle.nativeId ?? null
          }
        },
        terminalProviderSessionId: (paneKey) =>
          agentHookServer.getPublicStatusSnapshotForPane(paneKey)[0]?.providerSession?.id ?? null
      })
      return { hosts: [{ hostId: 'local', chats }] }
    }
  })
]
