import { describe, expect, it } from 'vitest'
import { structuredAgentSessionTabId } from '../agent-session/view/structured-agent-session-projection'
import { listPairedOpenChats } from './open-chat-paired-servers'

const chatPane = (sessionId: string) =>
  `${structuredAgentSessionTabId(sessionId)}:11111111-1111-4111-8111-111111111111`

describe('listPairedOpenChats', () => {
  const rows = [
    {
      address: 'orca_session_id:remote-001',
      kind: 'chat',
      agent: 'claude',
      state: 'working',
      workspace: 'maestro',
      title: 'MAESTRO',
      userName: 'MAESTRO',
      updatedAt: 5
    }
  ]

  it('reads each server, falls back to agent.list on an older Orca, and marks one out of reach', async () => {
    const calls: string[] = []
    const hosts = await listPairedOpenChats({
      servers: async () => [
        { environmentId: 'e1', label: 'orca-ide' },
        { environmentId: 'e2', label: 'old box' },
        { environmentId: 'e3', label: null }
      ],
      call: async (environmentId, method) => {
        calls.push(`${environmentId} ${method}`)
        if (environmentId === 'e1') {
          return { hosts: [{ hostId: 'local', chats: [...rows, { address: 'bad' }] }] }
        }
        if (environmentId === 'e2' && method === 'agent.listOpenChats') {
          throw Object.assign(new Error('Unknown method'), { code: 'method_not_found' })
        }
        if (environmentId === 'e2') {
          return {
            agents: [
              {
                orcaSessionId: 'remote-002',
                kind: 'chat',
                agent: 'codex',
                state: 'done',
                workspace: 'w',
                paneKey: chatPane('remote-002'),
                title: 'Review',
                updatedAt: 3
              },
              {
                orcaSessionId: null,
                kind: 'terminal',
                state: 'done',
                workspace: 'w',
                paneKey: 'x:y',
                updatedAt: 1
              }
            ]
          }
        }
        throw Object.assign(new Error('timed out'), { code: 'timeout' })
      }
    })
    expect(hosts).toEqual([
      {
        hostId: 'runtime:e1',
        environmentId: 'e1',
        label: 'orca-ide',
        selector: 'orca-ide',
        chats: rows
      },
      {
        hostId: 'runtime:e2',
        environmentId: 'e2',
        label: 'old box',
        selector: 'e2',
        legacy: true,
        chats: [
          expect.objectContaining({
            address: 'orca_session_id:remote-002',
            agent: 'codex',
            title: 'Review'
          })
        ]
      },
      { hostId: 'runtime:e3', environmentId: 'e3', selector: 'e3', chats: [], unreachable: true }
    ])
    expect(calls).toEqual([
      'e1 agent.listOpenChats',
      'e2 agent.listOpenChats',
      'e3 agent.listOpenChats',
      'e2 agent.list'
    ])
  })
})
