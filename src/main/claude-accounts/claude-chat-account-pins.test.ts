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

const account = (id: string, email: string) => ({ id, email }) as ClaudeManagedAccount
const TEAM = account('aaaa1111-team', 'team@example.com')
const PERSONAL = account('bbbb2222-personal', 'me@example.com')

let dir: string | undefined
function routerFixture(selected: string | null = TEAM.id) {
  dir = mkdtempSync(join(tmpdir(), 'pins-'))
  return {
    pointerPath: join(dir, 'claude-profiles', 'selected-host'),
    listAccounts: () => [TEAM, PERSONAL],
    selectedProfile: () => (selected ? ({ accountId: selected } as never) : null)
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
      resolveClaudeChatAccount({ pinned: TEAM.id, coordinatorPinned: PERSONAL.id, knownAccountIds: known })
    ).toEqual({ accountId: TEAM.id, source: 'pin' })
  })
  it('inherits the coordinator pin when the chat has none', () => {
    expect(
      resolveClaudeChatAccount({ pinned: null, coordinatorPinned: PERSONAL.id, knownAccountIds: known })
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
    const switched = { ...deps, router: { ...router, selectedProfile: () => ({ accountId: PERSONAL.id }) as never } }
    expect(claudeChatAccount(switched, { sessionId: 'pinned', provider: 'claude' }).source).toBe('pin')
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
  it.each(['/accounts', '/account a b', '/migrate', '/account x --with-workers', 'hi /account', '/accountx'])(
    'ignores %s',
    (text) => {
      expect(parseAccountSlashCommand(text)).toBeNull()
    }
  )
  it('matches accounts by email local part, id prefix and email', () => {
    expect(matchClaudeAccount([TEAM, PERSONAL], 'team')).toBe(TEAM)
    expect(matchClaudeAccount([TEAM, PERSONAL], 'bbbb')).toBe(PERSONAL)
    expect(matchClaudeAccount([TEAM, PERSONAL], 'ME@example.com')).toBe(PERSONAL)
    expect(matchClaudeAccount([TEAM, PERSONAL], 'zzz')).toBeNull()
  })
})
