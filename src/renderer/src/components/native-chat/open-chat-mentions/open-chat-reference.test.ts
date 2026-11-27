import { describe, expect, it } from 'vitest'
import type { JSONContent } from '@tiptap/react'
import { agentReferenceToken } from '../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from '../composer/pickers/native-chat-agent-reference-send'
import {
  decodeOpenChatHostKey,
  encodeOpenChatHostKey,
  openChatReferenceNote,
  type OpenChatPillFacts
} from './open-chat-reference'

const pill = (label: string, address: string, facts: OpenChatPillFacts | string) => ({
  label,
  address,
  hostKey: typeof facts === 'string' ? facts : encodeOpenChatHostKey(facts)
})

/** The message a draft of text and pills sends, as the composer serializes it. */
function send(parts: (string | ReturnType<typeof pill>)[]): string {
  const content: JSONContent[] = parts.map((part) =>
    typeof part === 'string'
      ? { type: 'text', text: part }
      : { type: 'nativeChatAgentReference', attrs: part }
  )
  const text = parts
    .map((part) => (typeof part === 'string' ? part : agentReferenceToken(part)))
    .join('')
  return serializeNativeChatAgentReferences(text, {
    type: 'doc',
    content: [{ type: 'paragraph', content }]
  })
}

const SERVER: OpenChatPillFacts = {
  host: 'runtime:e1',
  on: 'orca-ide',
  hostLabel: 'orca-ide',
  workspace: 'maestro',
  kind: 'chat',
  agent: 'claude'
}

describe('open chat mentions on send', () => {
  it("names a server's chat with its host and the exact --on command", () => {
    expect(
      send(['ask ', pill('MAESTRO', 'orca_session_id:claude_594cc7a4', SERVER), ' to review'])
    ).toBe(
      'ask @MAESTRO to review\n\n' +
        '[Orca chat "MAESTRO" (Claude chat in workspace "maestro" on the paired Orca server orca-ide): ' +
        'orca_session_id:claude_594cc7a4 — message it with orca orchestration send ' +
        '--to orca_session_id:claude_594cc7a4 --on orca-ide --subject "<topic>" --body "<message>"]'
    )
  })

  it('adds the SendMessage name for a live Claude session on the same machine, and numbers clashing labels', () => {
    const here = { ...SERVER, host: 'local', hostLabel: 'this Mac', on: undefined, peer: 'paper' }
    const message = send([
      pill('paper', 'orca_session_id:chat-local1', here),
      ' and ',
      pill('paper', 'term_abc', { ...here, kind: 'terminal', peer: undefined, workspace: '' })
    ])
    expect(message.split('\n')).toEqual([
      '@paper (1) and @paper (2)',
      '',
      '[Orca chat "paper (1)" (Claude chat in workspace "maestro" on this machine): orca_session_id:chat-local1 — ' +
        'message it with orca orchestration send --to orca_session_id:chat-local1 --subject "<topic>" --body "<message>"; ' +
        'while its Claude runs it is also the Claude Code session "paper" here, so SendMessage to "paper" reaches it too]',
      '[Orca chat "paper (2)" (Claude terminal on this machine): term_abc — message it with orca orchestration send ' +
        '--to term_abc --subject "<topic>" --body "<message>"]'
    ])
  })

  it("leaves a crew agent's pill to upstream's note", () => {
    expect(openChatReferenceNote('lead', { address: 'run:abc', hostKey: 'local' })).toBeNull()
    expect(send([pill('lead', 'run:abc', 'local')])).toContain('[Orca agent "lead": run:abc')
  })

  it('round-trips the facts a pill carries and refuses a malformed one', () => {
    expect(decodeOpenChatHostKey(encodeOpenChatHostKey(SERVER))).toEqual(SERVER)
    expect(decodeOpenChatHostKey('open-chat:{"host":"local"}')).toBeNull()
    expect(decodeOpenChatHostKey('open-chat:nope')).toBeNull()
  })
})
