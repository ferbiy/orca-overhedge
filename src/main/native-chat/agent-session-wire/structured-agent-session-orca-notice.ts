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
  Pick<AgentSessionRecordStore, 'getRecord' | 'getConversation'>,
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

/** Answer for a send Orca handled itself. A refusal would read as "not sent" and hand the text
 *  back. A queued receipt with no `submission` reads as recorded on desktop (its cursor, past the
 *  notice row, retires the optimistic echo). Its state must not be `withdrawn`, which the released
 *  mobile app reports as "Message not sent"; `dispatched` reads there as handed over (no error, the
 *  echo is dropped and the notice row stays). Desktop does not read the state. */
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
      queued: { messageId: clientMessageId, position: 0, state: 'dispatched' }
    }
  }
}

type OrcaCommandReply = AgentSessionMutationResult<AgentSessionSendResult>

/** Commands Orca answered, by chat and client operation id, so a retried send (a reconnect, a
 *  client retry after a timeout) gets the first answer again instead of running twice. In memory
 *  and bounded: like the host's own ledger it only needs to outlive a client's retry window. */
export class OrcaCommandReplyLedger {
  private readonly replies = new Map<string, Promise<OrcaCommandReply>>()

  constructor(private readonly capacity = 512) {}

  once(
    sessionId: string,
    clientOperationId: string,
    run: () => Promise<OrcaCommandReply>
  ): Promise<OrcaCommandReply> {
    const key = `${sessionId}\u0000${clientOperationId}`
    const earlier = this.replies.get(key)
    if (earlier) {
      return earlier.then((reply) => (reply.ok ? { ...reply, replayed: true } : reply))
    }
    const reply = run()
    this.replies.set(key, reply)
    // Only an answered command is kept; a refused or failed one may be sent again.
    void reply.then(
      (answer) => {
        if (!answer.ok) {
          this.replies.delete(key)
        }
      },
      () => this.replies.delete(key)
    )
    while (this.replies.size > this.capacity) {
      const oldest = this.replies.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.replies.delete(oldest)
    }
    return reply
  }
}

export const orcaCommandReplies = new OrcaCommandReplyLedger()
