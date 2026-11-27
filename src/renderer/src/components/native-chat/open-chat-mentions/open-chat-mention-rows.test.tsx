import { describe, expect, it } from 'vitest'
import type { OpenChatRow } from '../../../../../shared/chat-mentions/open-chat-contracts'
import {
  crewAgentValueCount,
  openChatMentions,
  rankAgentAndOpenChatMentions,
  type OpenChatSourceListing
} from './open-chat-mention-rows'
import { decodeOpenChatHostKey } from './open-chat-reference'

const row = (address: string, extra: Partial<OpenChatRow> = {}): OpenChatRow => ({
  address,
  kind: 'chat',
  agent: 'claude',
  state: 'done',
  workspace: 'maestro',
  title: null,
  updatedAt: 1,
  ...extra
})

const mac = (chats: OpenChatRow[]): OpenChatSourceListing => ({
  hostId: 'local',
  chats,
  sameHost: true,
  hostLabel: 'this Mac'
})
const server = (chats: OpenChatRow[]): OpenChatSourceListing => ({
  hostId: 'runtime:e1',
  environmentId: 'e1',
  label: 'orca-ide',
  selector: 'orca-ide',
  chats,
  sameHost: false,
  hostLabel: 'orca-ide'
})

const SELF = { sessionId: 'self-chat-01' }

describe('openChatMentions', () => {
  it('names chats by their user-given name, falls back to the Orca title de-emphasised, and leaves out this chat and the crew', () => {
    const { mentions, references } = openChatMentions(
      [
        mac([
          row('orca_session_id:self-chat-01', { userName: 'me', chatSessionId: 'self-chat-01' }),
          row('orca_session_id:crew-0001', { userName: 'worker' }),
          row('orca_session_id:auto-0001', { title: 'Investigate the API', updatedAt: 9 }),
          row('orca_session_id:named-001', { title: 'maestro', userName: 'maestro', updatedAt: 2 })
        ])
      ],
      SELF,
      new Set(['orca_session_id:crew-0001'])
    )
    expect(mentions.map((mention) => [mention.name, mention.dimmed ?? false])).toEqual([
      ['maestro', false],
      ['Investigate the API', true]
    ])
    expect(references.get(mentions[0]!.key!)).toMatchObject({
      label: 'maestro',
      address: 'orca_session_id:named-001',
      agentType: 'claude'
    })
  })

  it("routes a server's chat with --on and gives a SendMessage name only on the same host", () => {
    const { mentions, references } = openChatMentions(
      [
        mac([row('orca_session_id:local-001', { userName: 'paper', claudePeer: true })]),
        server([row('orca_session_id:remote-01', { userName: 'MAESTRO', claudePeer: true })])
      ],
      SELF
    )
    const facts = mentions.map((mention) =>
      decodeOpenChatHostKey(references.get(mention.key!)!.hostKey)
    )
    expect(facts).toEqual([
      expect.objectContaining({ host: 'local', peer: 'paper' }),
      expect.objectContaining({ host: 'runtime:e1', on: 'orca-ide', hostLabel: 'orca-ide' })
    ])
    expect(facts[0]).not.toHaveProperty('on')
    expect(facts[1]).not.toHaveProperty('peer')
    // A unique name only notes what is not the default: another host.
    expect(mentions.map((mention) => mention.note)).toEqual([undefined, 'orca-ide'])
  })

  it('tells duplicate names apart by workspace, host and agent, then by id', () => {
    const { mentions } = openChatMentions(
      [
        mac([
          row('orca_session_id:claude_aaaa1111_x', { userName: 'maestro', updatedAt: 3 }),
          row('orca_session_id:dup-00002', {
            userName: 'Maestro',
            workspace: 'api',
            agent: 'codex',
            updatedAt: 2
          }),
          row('orca_session_id:claude_bbbb2222_x', { userName: 'maestro', updatedAt: 1 })
        ]),
        server([row('term_server1', { kind: 'terminal', userName: 'maestro' })])
      ],
      SELF
    )
    expect(mentions.map((mention) => mention.note)).toEqual([
      'maestro · this Mac · Claude chat · aaaa1111',
      'api · this Mac · Codex chat',
      'maestro · this Mac · Claude chat · bbbb2222',
      'maestro · orca-ide · Claude terminal'
    ])
  })
})

describe('rankAgentAndOpenChatMentions', () => {
  const { mentions } = openChatMentions(
    [
      mac([
        row('orca_session_id:rank-0001', { userName: 'maestro' }),
        row('orca_session_id:rank-0002', { userName: 'api review', workspace: 'src' }),
        row('orca_session_id:rank-0003', { userName: 'the maestro bench' })
      ])
    ],
    SELF
  )
  const crew = [{ key: 'crew-agent:a', name: 'maestro worker', icon: null }]

  it('keeps crew agents ahead of open chats and matches open chats by name words only', () => {
    const values = rankAgentAndOpenChatMentions([...crew, ...mentions], 'mae')
    expect(values).toEqual([
      'crew-agent:a',
      'open-chat:local:orca_session_id:rank-0001',
      'open-chat:local:orca_session_id:rank-0003'
    ])
    expect(crewAgentValueCount(values)).toBe(1)
    // A path typed after `@` never pulls a chat in through its workspace.
    expect(rankAgentAndOpenChatMentions(mentions, 'src/')).toEqual([])
  })
})
