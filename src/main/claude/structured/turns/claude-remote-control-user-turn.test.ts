import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { ClaudeStructuredSessionAdapter } from '../claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from '../claude-structured-session-test-support'
import { claudeStartupSettled } from '../startup/claude-structured-startup-settled-test-support'
import { claudeRemoteControl } from '../../remote-control/claude-remote-control-registry'

type Row = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

const opened: string[] = []
afterEach(async () => {
  for (const sessionId of opened.splice(0)) {
    await claudeRemoteControl.run(sessionId, { action: 'disable' })
  }
})

/** A live chat whose Claude child takes the remote_control request, as the CLI does. */
async function liveChat(sessionId: string, remoteControl: boolean) {
  const rows: Row[] = []
  const claude = fakeClaude({ replayUuid: null })
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported',
      continuesChain: false
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1,
    now: () => 1_700_000_200_000,
    persistHandle: async () => {}
  })
  await adapter.acquire({
    identity: identityFor(sessionId),
    fence: 7,
    spawnToken: 'spawn-9',
    events: {
      appendItem: (identity, body) => rows.push({ identity, body }),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  await claudeStartupSettled(adapter, sessionId)
  const connection = claude.connections[0]!
  if (remoteControl) {
    Object.assign(connection, { remoteControl: async () => ({ session_url: 'https://rc.test/s' }) })
    opened.push(sessionId)
    expect((await claudeRemoteControl.run(sessionId, { action: 'enable' })).text).toContain('is on')
  }
  const frame = (message: Record<string, unknown>): void =>
    connection.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  const turns = () => {
    const latest = new Map<string, { state: string; userItemId?: string }>()
    for (const { body } of rows) {
      const turn = readAgentJournalTurn(body)
      if (turn) {
        latest.set(turn.turnId, { state: turn.state, userItemId: turn.userItemId })
      }
    }
    return latest
  }
  const userRows = () => rows.filter(({ body }) => body.kind === 'message' && body.role === 'user')
  return { adapter, connection, frame, turns, userRows }
}

/** What the CLI writes for a prompt typed on the phone: queued over the bridge, then run. */
function remotePrompt(
  frame: (message: Record<string, unknown>) => void,
  uuid: string,
  text: string
) {
  frame({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' })
  frame({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
  frame({ type: 'system', subtype: 'init', uuid: `init-${uuid}` })
  frame({ type: 'system', subtype: 'session_state_changed', state: 'running' })
  frame({
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    isReplay: true,
    timestamp: '2026-11-20T10:00:00.000Z',
    message: { role: 'user', content: text }
  })
}

const assistant = (uuid: string, content: unknown[]) => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { role: 'assistant', content }
})

describe('Remote Control prompts in an Orca chat', () => {
  it('shows the phone prompt as a user row and its reply as a normal turn', async () => {
    const chat = await liveChat('rc-idle', true)
    remotePrompt(chat.frame, 'phone-1', 'What changed today?')
    chat.frame(
      assistant('a-1', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }])
    )
    chat.frame({
      type: 'user',
      uuid: 'r-1',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'a' }]
      }
    })
    chat.frame(assistant('a-2', [{ type: 'text', text: 'Two commits.' }]))
    const userIdentity: AgentJournalItemIdentity = {
      provider: 'claude',
      sessionId: PROVIDER_SESSION_ID,
      uuid: 'phone-1'
    }
    expect(chat.userRows()).toEqual([
      {
        identity: userIdentity,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'What changed today?' }]
        }
      }
    ])
    expect([...chat.turns()]).toEqual([
      ['phone-1', { state: 'running', userItemId: agentJournalItemKey(userIdentity) }]
    ])
    chat.frame({ type: 'result', subtype: 'success', uuid: 'result-1', num_turns: 2 })
    chat.frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
    expect(chat.turns().get('phone-1')?.state).toBe('completed')
    expect(chat.userRows()).toHaveLength(1)
  })

  it('adds no row for an Orca send while Remote Control is on', async () => {
    const chat = await liveChat('rc-own', true)
    await chat.adapter.dispatch({
      sessionId: 'rc-own',
      clientMessageId: 'client-a',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'from orca' }] },
      fence: 7
    })
    const sent = chat.connection.sent.at(-1)!
    // The CLI echoes Orca's send under the uuid Orca gave it.
    chat.frame({ ...sent, isReplay: true, parent_tool_use_id: null })
    chat.frame(assistant('a-own', [{ type: 'text', text: 'ok' }]))
    expect(chat.userRows()).toEqual([])
    expect([...chat.turns().keys()]).toEqual([sent.uuid])
  })

  it('keeps a prompt folded into the running turn in that turn', async () => {
    const chat = await liveChat('rc-fold', true)
    remotePrompt(chat.frame, 'phone-1', 'first')
    chat.frame(assistant('a-1', [{ type: 'text', text: 'Working on it' }]))
    chat.frame({
      type: 'user',
      uuid: 'phone-2',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: 'and also this' }
    })
    chat.frame(assistant('a-2', [{ type: 'text', text: 'Both done' }]))
    expect(chat.userRows().map(({ identity }) => 'uuid' in identity && identity.uuid)).toEqual([
      'phone-1',
      'phone-2'
    ])
    expect([...chat.turns()].map(([id, turn]) => [id, turn.state])).toEqual([
      ['phone-1', 'running']
    ])
  })

  it('leaves CLI-made and attributed replays alone', async () => {
    const chat = await liveChat('rc-other', true)
    const replay = (uuid: string, extra: Record<string, unknown>, content: unknown) =>
      chat.frame({
        type: 'user',
        uuid,
        parent_tool_use_id: null,
        isReplay: true,
        ...extra,
        message: { role: 'user', content }
      })
    replay('meta', { isSynthetic: true }, 'injected')
    replay('peer', { origin: { kind: 'peer', from: 'other' } }, 'peer says hi')
    replay('stdout', {}, '<local-command-stdout>Set model</local-command-stdout>')
    replay('cmd', {}, '<command-name>/goal</command-name>')
    expect(chat.userRows()).toEqual([])
  })

  it('changes nothing while Remote Control is off', async () => {
    const chat = await liveChat('rc-off', false)
    remotePrompt(chat.frame, 'phone-1', 'hello')
    chat.frame(assistant('a-1', [{ type: 'text', text: 'Hi' }]))
    expect(chat.userRows()).toEqual([])
    // Upstream: the reply still opens a turn of its own, with no prompt row.
    expect([...chat.turns().keys()]).toEqual(['a-1'])
  })

  it('lets a permission answered on the phone end the Orca prompt and the turn', async () => {
    const chat = await liveChat('rc-permission', true)
    remotePrompt(chat.frame, 'phone-1', 'delete the build dir')
    chat.frame(
      assistant('a-1', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'rm' } }])
    )
    const controller = new AbortController()
    const answer = chat.connection.handlers.canUseTool!(
      'Bash',
      { command: 'rm' },
      { signal: controller.signal, toolUseID: 'tool-1', requestId: 'perm-1' }
    )
    // Answered over the bridge: the CLI cancels Orca's copy of the request.
    controller.abort()
    await expect(answer).resolves.toBeNull()
    chat.frame(assistant('a-2', [{ type: 'text', text: 'Removed.' }]))
    chat.frame({ type: 'result', subtype: 'success', uuid: 'result-1', num_turns: 2 })
    expect(chat.turns().get('phone-1')?.state).toBe('completed')
  })
})
