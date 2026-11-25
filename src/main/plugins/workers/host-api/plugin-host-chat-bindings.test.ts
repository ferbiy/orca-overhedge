import { describe, expect, it } from 'vitest'
import { createPluginChatHandlers } from './plugin-host-chat-bindings'
import type { PluginHostServices } from './plugin-host-method-bindings'
import type { PairedRuntimeHosts } from './plugin-chat-paired-runtime'

// overhedge: chat.send is a security boundary: it must reach only a chat open now on a host this
// desktop pairs with, never a terminal agent, a closed chat or a new one, and never run a command.

const CHAT = 'chatSession01'
const SERVER_CHAT = 'serverChat001'
const pane = (sessionId: string) =>
  `structured-agent-session-${sessionId}:11111111-2222-4333-a444-555555555555`
const row = (paneKey: string, kind = 'chat') => ({
  kind,
  agent: 'claude',
  state: 'done',
  workspace: 'ws',
  paneKey,
  title: 'Triage\u202e',
  updatedAt: 1
})

function harness() {
  const sent: { host: string; method: string; params: unknown }[] = []
  const answer = (host: string, method: string, params: unknown): unknown => {
    if (method === 'agent.list') {
      return host === 'local'
        ? {
            agents: [row(pane(CHAT)), row('term-tab:11111111-2222-4333-a444-555555555555', 'terminal')],
            hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:env1', 'ssh:box'] }
          }
        : { agents: [row(pane(SERVER_CHAT))], hostScope: { hostIds: ['local'], omittedHostIds: [] } }
    }
    if (method === 'agentSession.history') {
      return { ok: true, page: { fence: 7 } }
    }
    sent.push({ host, method, params })
    return { ok: true, value: { clientMessageId: 'x', queued: {} } }
  }
  const paired: PairedRuntimeHosts = {
    call: async (env, method, params) => answer(`runtime:${env}`, method, params),
    label: async () => 'orca-ide'
  }
  const services = {
    desktop: {},
    runtimeRpc: async (method: string, params: unknown) => answer('local', method, params)
  } as unknown as PluginHostServices
  const handlers = createPluginChatHandlers(paired)
  const call = async (method: 'chat.list' | 'chat.send', params: unknown) => {
    const prepared = handlers[method].prepare(params)
    if (!prepared.ok) {
      throw new Error(prepared.issue)
    }
    const result = await prepared.execute({
      pluginId: 'ferbiy.clickup-tasks',
      surface: 'worker',
      services,
      scope: { assertActive: () => {} }
    })
    return result?.value
  }
  return { call, sent }
}

describe('chat.list / chat.send', () => {
  it('lists open chats on this computer and the paired server, never terminal agents', async () => {
    const { call } = harness()
    const listed = (await call('chat.list', {})) as { chats: Record<string, unknown>[] }
    expect(listed.chats.map((chat) => [chat.hostId, chat.chatId, chat.title])).toEqual([
      ['local', CHAT, 'Triage'],
      ['runtime:env1', SERVER_CHAT, 'Triage']
    ])
  })

  it('sends into an open chat on its own host as a queued-if-busy user message', async () => {
    const { call, sent } = harness()
    expect(
      await call('chat.send', { chatId: SERVER_CHAT, hostId: 'runtime:env1', text: 'Look at OVH-1' })
    ).toEqual({ status: 'queued' })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      host: 'runtime:env1',
      method: 'agentSession.send',
      params: {
        delivery: 'queue-if-active',
        envelope: { sessionId: SERVER_CHAT, expectedRuntimeFence: 7 },
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Look at OVH-1' }] }
      }
    })
  })

  it('refuses commands, unknown hosts, and chats not open on that host', async () => {
    const { call, sent } = harness()
    await expect(call('chat.send', { chatId: CHAT, hostId: 'local', text: ' /clear' })).rejects.toThrow()
    await expect(call('chat.send', { chatId: CHAT, hostId: 'local', text: 'a\u202eb' })).rejects.toThrow()
    await expect(
      call('chat.send', { chatId: CHAT, hostId: 'runtime:other', text: 'hi' })
    ).rejects.toThrow('no paired Orca server')
    await expect(
      call('chat.send', { chatId: SERVER_CHAT, hostId: 'local', text: 'hi' })
    ).rejects.toThrow('no open chat')
    expect(sent).toEqual([])
  })
})
