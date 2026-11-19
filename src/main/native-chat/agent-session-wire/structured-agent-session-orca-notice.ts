// Overhedge: an Orca-authored status row in a chat's timeline, for server-side commands such as
// `/account`. Released clients already render `status` rows, so no client change is needed.
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export async function appendStructuredAgentSessionOrcaNotice(
  deps: {
    conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
    store: Pick<AgentSessionRecordStore, 'getRecord'>
    publish: (sessionId: string, journal: AgentSessionJournal) => void
  },
  sessionId: string,
  noticeId: string,
  text: string,
  tone: 'notice' | 'warning' | 'error' = 'notice'
): Promise<void> {
  const session = await deps.conversation(sessionId)
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    return
  }
  await session.journal.appendItem(
    { provider: 'orca', clientMessageId: noticeId },
    { kind: 'status', tone, text },
    { fence: record.lease.runtimeFence, turnScope: { kind: 'thread' } }
  )
  deps.publish(sessionId, session.journal)
}
