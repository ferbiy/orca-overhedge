// Overhedge: a chat's /clear lineage for per-chat account pins (claude-chat-account-pins.ts).
import { isOrcaSessionId } from '../../../shared/agent-session/identity/orca-session-address'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'

/** Clear edges (successor to predecessor) per lineage revision, as canonical-orca-session-id does. */
const predecessorsByRevision = new WeakMap<object, ReadonlyMap<string, string>>()

function predecessors(
  store: Pick<AgentSessionRecordReader, 'listRecords' | 'lineageRevision'>
): ReadonlyMap<string, string> {
  const revision = store.lineageRevision?.()
  const cached = revision ? predecessorsByRevision.get(revision) : undefined
  if (cached) {
    return cached
  }
  const edges = new Map<string, string>()
  for (const record of store.listRecords()) {
    const next = clearedInto(record)
    if (next) {
      edges.set(next, record.sessionId)
    }
  }
  if (revision) {
    predecessorsByRevision.set(revision, edges)
  }
  return edges
}

/** Newest first, ending at the /clear root; null while the record store is not installed. */
export function claudeChatLineageFrom(
  store: Pick<AgentSessionRecordReader, 'listRecords' | 'lineageRevision'> | null,
  orcaSessionId: string
): readonly string[] | null {
  if (!store) {
    return null
  }
  if (!isOrcaSessionId(orcaSessionId)) {
    return [orcaSessionId]
  }
  const edges = predecessors(store)
  const lineage: string[] = [orcaSessionId]
  const seen = new Set<string>(lineage)
  let prior = edges.get(orcaSessionId)
  // The visited set bounds corrupt chains; valid clear lineage is acyclic.
  while (prior && !seen.has(prior) && isOrcaSessionId(prior)) {
    lineage.push(prior)
    seen.add(prior)
    prior = edges.get(prior)
  }
  return lineage
}

export function claudeChatLineage(orcaSessionId: string): readonly string[] | null {
  return claudeChatLineageFrom(readAgentSessionRecordStore(), orcaSessionId)
}
