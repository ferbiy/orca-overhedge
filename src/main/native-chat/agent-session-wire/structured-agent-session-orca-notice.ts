// Overhedge: an Orca-authored status row in a chat's timeline, for server-side commands such as
// `/account`. Released clients already render `status` rows, so no client change is needed.
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

type OrcaNoticeParts = readonly [
  { conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession> },
  Pick<AgentSessionRecordStore, 'getRecord'>,
  { publishJournal: (sessionId: string, journal: AgentSessionJournal) => void }
]

/** Bound by the host to its lifetime, record store and client delivery. */
export function orcaNotices(parts: () => OrcaNoticeParts) {
  return async (sessionId: string, noticeId: string, text: string): Promise<void> => {
    const [lifetime, store, delivery] = parts()
    const session = await lifetime.conversation(sessionId)
    const record = store.getRecord(sessionId)
    if (!record) {
      return
    }
    await session.journal.appendItem(
      { provider: 'orca', clientMessageId: noticeId },
      { kind: 'status', tone: 'notice', text },
      { fence: record.lease.runtimeFence, turnScope: { kind: 'thread' } }
    )
    delivery.publishJournal(sessionId, session.journal)
  }
}
