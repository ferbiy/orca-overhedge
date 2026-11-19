// Overhedge: `--account <id|email>` on the CLI commands that start a Claude agent.
import { describe, expect, it, vi } from 'vitest'
import { CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY } from '../shared/account-runtime-capabilities'
import {
  assertClaudeAccountSupported,
  readCliAgentLaunch,
  readCliClaudeAccount
} from './agent-launch-request'
import {
  ORCHESTRATION_WORKER_LAUNCH_HANDLER,
  readWorkerClaudeAccount
} from './handlers/orchestration/worker-launch-handler'
import type { RuntimeClient } from './runtime-client'

const flags = (entries: Record<string, string | boolean>) => new Map(Object.entries(entries))

describe('--account on agent launch and worktree create --agent', () => {
  it('carries the account for a Claude launch', () => {
    expect(
      readCliAgentLaunch(flags({ account: 'me@example.com' }), 'claude', { createsWorktree: false })
    ).toMatchObject({ agent: 'claude', claudeAccount: 'me@example.com' })
    expect(
      readCliAgentLaunch(flags({}), 'claude', { createsWorktree: true }).claudeAccount
    ).toBeUndefined()
  })

  it('refuses --account with another agent before anything is sent', () => {
    expect(() =>
      readCliAgentLaunch(flags({ account: 'me@example.com' }), 'codex', { createsWorktree: true })
    ).toThrow(/--account applies only to --agent claude/)
  })

  it('refuses a valueless --account', () => {
    expect(() => readCliClaudeAccount(flags({ account: true }), 'claude')).toThrow(/--account/)
    expect(() => readCliClaudeAccount(flags({ account: '  ' }), 'claude')).toThrow(/--account/)
  })

  it('refuses a host that would silently drop the account', () => {
    expect(() => assertClaudeAccountSupported('me@example.com', ['agent.launch.v1'])).toThrow(
      /cannot start a Claude chat on a chosen account/
    )
    expect(() => assertClaudeAccountSupported('me@example.com', null)).toThrow()
    expect(() =>
      assertClaudeAccountSupported('me@example.com', [CLAUDE_LAUNCH_ACCOUNT_RUNTIME_CAPABILITY])
    ).not.toThrow()
    expect(() => assertClaudeAccountSupported(undefined, [])).not.toThrow()
  })
})

describe('--account on orchestration worker-start', () => {
  it('reads the account for a Claude or default-agent worker', () => {
    expect(readWorkerClaudeAccount(flags({ account: 'me@example.com' }), undefined)).toBe(
      'me@example.com'
    )
    expect(
      readWorkerClaudeAccount(flags({ account: 'me@example.com', agent: 'claude' }), undefined)
    ).toBe('me@example.com')
  })

  it('refuses another agent, --terminal and --on', () => {
    expect(() =>
      readWorkerClaudeAccount(flags({ account: 'me@example.com', agent: 'codex' }), undefined)
    ).toThrow(/only to --agent claude/)
    expect(() =>
      readWorkerClaudeAccount(flags({ account: 'me@example.com' }), 'term_1')
    ).toThrow(/--terminal/)
    expect(() =>
      readWorkerClaudeAccount(flags({ account: 'me@example.com', on: 'server-2' }), undefined)
    ).toThrow(/--on/)
  })

  it('makes no runtime call when the account is refused', async () => {
    const call = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler must fail before it uses the client.
    const client = { call } as unknown as RuntimeClient
    await expect(
      ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
        flags: flags({ spec: 'do it', agent: 'codex', account: 'me@example.com' }),
        client,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toThrow(/only to --agent claude/)
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a host without the capability before starting anything', async () => {
    const call = vi.fn(async (method: string) =>
      method === 'status.get' ? { result: { capabilities: [] } } : { result: {} }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls status.get before refusing.
    const client = { call } as unknown as RuntimeClient
    await expect(
      ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
        flags: flags({ spec: 'do it', agent: 'claude', account: 'me@example.com' }),
        client,
        cwd: '/tmp',
        json: true
      })
    ).rejects.toThrow(/chosen account/)
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })
})
