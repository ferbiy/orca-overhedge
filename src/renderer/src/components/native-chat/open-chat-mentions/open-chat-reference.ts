// Overhedge: what an "Open chats" mention tells the agent on send. See OVERHEDGE.md, "Chat
// mentions of open chats".
//
// An open chat is mentioned with upstream's agent pill (`nativeChatAgentReference`); its
// `hostKey` attribute, opaque to upstream (it only tells pills apart), carries what the routing
// note needs: where the chat runs as seen from the chat that mentions it, and what it is.
import { z } from 'zod'
import { lazyZodSchema } from '../../../../../shared/schema/lazy-zod-schema'
import { printableAgentLabel } from '../../../../../shared/orchestration/mailbox/orchestration-agent-reference'

const HOST_KEY_PREFIX = 'open-chat:'

export type OpenChatPillFacts = {
  /** The host the chat runs on: `local` or `runtime:<environmentId>`, as the composer's app sees it. */
  host: string
  /** `--on <server>` for a chat on another host than the sender; absent on the sender's own. */
  on?: string
  /** Where it runs, as a person reads it (`this Mac`, `orca-ide`). */
  hostLabel: string
  workspace: string
  kind: 'chat' | 'terminal'
  agent: string | null
  /** The Claude Code session name a Claude on the sender's machine can SendMessage while the
   *  chat's Claude runs: set only when it is the user-given name and on the same machine. */
  peer?: string
}

export function encodeOpenChatHostKey(facts: OpenChatPillFacts): string {
  return `${HOST_KEY_PREFIX}${JSON.stringify(facts)}`
}

const pillFacts = lazyZodSchema(() =>
  z.object({
    host: z.string().min(1),
    on: z.string().min(1).optional(),
    hostLabel: z.string().optional(),
    workspace: z.string().optional(),
    kind: z.enum(['chat', 'terminal']),
    agent: z.string().nullable().optional(),
    peer: z.string().min(1).optional()
  })
)

/** The facts an open chat's pill carries; null for any other pill (a crew agent's). */
export function decodeOpenChatHostKey(hostKey: string): OpenChatPillFacts | null {
  if (!hostKey.startsWith(HOST_KEY_PREFIX)) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(hostKey.slice(HOST_KEY_PREFIX.length))
  } catch {
    return null
  }
  const parsed = pillFacts.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  const { on, peer, ...facts } = parsed.data
  return {
    host: facts.host,
    ...(on ? { on } : {}),
    hostLabel: facts.hostLabel ?? facts.host,
    workspace: facts.workspace ?? '',
    kind: facts.kind,
    agent: facts.agent ?? null,
    ...(peer ? { peer } : {})
  }
}

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode'
}

/** `Claude chat`, `Codex chat`, `Claude terminal`: what kind of agent the mention names. */
export function openChatKindLabel(kind: 'chat' | 'terminal', agent: string | null): string {
  const name = agent ? (AGENT_NAMES[agent] ?? agent) : null
  if (kind === 'terminal') {
    return name ? `${name} terminal` : 'agent terminal'
  }
  return name ? `${name} chat` : 'chat'
}

function quoted(text: string): string {
  return `"${printableAgentLabel(text).replace(/[\\"]/g, '\\$&')}"`
}

// A shell word: `--on` and session names are quoted when they hold anything else.
function shellWord(text: string): string {
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

/** The routing line an open chat's mention adds to the sent message, or null when the pill is not
 *  an open chat's (upstream's own note then applies). `label` is the pill's label as the body
 *  spells it, already framed by upstream (escaped, clashing labels numbered). */
export function openChatReferenceNote(
  label: string,
  reference: { address: string; hostKey: string }
): string | null {
  const facts = decodeOpenChatHostKey(reference.hostKey)
  if (!facts) {
    return null
  }
  const where = [
    openChatKindLabel(facts.kind, facts.agent),
    facts.workspace ? `in workspace ${quoted(facts.workspace)}` : null,
    facts.on ? `on the paired Orca server ${facts.hostLabel}` : 'on this machine'
  ]
    .filter(Boolean)
    .join(' ')
  const send = [
    'orca orchestration send',
    `--to ${reference.address}`,
    facts.on ? `--on ${shellWord(facts.on)}` : null,
    '--subject "<topic>" --body "<message>"'
  ]
    .filter(Boolean)
    .join(' ')
  const peer = facts.peer
    ? `; while its Claude runs it is also the Claude Code session ${quoted(facts.peer)} here, so SendMessage to ${quoted(facts.peer)} reaches it too`
    : ''
  return `[Orca chat "${label}" (${where}): ${reference.address} \u2014 message it with ${send}${peer}]`
}
