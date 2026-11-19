import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  installClaudeChatCoordinatorLookup,
  installClaudeChatLineage,
  matchClaudeAccount,
  pinnedClaudeAccountForChat,
  resolveClaudeChatAccount
} from './claude-chat-account-pins'
import { claudeChatAccountPinsFor } from './claude-chat-account-pin-store'
import {
  claudeChatAccount,
  coordinatorOfWorker,
  describeChatAccount,
  runClaudeChatMigration,
  workersOfCoordinator,
  type ClaudeChatAccountDeps
} from './claude-chat-account-commands'
import { parseAccountSlashCommand } from './claude-chat-account-slash'
import { orderClaudeChatMigration, planClaudeChatMigration } from './claude-chat-account-migration'
import { applyClaudeTerminalPin, pinnedClaudeTerminalHome } from './claude-chat-account-terminal'
import { acceptedOrcaCommandReply } from '../native-chat/agent-session-wire/structured-agent-session-orca-notice'
import { structuredAgentSessionSendEvidence } from '../../shared/agent-session/requests/structured-agent-session-send-evidence'

function account(id: string, email: string): ClaudeManagedAccount {
  return {
    id,
    email,
    managedAuthPath: `/profiles/${id}`,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}
const TEAM = account('aaaa1111-team', 'team@example.com')
const PERSONAL = account('bbbb2222-personal', 'me@example.com')

let dir: string | undefined
function routerFixture(selected: string | null = TEAM.id) {
  dir = mkdtempSync(join(tmpdir(), 'pins-'))
  return {
    pointerPath: join(dir, 'claude-profiles', 'selected-host'),
    listAccounts: () => [TEAM, PERSONAL],
    selectedProfile: () => (selected ? { accountId: selected } : null),
    coveredBySystemDefault: () => false,
    accountHome: (id: string) => `/profiles/${id}/home`,
    systemDefaultHome: () => '/home/u/.claude'
  }
}

afterEach(() => {
  installClaudeChatCoordinatorLookup(undefined)
  installClaudeChatLineage(undefined)
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
    const deps: ClaudeChatAccountDeps = { router, records: () => [], orchestrationDb: () => null }
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
      router: { ...router, selectedProfile: () => ({ accountId: PERSONAL.id }) }
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
      to: 'me@example.com',
      withWorkersOf: ['coord'],
      dryRun: true
    })
    expect(result.lines).toEqual([
      `Would move 2 chat(s) to me@example.com (${PERSONAL.id}):`,
      '  1. worker      w1  (from team@example.com)',
      '  2. coordinator coord  (from team@example.com)',
      '  skipped codex: not a Claude chat on this host'
    ])
    expect(claudeChatAccountPinsFor(router).all()).toEqual({})
    runClaudeChatMigration(deps, { to: 'me@example.com', withWorkersOf: ['coord'] })
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
    ['/orca-account', { kind: 'show' }],
    ['  /orca-account  ', { kind: 'show' }],
    ['/orca-account team@example.com', { kind: 'move', to: 'team@example.com', withWorkers: false }],
    ['/orca-account AUTO', { kind: 'unpin', withWorkers: false }],
    ['/orca-migrate me', { kind: 'move', to: 'me', withWorkers: false }],
    ['/orca-migrate me --with-workers', { kind: 'move', to: 'me', withWorkers: true }],
    ['/orca-migrate auto --with-workers', { kind: 'unpin', withWorkers: true }]
  ])('%s', (text, expected) => {
    expect(parseAccountSlashCommand(text)).toEqual(expected)
  })
  it.each([
    '/orca-account a b',
    '/orca-migrate',
    '/orca-account x --with-workers',
    '/orca-migrate --with-workers me',
    '/orca-account\nme'
  ])('answers %s with usage', (text) => {
    expect(parseAccountSlashCommand(text)).toEqual({ kind: 'usage' })
  })
  it.each(['/account', '/account team', '/migrate db', '/orca-accounts', 'hi /orca-account'])(
    'leaves %s to Claude',
    (text) => {
      expect(parseAccountSlashCommand(text)).toBeNull()
    }
  )
  it('matches accounts only exactly, by id or full email', () => {
    expect(matchClaudeAccount([TEAM, PERSONAL], 'ME@example.com')).toBe(PERSONAL)
    expect(matchClaudeAccount([TEAM, PERSONAL], TEAM.id.toUpperCase())).toBe(TEAM)
    expect(matchClaudeAccount([TEAM, PERSONAL], 'team')).toBeNull()
    expect(matchClaudeAccount([TEAM, PERSONAL], 'bbbb')).toBeNull()
    expect(matchClaudeAccount([TEAM, PERSONAL], 'me@')).toBeNull()
    const twin = account('cccc3333', 'me@example.com')
    expect(matchClaudeAccount([PERSONAL, twin], 'me@example.com')).toEqual({
      ambiguous: [PERSONAL, twin]
    })
  })
  it('an unknown or ambiguous name changes nothing and lists the valid names', () => {
    const router = routerFixture()
    const deps: ClaudeChatAccountDeps = {
      router,
      records: () => [{ sessionId: 'chat', provider: 'claude' }],
      orchestrationDb: () => null
    }
    const result = runClaudeChatMigration(deps, { to: 'prod', chatIds: ['chat'] })
    expect(result.ok).toBe(false)
    expect(result.lines[0]).toContain(`me@example.com (id ${PERSONAL.id})`)
    expect(claudeChatAccountPinsFor(router).all()).toEqual({})
  })
  it('explains instead of acting when the host has no managed accounts', () => {
    const router = { ...routerFixture(), listAccounts: () => [] }
    const result = runClaudeChatMigration(
      { router, records: () => [], orchestrationDb: () => null },
      { to: 'x', chatIds: ['chat'] }
    )
    expect(result).toMatchObject({ ok: false, moved: [] })
    expect(result.lines[0]).toContain('no managed Claude accounts')
  })
})

