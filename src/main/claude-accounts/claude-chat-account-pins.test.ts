import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  claudeChatAccountPinsFor,
  installClaudeChatCoordinatorLookup,
  matchClaudeAccount,
  pinnedClaudeAccountForChat,
  resolveClaudeChatAccount
} from './claude-chat-account-pins'
import {
  claudeChatAccount,
  parseAccountSlashCommand,
  runClaudeChatMigration,
  type ClaudeChatAccountDeps
} from './claude-chat-account-commands'
import { orderClaudeChatMigration, planClaudeChatMigration } from './claude-chat-account-migration'
import { applyClaudeTerminalPin, pinnedClaudeTerminalHome } from './claude-chat-account-terminal'
import { describeChatAccount } from './claude-chat-account-commands'
import { acceptedAccountCommandReply } from '../runtime/rpc/methods/claude-chat-account-rpc'
import { structuredAgentSessionSendEvidence } from '../../shared/agent-session/requests/structured-agent-session-send-evidence'

const account = (id: string, email: string) => ({ id, email }) as ClaudeManagedAccount
const TEAM = account('aaaa1111-team', 'team@example.com')
const PERSONAL = account('bbbb2222-personal', 'me@example.com')

let dir: string | undefined
function routerFixture(selected: string | null = TEAM.id) {
  dir = mkdtempSync(join(tmpdir(), 'pins-'))
  return {
    pointerPath: join(dir, 'claude-profiles', 'selected-host'),
    listAccounts: () => [TEAM, PERSONAL],
    selectedProfile: () => (selected ? ({ accountId: selected } as never) : null),
    coveredBySystemDefault: () => false,
    accountHome: (id: string) => `/profiles/${id}/home`,
    systemDefaultHome: () => '/home/u/.claude'
  }
}

