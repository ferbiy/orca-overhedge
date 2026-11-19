// overhedge: `/remote-control` and `/rc` typed in a Claude chat never reach Claude (stream-json
// Claude does not know them). The host toggles Remote Control on the chat's live Claude child and
// answers with a thread status row, which released clients already render.

import {
  parseClaudeRemoteControlCommand,
  type ClaudeRemoteControlCommand
} from '../../claude/claude-remote-control'
import {
  claudeRemoteControl,
  type ClaudeRemoteControlNote,
  type ClaudeRemoteControlRegistry
} from '../../claude/claude-remote-control-registry'
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
import {
  acceptedOrcaCommandReply,
  orcaCommandReplies,
  type OrcaCommandReplyLedger
} from './structured-agent-session-orca-notice'

export const REMOTE_CONTROL_ROW_PREFIX = 'overhedge-remote-control:'

type NoteJournal = Pick<AgentSessionJournal, 'appendItem'>

/** Bind a host's journals as a place Remote Control notes can land; returns the writer. Each note
 *  is published to the chat's open clients, as `appendOrcaNotice` rows are. */
export function createRemoteControlNoteWriter<Journal extends NoteJournal>(
  sessions: { get(sessionId: string): { journal: Journal } | undefined },
  readStore: () => Pick<AgentSessionRecordStore, 'getConversation'>,
  now: () => number,
  registry: ClaudeRemoteControlRegistry = claudeRemoteControl,
  publish?: (sessionId: string, journal: Journal) => void
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
    publish?.(sessionId, session.journal)
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

/** Null leaves the send untouched. Otherwise the send is answered at once as accepted, after its
 *  row is written: the final answer for `status` (or a chat with no running Claude), else "Turning
 *  Remote Control on…", which the same row is revised to once Claude answers. So neither client's
 *  send timeout is reached, and a retried send gets its first answer instead of toggling again.
 *  Nothing reaches Claude either way. */
export async function interceptRemoteControlSend(
  host: RemoteControlInterceptHost,
  params: SendLike,
  registry: ClaudeRemoteControlRegistry = claudeRemoteControl,
  ledger: OrcaCommandReplyLedger = orcaCommandReplies
): Promise<AgentSessionMutationResult<AgentSessionSendResult> | null> {
  const command = remoteControlCommandOf(params)
  const { sessionId, clientOperationId } = params.envelope
  if (!command || host.sessionAgent(sessionId) !== 'claude') {
    return null
  }
  return ledger.once(sessionId, clientOperationId, () =>
    answerRemoteControl(host, sessionId, clientOperationId, command, registry)
  )
}

async function answerRemoteControl(
  host: RemoteControlInterceptHost,
  sessionId: string,
  clientOperationId: string,
  command: ClaudeRemoteControlCommand,
  registry: ClaudeRemoteControlRegistry
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  const rowId = `${REMOTE_CONTROL_ROW_PREFIX}${clientOperationId}`
  const immediate = registry.immediate(sessionId, command)
  const first = immediate ?? registry.pending(command)
  const notice = await host
    .appendOrcaNotice(sessionId, rowId, first.text, first.tone)
    .catch(() => null)
  if (!notice) {
    // Nothing ran: the toggle starts only after its row exists.
    return {
      ok: false,
      refusal: refuseUnclassified(
        'structured_agent_session_unsupported',
        'Orca could not record its answer to /rc in this chat, so Remote Control was not changed'
      )
    }
  }
  if (!immediate) {
    void registry
      .run(sessionId, command)
      .then((note) => host.appendOrcaNotice(sessionId, rowId, note.text, note.tone))
      .catch(() => undefined)
  }
  return acceptedOrcaCommandReply(clientOperationId, notice)
}
