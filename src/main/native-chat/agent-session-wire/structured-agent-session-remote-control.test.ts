import { describe, expect, it, vi } from 'vitest'
import { ClaudeRemoteControlRegistry } from '../../claude/claude-remote-control'
import {
  createRemoteControlNoteWriter,
  interceptRemoteControlSend,
  remoteControlCommandOf,
  REMOTE_CONTROL_ROW_PREFIX
} from './structured-agent-session-remote-control'

const send = (blocks: unknown[], sessionId = 's') => ({ envelope: { sessionId }, body: { blocks } })
const text = (value: string) => ({ type: 'text', text: value })

describe('remoteControlCommandOf', () => {
  it('reads only a lone text block', () => {
    expect(remoteControlCommandOf(send([text('/rc')]))).toEqual({ action: 'enable' })
    expect(remoteControlCommandOf(send([text('/rc'), text('more')]))).toBeNull()
    expect(remoteControlCommandOf(send([{ type: 'image', text: '/rc' }]))).toBeNull()
    expect(remoteControlCommandOf(send([text('hi')]))).toBeNull()
  })
})

describe('interceptRemoteControlSend', () => {
  it('leaves other messages and other agents alone', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    const note = vi.fn(async () => true)
    const claude = { sessionAgent: () => 'claude', remoteControlNote: note }
    await expect(interceptRemoteControlSend(claude, send([text('hello')]), registry)).resolves.toBeNull()
    const codex = { sessionAgent: () => 'codex', remoteControlNote: note }
    await expect(interceptRemoteControlSend(codex, send([text('/rc')]), registry)).resolves.toBeNull()
    expect(note).not.toHaveBeenCalled()
  })

  it('toggles, writes a row and refuses the send', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    registry.observeConnection('s', {
      remoteControl: async () => ({ session_url: 'https://claude.ai/code/x' }),
      initializationResult: async () => ({})
    })
    const note = vi.fn(async () => true)
    const result = await interceptRemoteControlSend(
      { sessionAgent: () => 'claude', remoteControlNote: note },
      send([text('/remote-control')]),
      registry
    )
    expect(result).toMatchObject({ ok: false, refusal: { code: 'structured_agent_session_unsupported' } })
    expect(note).toHaveBeenCalledWith('s', {
      text: expect.stringContaining('https://claude.ai/code/x')
    })
  })
})

describe('createRemoteControlNoteWriter', () => {
  it('appends a thread status row under the current fence', async () => {
    const appendItem = vi.fn(async () => ({}) as never)
    const registry = new ClaudeRemoteControlRegistry()
    const write = createRemoteControlNoteWriter(
      { get: (id) => (id === 's' ? { journal: { appendItem } } : undefined) },
      () => ({ getConversation: (id) => (id === 's' ? ({ currentFence: 7 } as never) : null) }),
      () => 100,
      registry
    )
    await expect(write('other', { text: 'x' })).resolves.toBe(false)
    await expect(write('s', { text: 'on', tone: 'warning' })).resolves.toBe(true)
    expect(appendItem).toHaveBeenCalledWith(
      { provider: 'orca', clientMessageId: `${REMOTE_CONTROL_ROW_PREFIX}s:100:1` },
      { kind: 'status', text: 'on', tone: 'warning' },
      { fence: 7, turnScope: expect.anything() }
    )
    // Registered so restart notes reach this host.
    await registry.writeNote('s', { text: 'again' })
    expect(appendItem).toHaveBeenCalledTimes(2)
  })
})