afterEach(() => {
  installClaudeChatCoordinatorLookup(undefined)
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('pin resolution precedence', () => {
  const known = [TEAM.id, PERSONAL.id]
  it('prefers the chat pin over the coordinator pin', () => {
    expect(
      resolveClaudeChatAccount({
        pinned: TEAM.id,
        coordinatorPinned: PERSONAL.id,
        knownAccountIds: known
      })
    ).toEqual({ accountId: TEAM.id, source: 'pin' })
  })
  it('inherits the coordinator pin when the chat has none', () => {
    expect(
      resolveClaudeChatAccount({
        pinned: null,
        coordinatorPinned: PERSONAL.id,
        knownAccountIds: known
      })
    ).toEqual({ accountId: PERSONAL.id, source: 'coordinator' })
  })
  it('falls back to the global selection (null) without pins or with a removed account', () => {
    expect(
      resolveClaudeChatAccount({ pinned: null, coordinatorPinned: null, knownAccountIds: known })
    ).toBeNull()
    expect(
      resolveClaudeChatAccount({ pinned: 'gone', coordinatorPinned: null, knownAccountIds: known })
    ).toBeNull()
  })
  it('reads pins from disk and inherits through the coordinator lookup', () => {
    const router = routerFixture()
    claudeChatAccountPinsFor(router).set('coord', PERSONAL.id)
    installClaudeChatCoordinatorLookup((id) => (id === 'worker' ? 'coord' : null))
    expect(pinnedClaudeAccountForChat(router, 'worker')).toEqual({
      accountId: PERSONAL.id,
      source: 'coordinator'
    })
    expect(pinnedClaudeAccountForChat(router, 'other')).toBeNull()
  })
})

describe('global switch skips pinned chats', () => {
  it('a pinned chat keeps its account when the global selection changes', () => {
    const router = routerFixture(TEAM.id)
    const deps = { router, records: () => [], orchestrationDb: () => null } as ClaudeChatAccountDeps
    claudeChatAccountPinsFor(router).set('pinned', PERSONAL.id)
    expect(claudeChatAccount(deps, { sessionId: 'pinned', provider: 'claude' }).accountId).toBe(
      PERSONAL.id
    )
    expect(claudeChatAccount(deps, { sessionId: 'free', provider: 'claude' })).toEqual({
      accountId: TEAM.id,
      source: 'global'
    })
    const switched = {
      ...deps,
      router: { ...router, selectedProfile: () => ({ accountId: PERSONAL.id }) as never }
    }
    expect(claudeChatAccount(switched, { sessionId: 'pinned', provider: 'claude' }).source).toBe(
      'pin'
    )
    expect(claudeChatAccount(switched, { sessionId: 'free', provider: 'claude' }).accountId).toBe(
      PERSONAL.id
    )
  })
})

describe('migration ordering', () => {
  it('moves workers before their coordinator, each chat once', () => {
    const steps = planClaudeChatMigration({
      chatIds: ['w1'],
      withWorkersOf: ['coord'],
      workersOf: () => ['w1', 'w2', 'coord'],
      chatsOnAccount: () => []
    })
    expect(steps.map((step) => `${step.role}:${step.orcaSessionId}`)).toEqual([
      'worker:w1',
      'worker:w2',
      'coordinator:coord'
    ])
  })
  it('keeps coordinators last even when listed first', () => {
    expect(
      orderClaudeChatMigration([
        { orcaSessionId: 'c', role: 'coordinator' },
        { orcaSessionId: 'x', role: 'chat' },
        { orcaSessionId: 'w', role: 'worker' }
      ]).map((step) => step.orcaSessionId)
    ).toEqual(['w', 'x', 'c'])
  })
})

describe('dry run', () => {
  it('lists what would move and writes no pins', () => {
    const router = routerFixture(TEAM.id)
    const deps: ClaudeChatAccountDeps = {
      router,
      records: () => [
        { sessionId: 'coord', provider: 'claude' },
        { sessionId: 'w1', provider: 'claude' },
        { sessionId: 'codex', provider: 'codex' }
      ],
      orchestrationDb: () => ({
        db: { prepare: () => ({ all: () => [{ id: 'w1' }, { id: 'codex' }] }) }
      })
    }
    const result = runClaudeChatMigration(deps, {
      to: 'me',
      withWorkersOf: ['coord'],
      dryRun: true
    })
    expect(result.lines).toEqual([
      `Would move 2 chat(s) to me@example.com (${PERSONAL.id}):`,
      '  1. worker      w1  (from team@example.com)',
      '  2. coordinator coord  (from team@example.com)',
      '  skipped codex: not a Claude chat-UI session on this host'
    ])
    expect(claudeChatAccountPinsFor(router).all()).toEqual({})
    runClaudeChatMigration(deps, { to: 'me', withWorkersOf: ['coord'] })
    expect(claudeChatAccountPinsFor(router).all()).toEqual({ w1: PERSONAL.id, coord: PERSONAL.id })
  })
  it('refuses an unknown target', () => {
    const router = routerFixture()
    const result = runClaudeChatMigration(
      { router, records: () => [], orchestrationDb: () => null },
      { to: 'nobody', chatIds: ['x'] }
    )
    expect(result.ok).toBe(false)
  })
})

describe('slash parsing', () => {
  it.each([
    ['/account', { kind: 'show' }],
    ['  /account  ', { kind: 'show' }],
    ['/account team', { kind: 'move', to: 'team', withWorkers: false }],
    ['/migrate me', { kind: 'move', to: 'me', withWorkers: false }],
    ['/migrate me --with-workers', { kind: 'move', to: 'me', withWorkers: true }]
  ])('%s', (text, expected) => {
    expect(parseAccountSlashCommand(text)).toEqual(expected)
  })
  it.each([
    '/accounts',
    '/account a b',
    '/migrate',
    '/account x --with-workers',
    'hi /account',
    '/accountx'
  ])('ignores %s', (text) => {
    expect(parseAccountSlashCommand(text)).toBeNull()
  })
  it('matches accounts by email local part, id prefix and email', () => {
    expect(matchClaudeAccount([TEAM, PERSONAL], 'team')).toBe(TEAM)
    expect(matchClaudeAccount([TEAM, PERSONAL], 'bbbb')).toBe(PERSONAL)
    expect(matchClaudeAccount([TEAM, PERSONAL], 'ME@example.com')).toBe(PERSONAL)
    expect(matchClaudeAccount([TEAM, PERSONAL], 'zzz')).toBeNull()
  })
})

describe('accepted reply for an intercepted command', () => {
  it('reads as recorded to a released client, so nothing returns to the composer', () => {
    const reply = acceptedAccountCommandReply('msg-1', {
      fence: 3,
      cursor: { epoch: 'e', sequence: 9 } as never
    })
    expect(structuredAgentSessionSendEvidence({ kind: 'result', result: reply })).toEqual({
      kind: 'recorded'
    })
    expect(reply.ok && reply.cursor).toEqual({ epoch: 'e', sequence: 9 })
    expect(reply.ok && 'submission' in reply.value).toBe(false)
  })
})

describe('terminal pins', () => {
  it('sets the pinned config dir without the follow-the-switch marker', () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('terminal:tab1:leaf1', PERSONAL.id)
    const home = pinnedClaudeTerminalHome(router, 'tab1:leaf1')
    expect(home).toBe(`/profiles/${PERSONAL.id}/home`)
    expect(pinnedClaudeTerminalHome(router, 'tab1:other')).toBeNull()
    expect(pinnedClaudeTerminalHome(router, 'tab1:leaf1', { runtime: 'wsl' } as never)).toBeNull()
    const global = {
      ORCA_CLAUDE_PROFILE_POINTER: '/p',
      CLAUDE_CONFIG_DIR: '/team',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/team'
    }
    const applied = applyClaudeTerminalPin(home, global, {
      configDir: '/team',
      envPatch: global,
      provenance: 'profile:team'
    } as never)
    expect(applied.env).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: '/p', CLAUDE_CONFIG_DIR: home })
    expect(applied.auth?.envPatch).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: '/p', CLAUDE_CONFIG_DIR: home })
    expect(applied.auth?.configDir).toBe(home)
    expect(applyClaudeTerminalPin(null, global, null).env).toBe(global)
  })
  it('migrate pins a terminal pane and prints the resume command for it', () => {
    const router = routerFixture(TEAM.id)
    const result = runClaudeChatMigration(
      {
        router,
        records: () => [],
        orchestrationDb: () => null,
        terminals: () => [{ paneKey: 'tab1:leaf1', claudeSessionId: 'sess-1' }]
      },
      { to: 'me', chatIds: ['terminal:tab1:leaf1'] }
    )
    expect(claudeChatAccountPinsFor(router).get('terminal:tab1:leaf1')).toBe(PERSONAL.id)
    expect(result.lines.at(-1)).toBe(
      `  terminal tab1:leaf1: when idle, type /exit, then run: CLAUDE_CONFIG_DIR='/profiles/${PERSONAL.id}/home' claude --resume 'sess-1'`
    )
  })
})

describe('stale pins', () => {
  it('/account says the pin points at a removed account', () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('chat', 'removed-account')
    const text = describeChatAccount(
      { router, records: () => [], orchestrationDb: () => null },
      { sessionId: 'chat', provider: 'claude' },
      [TEAM, PERSONAL]
    )
    expect(text.split('\n')[0]).toContain('pinned to account removed-account, which no longer exists')
    expect(text).toContain('team@example.com (follows the global selection)')
  })
})