describe('accepted reply for an intercepted command', () => {
  it('reads as recorded to a released client, so nothing returns to the composer', () => {
    const reply = acceptedOrcaCommandReply('msg-1', {
      fence: 3,
      cursor: { epoch: 'e', sequence: 9 }
    })
    expect(structuredAgentSessionSendEvidence({ kind: 'result', result: reply })).toEqual({
      kind: 'recorded'
    })
    expect(reply.ok && reply.cursor).toEqual({ epoch: 'e', sequence: 9 })
    expect(reply.ok && 'submission' in reply.value).toBe(false)
    // The released mobile app reports a `withdrawn` receipt as "Message not sent"; this shape is
    // the one mobile-structured-send-delivery.test.ts checks reads as no failure.
    expect(reply.ok && reply.value).toEqual({
      clientMessageId: 'msg-1',
      queued: { messageId: 'msg-1', position: 0, state: 'dispatched' }
    })
  })
})

describe('terminal pins', () => {
  it('sets the pinned config dir without the follow-the-switch marker', () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('terminal:tab1:leaf1', PERSONAL.id)
    const home = pinnedClaudeTerminalHome(router, 'tab1:leaf1')
    expect(home).toBe(`/profiles/${PERSONAL.id}/home`)
    expect(pinnedClaudeTerminalHome(router, 'tab1:other')).toBeNull()
    expect(
      pinnedClaudeTerminalHome(router, 'tab1:leaf1', { runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).toBeNull()
    const global = {
      ORCA_CLAUDE_PROFILE_POINTER: '/p',
      CLAUDE_CONFIG_DIR: '/team',
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: '/team'
    }
    const applied = applyClaudeTerminalPin(home, global, {
      configDir: '/team',
      envPatch: global,
      provenance: 'profile:team'
    })
    expect(applied.env).toEqual({ ORCA_CLAUDE_PROFILE_POINTER: '/p', CLAUDE_CONFIG_DIR: home })
    expect(applied.auth?.envPatch).toEqual({
      ORCA_CLAUDE_PROFILE_POINTER: '/p',
      CLAUDE_CONFIG_DIR: home
    })
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
      { to: 'me@example.com', chatIds: ['terminal:tab1:leaf1'] }
    )
    expect(claudeChatAccountPinsFor(router).get('terminal:tab1:leaf1')).toBe(PERSONAL.id)
    expect(result.lines.at(-1)).toBe(
      `  terminal tab1:leaf1: when idle, type /exit, then run: ORCA_CLAUDE_INJECTED_CONFIG_DIR= CLAUDE_CONFIG_DIR='/profiles/${PERSONAL.id}/home' claude --resume 'sess-1'`
    )
  })
})

