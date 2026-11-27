import { describe, expect, it } from 'vitest'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'
import {
  projectOpenChats,
  type OpenChatConversationFacts,
  type OpenChatPsSource
} from './open-chat-list'
import type { ClaudeLiveSession } from './claude-session-registry'

const LEAF = '11111111-1111-4111-8111-111111111111'
const chatPane = (sessionId: string) => `${structuredAgentSessionTabId(sessionId)}:${LEAF}`

type Agent = OpenChatPsSource['worktrees'][number]['agents'][number]
const agent = (row: Partial<Agent> & Pick<Agent, 'paneKey'>): Agent => ({
  state: 'done',
  agentType: 'claude',
  taskTitle: null,
  displayName: null,
  updatedAt: 1,
  ...row
})

const live = (sessionId: string, name: string, nameSource: string): ClaudeLiveSession => ({
  pid: 42,
  sessionId,
  name,
  nameSource
})

function project(
  agents: Agent[],
  records: Record<string, OpenChatConversationFacts> = {},
  sessions: ClaudeLiveSession[] = [],
  terminals: Record<string, string> = {},
  hostId?: OpenChatPsSource['worktrees'][number]['hostId']
) {
  return projectOpenChats({
    ps: { worktrees: [{ displayName: 'maestro', repo: 'maestro', hostId, agents }] },
    conversation: (id) => records[id] ?? null,
    terminalProviderSessionId: (paneKey) => terminals[paneKey] ?? null,
    claudeSessions: new Map(sessions.map((session) => [session.sessionId, session]))
  })
}

describe('projectOpenChats', () => {
  it('names a chat by its user-given name and marks a same-named live Claude session as a peer', () => {
    const rows = project(
      [
        agent({
          paneKey: chatPane('chat-0001'),
          orcaSessionId: 'chat-0001',
          conversationName: 'MAESTRO'
        }),
        agent({
          paneKey: chatPane('chat-0002'),
          orcaSessionId: 'chat-0002',
          conversationName: 'Fix the API'
        })
      ],
      {
        'chat-0001': {
          conversationName: 'MAESTRO',
          conversationNameSource: 'user',
          claudeSessionId: 's1'
        },
        'chat-0002': { conversationName: 'Fix the API', claudeSessionId: 's2' }
      },
      [live('s1', 'MAESTRO', 'auto'), live('s2', 'orca-overhedge-2f', 'derived')]
    )
    expect(rows).toEqual([
      expect.objectContaining({
        address: 'orca_session_id:chat-0001',
        kind: 'chat',
        title: 'MAESTRO',
        userName: 'MAESTRO',
        claudePeer: true,
        chatSessionId: 'chat-0001'
      }),
      expect.objectContaining({ address: 'orca_session_id:chat-0002', title: 'Fix the API' })
    ])
    expect(rows[1]).not.toHaveProperty('userName')
    expect(rows[1]).not.toHaveProperty('claudePeer')
  })

  it('is no peer when the live Claude session carries another name', () => {
    const [row] = project(
      [agent({ paneKey: chatPane('chat-0001'), orcaSessionId: 'chat-0001' })],
      {
        'chat-0001': {
          conversationName: 'maestro',
          conversationNameSource: 'user',
          claudeSessionId: 's1'
        }
      },
      [live('s1', 'maestro-ec', 'collision')]
    )
    expect(row).toMatchObject({ userName: 'maestro' })
    expect(row).not.toHaveProperty('claudePeer')
  })

  it('names a terminal Claude by its /rename and reaches it by terminal handle', () => {
    const rows = project(
      [
        agent({ paneKey: 'tab-a:leaf-a', address: 'term_abc' }),
        agent({ paneKey: 'tab-b:leaf-b', address: 'term_def', displayName: 'worker' }),
        // A terminal with no handle can't be mailed: left out.
        agent({ paneKey: 'tab-c:leaf-c', orcaSessionId: 'chat-0009' })
      ],
      {},
      [live('t1', 'paper', 'user'), live('t2', 'workflow-98', 'derived')],
      { 'tab-a:leaf-a': 't1', 'tab-b:leaf-b': 't2' }
    )
    expect(rows).toEqual([
      expect.objectContaining({
        address: 'term_abc',
        kind: 'terminal',
        userName: 'paper',
        claudePeer: true
      }),
      expect.objectContaining({ address: 'term_def', kind: 'terminal', title: 'worker' })
    ])
    expect(rows[1]).not.toHaveProperty('userName')
  })

  it('leaves out rows for hosts beyond this one', () => {
    expect(
      project(
        [agent({ paneKey: chatPane('chat-0001'), orcaSessionId: 'chat-0001' })],
        {},
        [],
        {},
        'ssh:box'
      )
    ).toEqual([])
  })
})
