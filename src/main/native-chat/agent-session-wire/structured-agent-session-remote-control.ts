// overhedge: `/remote-control` and `/rc` typed in a Claude chat never reach Claude (stream-json
// Claude does not know them). The host toggles Remote Control on the chat's live Claude child and
// answers with a thread status row, which released clients already render.

import {
  claudeRemoteControl,
  parseClaudeRemoteControlCommand,
  type ClaudeRemoteControlCommand,
  type ClaudeRemoteControlNote,
  type ClaudeRemoteControlRegistry
} from '../../claude/claude-remote-control'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { refuseUnclassified } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { acceptedOrcaCommandReply } from './structured-agent-session-orca-notice'

export const REMOTE_CONTROL_ROW_PREFIX = 'overhedge-remote-control:'

type NoteSessions = { get(sessionId: string): { journal: Pick<AgentSessionJournal, 'appendItem'> } | undefined }

/** Bind a host's journals as a place Remote Control notes can land; returns the writer. */
export function createRemoteControlNoteWriter(
  sessions: NoteSessions,
  readStore: () => Pick<AgentSessionRecordStore, 'getConversation'>,
  now: () => number,
  registry: ClaudeRemoteControlRegistry = claudeRemoteControl
): (sessionId: string, note: ClaudeRemoteControlNote) => Promise<boolean> {
  let sequence = 0
  const write = async (sessionId: string, note: ClaudeRemoteControlNote): Promise<boolean> => {
    const session = sessions.get(sessionId)
    const store = readStore()
    if (!session || !store.getConversation(sessionId)) {
      return false
    }
    await session.journal.appendItem(
      {
        provider: 'orca',
        clientMessageId: `${REMOTE_CONTROL_ROW_PREFIX}${sessionId}:${now()}:${++sequence}`
      },
      { kind: 'status', text: note.text, ...(note.tone ? { tone: note.tone } : {}) },
      {
        fence: structuredAgentSessionConversationFence(store, sessionId),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    return true
  }
  registry.addNoteWriter(write)
  return write
}

type SendLike = {
  envelope: { sessionId: string; clientOperationId: string }
  body: { blocks: readonly unknown[] }
}

/** The command when the message is one text block reading `/remote-control …` or `/rc …`. */
export function remoteControlCommandOf(params: SendLike): ClaudeRemoteControlCommand | null {
  const [block, ...rest] = params.body.blocks
  if (rest.length > 0 || block === null || typeof block !== 'object') {
    return null
  }
  const type: unknown = 'type' in block ? block.type : undefined
  const text: unknown = 'text' in block ? block.text : undefined
  return type === 'text' && typeof text === 'string' ? parseClaudeRemoteControlCommand(text) : null
}

export type RemoteControlInterceptHost = {
  sessionAgent: (sessionId: string) => string | null
  appendOrcaNotice: (
    sessionId: string,
    noticeId: string,
    text: string,
    tone?: string
  ) => Promise<{ fence: number; cursor: AgentJournalCursor } | null>
}

/** Null leaves the send untouched. Otherwise the toggle ran, its row is written, and the send is
 *  answered as accepted (like `/account`) so released clients neither show "not sent" nor hand the
 *  text back to the composer. Nothing reaches Claude either way. */
export async function interceptRemoteControlSend(
  host: RemoteControlInterceptHost,
  params: SendLike,
  registry: ClaudeRemoteControlRegistry = claudeRemoteControl
): Promise<AgentSessionMutationResult<AgentSessionSendResult> | null> {
  const command = remoteControlCommandOf(params)
  const { sessionId, clientOperationId } = params.envelope
  if (!command || host.sessionAgent(sessionId) !== 'claude') {
    return null
  }
  const note = await registry.run(sessionId, command)
  const notice = await host
    .appendOrcaNotice(sessionId, `${REMOTE_CONTROL_ROW_PREFIX}${clientOperationId}`, note.text, note.tone)
    .catch(() => null)
  if (notice) {
    return acceptedOrcaCommandReply(clientOperationId, notice)
  }
  return {
    ok: false,
    refusal: refuseUnclassified(
      'structured_agent_session_unsupported',
      `Orca handled ${command.action} Remote Control but could not record its answer in this chat`
    )
  }
}