describe('stale pins', () => {
  it('/orca-account says the pin points at a removed account', () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('chat', 'removed-account')
    const text = describeChatAccount(
      { router, records: () => [], orchestrationDb: () => null },
      { sessionId: 'chat', provider: 'claude' },
      [TEAM, PERSONAL]
    )
    expect(text.split('\n')[0]).toContain(
      'pinned to account removed-account, which no longer exists'
    )
    expect(text).toContain('team@example.com (follows the global selection)')
  })
})

/** Chat A was /clear'ed into A2, then A2 into A3. */
const LINEAGE: Record<string, string[]> = { A: ['A'], A2: ['A2', 'A'], A3: ['A3', 'A2', 'A'] }
const lineage = (id: string) => LINEAGE[id] ?? [id]

describe('pins across /clear', () => {
  it('keys a pin by the root, so the cleared continuation keeps it', () => {
    installClaudeChatLineage(lineage)
    const router = routerFixture(TEAM.id)
    const deps: ClaudeChatAccountDeps = {
      router,
      records: () => ['A', 'A2', 'A3'].map((sessionId) => ({ sessionId, provider: 'claude' })),
      orchestrationDb: () => null
    }
    runClaudeChatMigration(deps, { to: PERSONAL.id, chatIds: ['A2'] })
    expect(claudeChatAccountPinsFor(router).all()).toEqual({ A: PERSONAL.id })
    expect(pinnedClaudeAccountForChat(router, 'A3')).toEqual({ accountId: PERSONAL.id, source: 'pin' })
    runClaudeChatMigration(deps, { unpin: true, chatIds: ['A3'] })
    expect(claudeChatAccountPinsFor(router).all()).toEqual({})
    expect(pinnedClaudeAccountForChat(router, 'A3')).toBeNull()
  })

  it('still reads, then re-keys, a pin an older build wrote under a cleared id', () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('A2', PERSONAL.id)
    installClaudeChatLineage(lineage)
    expect(pinnedClaudeAccountForChat(router, 'A3')?.accountId).toBe(PERSONAL.id)
    expect(claudeChatAccountPinsFor(router).all()).toEqual({ A: PERSONAL.id })
  })

  it('looks up workers and coordinators by the root the dispatch rows hold', () => {
    installClaudeChatLineage(lineage)
    const seen: unknown[] = []
    const db = {
      db: {
        prepare: () => ({
          all: (...args: unknown[]) => {
            seen.push(args[0])
            return [{ id: 'W' }]
          }
        })
      }
    }
    expect(workersOfCoordinator(db, 'A3')).toEqual(['W'])
    expect(coordinatorOfWorker(db, 'A2')).toBe('W')
    // Workers: chat-UI and terminal rows; coordinator: its session id and pane, newest row.
    expect(seen).toEqual(['A', 'A', 'A', 'A'])
  })
})

describe('coordinator lookup', () => {
  it('filters self-created rows in SQL, before the newest row is taken', () => {
    let sql = ''
    const db = {
      db: {
        prepare: (text: string) => {
          sql = text
          return { all: () => [] }
        }
      }
    }
    coordinatorOfWorker(db, 'w')
    expect(sql).toMatch(/creator_orca_session_id <> assignee_orca_session_id[\s\S]*LIMIT 1/u)
  })

  it('a stale own pin still inherits the coordinator pin, through several levels', () => {
    const router = routerFixture(TEAM.id)
    const pins = claudeChatAccountPinsFor(router)
    pins.set('worker', 'removed-account')
    pins.set('top', PERSONAL.id)
    const parents: Record<string, string> = { worker: 'middle', middle: 'top' }
    installClaudeChatCoordinatorLookup((id) => parents[id] ?? null)
    expect(pinnedClaudeAccountForChat(router, 'worker')).toEqual({
      accountId: PERSONAL.id,
      source: 'coordinator'
    })
  })
})

describe('pin file robustness', () => {
  it('keeps a corrupt file aside instead of overwriting it', () => {
    const router = routerFixture()
    const pins = claudeChatAccountPinsFor(router)
    mkdirSync(dirname(pins.path), { recursive: true })
    writeFileSync(pins.path, '{ not json')
    expect(pinnedClaudeAccountForChat(router, 'chat')).toBeNull()
    pins.set('chat', TEAM.id)
    const aside = readdirSync(dirname(pins.path)).filter((name) => name.includes('.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dirname(pins.path), aside[0]), 'utf8')).toBe('{ not json')
    expect(pins.get('chat')).toBe(TEAM.id)
    expect(existsSync(pins.path)).toBe(true)
  })
})
