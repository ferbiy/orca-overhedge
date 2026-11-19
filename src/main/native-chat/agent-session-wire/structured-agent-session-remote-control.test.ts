import { describe, expect, it, vi } from 'vitest'
import { ClaudeRemoteControlRegistry } from '../../claude/claude-remote-control'
import {
  createRemoteControlNoteWriter,
  interceptRemoteControlSend,
  remoteControlCommandOf,
  REMOTE_CONTROL_ROW_PREFIX
} from './structured-agent-session-remote-control'
import { acceptedOrcaCommandReply } from './structured-agent-session-orca-notice'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { structuredAgentSessionSendEvidence } from '../../../shared/agent-session/requests/structured-agent-session-send-evidence'

const send = (blocks: unknown[], sessionId = 's') => ({
  envelope: { sessionId, clientOperationId: 'op-1' },
  body: { blocks }
})
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
  const cursor: AgentJournalCursor = { epoch: 'e', sequence: 4 }
  const noticeHost = (agent: string) => {
    const appendOrcaNotice = vi.fn(async () => ({ fence: 2, cursor: cursor }))
    return { appendOrcaNotice, host: { sessionAgent: () => agent, appendOrcaNotice } }
  }

  it('leaves other messages and other agents alone', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    const claude = noticeHost('claude')
    await expect(interceptRemoteControlSend(claude.host, send([text('hello')]), registry)).resolves.toBeNull()
    await expect(interceptRemoteControlSend(claude.host, send([text('/account')]), registry)).resolves.toBeNull()
    const codex = noticeHost('codex')
    await expect(interceptRemoteControlSend(codex.host, send([text('/rc')]), registry)).resolves.toBeNull()
    expect(claude.appendOrcaNotice).not.toHaveBeenCalled()
    expect(codex.appendOrcaNotice).not.toHaveBeenCalled()
  })

  it('toggles, writes a row and answers the send as accepted', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    registry.observeConnection('s', {
      remoteControl: async () => ({ session_url: 'https://claude.ai/code/x' }),
      initializationResult: async () => ({})
    })
    const { host, appendOrcaNotice } = noticeHost('claude')
    const result = await interceptRemoteControlSend(host, send([text('/remote-control')]), registry)
    expect(appendOrcaNotice).toHaveBeenCalledWith(
      's',
      `${REMOTE_CONTROL_ROW_PREFIX}op-1`,
      expect.stringContaining('https://claude.ai/code/x'),
      undefined
    )
    expect(result).toEqual(acceptedOrcaCommandReply('op-1', { fence: 2, cursor: cursor }))
    // Same evidence the released client reads: recorded, so the draft does not return.
    if (!result) {
      throw new Error('expected an intercepted reply')
    }
    expect(structuredAgentSessionSendEvidence({ kind: 'result', result })).toEqual({
      kind: 'recorded'
    })
  })

  it('keeps the warning tone when the chat has no live Claude process', async () => {
    const { host, appendOrcaNotice } = noticeHost('claude')
    const result = await interceptRemoteControlSend(host, send([text('/rc')]), new ClaudeRemoteControlRegistry())
    expect(appendOrcaNotice).toHaveBeenCalledWith('s', expect.any(String), expect.any(String), 'warning')
    expect(result?.ok).toBe(true)
  })

  it('refuses only when no row could be written', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    for (const appendOrcaNotice of [
      async () => null,
      async () => {
        throw new Error('no conversation')
      }
    ]) {
      const host = { sessionAgent: () => 'claude', appendOrcaNotice }
      const result = await interceptRemoteControlSend(host, send([text('/rc status')]), registry)
      expect(result).toMatchObject({
        ok: false,
        refusal: { code: 'structured_agent_session_unsupported' }
      })
    }
  })
})

describe('createRemoteControlNoteWriter', () => {
  it('appends a thread status row under the current fence', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writer ignores the appended item.
    const appendItem = vi.fn(async () => ({}) as never)
    const registry = new ClaudeRemoteControlRegistry()
    const write = createRemoteControlNoteWriter(
      { get: (id) => (id === 's' ? { journal: { appendItem } } : undefined) },
      () => ({
        getConversation: (id) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writer reads only currentFence.
          id === 's' ? ({ currentFence: 7 } as never) : null
      }),
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
