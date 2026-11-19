import { describe, expect, it, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import {
  ClaudeRemoteControlRegistry,
  claudeQueryRemoteControl,
  parseClaudeRemoteControlCommand,
  withClaudeRemoteControlCommands,
  type ClaudeRemoteControlConnection
} from './claude-remote-control'
import { createClaudeControlSurface } from './claude-agent-sdk-control-requests'
import type { AgentSessionSlashCommand } from '../../shared/agent-session/agent-session-wire'

describe('parseClaudeRemoteControlCommand', () => {
  it('reads the command forms', () => {
    expect(parseClaudeRemoteControlCommand('/remote-control')).toEqual({ action: 'enable' })
    expect(parseClaudeRemoteControlCommand('  /rc  ')).toEqual({ action: 'enable' })
    expect(parseClaudeRemoteControlCommand('/rc on')).toEqual({ action: 'enable' })
    expect(parseClaudeRemoteControlCommand('/rc off')).toEqual({ action: 'disable' })
    expect(parseClaudeRemoteControlCommand('/remote-control STOP')).toEqual({ action: 'disable' })
    expect(parseClaudeRemoteControlCommand('/rc status')).toEqual({ action: 'status' })
    expect(parseClaudeRemoteControlCommand('/rc My laptop chat')).toEqual({
      action: 'enable',
      name: 'My laptop chat'
    })
  })

  it('ignores anything else', () => {
    expect(parseClaudeRemoteControlCommand('/rcx')).toBeNull()
    expect(parseClaudeRemoteControlCommand('please /rc')).toBeNull()
    expect(parseClaudeRemoteControlCommand('/remote')).toBeNull()
    expect(parseClaudeRemoteControlCommand('hello')).toBeNull()
  })
})

type FakeQueryMembers = { enableRemoteControl?: (...args: unknown[]) => Promise<unknown> }

function fakeQuery(members: FakeQueryMembers): Query {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the surface reads only the members a test supplies.
  return members as unknown as Query
}

describe('claudeQueryRemoteControl', () => {
  it('is null when the SDK lacks the method', () => {
    expect(claudeQueryRemoteControl(fakeQuery({}))).toBeNull()
    expect(createClaudeControlSurface(fakeQuery({})).remoteControl).toBeUndefined()
  })

  it('calls enableRemoteControl on the query and wraps failures', async () => {
    const enableRemoteControl = vi.fn(async function (this: unknown) {
      expect(this).toBe(query)
      return { session_url: 'https://claude.ai/code/session_1' }
    })
    const query = fakeQuery({ enableRemoteControl })
    const surface = createClaudeControlSurface(query)
    await expect(surface.remoteControl!(true, 'n')).resolves.toEqual({
      session_url: 'https://claude.ai/code/session_1'
    })
    expect(enableRemoteControl).toHaveBeenCalledWith(true, 'n')
    enableRemoteControl.mockRejectedValueOnce(new Error('boom'))
    await expect(surface.remoteControl!(false)).rejects.toMatchObject({
      name: 'ClaudeControlRequestError',
      subtype: 'remote_control'
    })
  })
})

describe('withClaudeRemoteControlCommands', () => {
  it('adds the commands to a known catalog once, only when the child takes the request', () => {
    const live = (commands: AgentSessionSlashCommand[] | undefined, remoteControl?: unknown) => ({
      commands: { commands },
      connection: { remoteControl }
    })
    expect(withClaudeRemoteControlCommands(undefined)).toBeUndefined()
    expect(withClaudeRemoteControlCommands(live(undefined, () => {}))).toBeUndefined()
    const base: AgentSessionSlashCommand[] = [{ name: 'compact', kind: 'command' }]
    expect(withClaudeRemoteControlCommands(live(base))).toBe(base)
    const added = withClaudeRemoteControlCommands(live(base, () => {}))
    expect(added?.map((c) => c.name)).toEqual(['compact', 'remote-control', 'rc'])
    expect(withClaudeRemoteControlCommands(live(added, () => {}))).toBe(added)
  })
})

function fakeConnection(
  remoteControl?: ClaudeRemoteControlConnection['remoteControl'],
  initialization: unknown = { remote_control_available: true }
): ClaudeRemoteControlConnection {
  return {
    ...(remoteControl ? { remoteControl } : {}),
    initializationResult: async () => initialization
  }
}

describe('ClaudeRemoteControlRegistry', () => {
  it('needs a live child', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    await expect(registry.run('s', { action: 'enable' })).resolves.toMatchObject({
      tone: 'warning',
      text: expect.stringContaining('not running')
    })
  })

  it('enables, reports status and disables', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    const remoteControl = vi.fn(async (enabled: boolean) =>
      enabled ? { session_url: 'https://claude.ai/code/session_1' } : {}
    )
    registry.observeConnection('s', fakeConnection(remoteControl))
    const on = await registry.run('s', { action: 'enable', name: 'phone' })
    expect(on.text).toContain('https://claude.ai/code/session_1')
    expect(on.tone).toBeUndefined()
    expect(remoteControl).toHaveBeenCalledWith(true, 'phone', { timeoutMs: 60_000 })
    expect((await registry.run('s', { action: 'status' })).text).toContain('is on')
    expect((await registry.run('s', { action: 'disable' })).text).toContain('off')
    expect(remoteControl).toHaveBeenLastCalledWith(false, undefined, { timeoutMs: 60_000 })
    expect((await registry.run('s', { action: 'status' })).text).toContain('off')
  })

  it('explains an account without Remote Control and an SDK without the request', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    const remoteControl = vi.fn()
    registry.observeConnection('a', fakeConnection(remoteControl, { remote_control_available: false }))
    const refused = await registry.run('a', { action: 'enable' })
    expect(refused).toMatchObject({ tone: 'error', text: expect.stringContaining('API key') })
    expect(remoteControl).not.toHaveBeenCalled()
    registry.observeConnection('b', fakeConnection(undefined))
    expect((await registry.run('b', { action: 'enable' })).text).toContain('Agent SDK too old')
  })

  it('names an unsupported CLI', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    registry.observeConnection(
      's',
      fakeConnection(async () => {
        throw new Error('Unsupported control request subtype: remote_control')
      })
    )
    expect((await registry.run('s', { action: 'enable' })).text).toContain('Update Claude Code')
  })

  it('re-enables on a restarted child and notes it', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    const notes: string[] = []
    registry.addNoteWriter(async (_id, note) => (notes.push(note.text), true))
    registry.observeConnection('s', fakeConnection(async () => ({ session_url: 'u1' })))
    await registry.run('s', { action: 'enable', name: 'kept' })
    const second = vi.fn(async () => ({ session_url: 'u2' }))
    registry.observeConnection('s', fakeConnection(second))
    await vi.waitFor(() => expect(notes).toHaveLength(1))
    expect(second).toHaveBeenCalledWith(true, 'kept', { timeoutMs: 60_000 })
    expect(notes[0]).toContain('u2')
    expect((await registry.run('s', { action: 'status' })).text).toContain('u2')
  })

  it('says Remote Control turned off when the restarted child refuses', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    const notes: { text: string; tone?: string }[] = []
    registry.addNoteWriter(async (_id, note) => (notes.push(note), true))
    registry.observeConnection('s', fakeConnection(async () => ({ session_url: 'u1' })))
    await registry.run('s', { action: 'enable' })
    registry.observeConnection(
      's',
      fakeConnection(async () => {
        throw new Error('nope')
      })
    )
    await vi.waitFor(() => expect(notes).toHaveLength(1))
    expect(notes[0]).toMatchObject({ tone: 'warning', text: expect.stringContaining('turned off') })
    expect((await registry.run('s', { action: 'status' })).text).toContain('off')
  })

  it('does nothing on restart when it was never on', async () => {
    const registry = new ClaudeRemoteControlRegistry()
    const remoteControl = vi.fn()
    registry.observeConnection('s', fakeConnection(remoteControl))
    registry.observeConnection('s', fakeConnection(remoteControl))
    await Promise.resolve()
    expect(remoteControl).not.toHaveBeenCalled()
  })
})
