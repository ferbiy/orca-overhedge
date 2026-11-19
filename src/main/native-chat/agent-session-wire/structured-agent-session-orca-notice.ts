// Overhedge: an Orca-authored status row in a chat's timeline, for server-side commands such as
// `/account` and `/rc`. Released clients already render `status` rows, so no client change is needed.
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

type OrcaNoticeParts = readonly [
  { conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession> },
  Pick<AgentSessionRecordStore, 'getRecord'>,
  { publishJournal: (sessionId: string, journal: AgentSessionJournal) => void }
]

/** Bound by the host to its lifetime, record store and client delivery. */
export function orcaNotices(parts: () => OrcaNoticeParts) {
  return async (
    sessionId: string,
    noticeId: string,
    text: string,
    tone = 'notice'
  ): Promise<{ fence: number; cursor: AgentJournalCursor } | null> => {
    const [lifetime, store, delivery] = parts()
    const session = await lifetime.conversation(sessionId)
    const record = store.getRecord(sessionId)
    if (!record) {
      return null
    }
    await session.journal.appendItem(
      { provider: 'orca', clientMessageId: noticeId },
      { kind: 'status', tone, text },
      { fence: record.lease.runtimeFence, turnScope: { kind: 'thread' } }
    )
    delivery.publishJournal(sessionId, session.journal)
    return { fence: record.lease.runtimeFence, cursor: session.journal.cursor() }
  }
}

/** Answer for a send Orca handled itself. Released clients treat a refusal as "not sent" and hand
 *  the text back to the composer; a queued-receipt answer with no `submission` reads as recorded,
 *  and its cursor (past the notice row) retires the optimistic echo. */
export function acceptedOrcaCommandReply(
  clientMessageId: string,
  notice: { fence: number; cursor: AgentJournalCursor }
): AgentSessionMutationResult<AgentSessionSendResult> {
  return {
    ok: true,
    replayed: false,
    fence: notice.fence,
    cursor: notice.cursor,
    value: {
      clientMessageId,
      queued: { messageId: clientMessageId, position: 0, state: 'withdrawn' }
    }
  }
}
