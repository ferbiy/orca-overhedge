import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import {
  installClaudeChatCoordinatorLookup,
  pinnedClaudeAccountForTerminal
} from '../chat-pins/claude-chat-account-pins'
import { claudeChatAccountPinsFor } from '../chat-pins/claude-chat-account-pin-store'
import {
  claudeTerminalResumeLine,
  coordinatorCandidatesOfWorker,
  workersOfCoordinator,
  type ClaudeChatAccountDeps
} from '../chat-pins/claude-chat-account-commands'
import { pinnedClaudeTerminalHome } from '../chat-pins/claude-chat-account-terminal'
import {
  NOT_HEADLESS,
  QUESTION,
  restartClaudeTerminalInPlace,
  type ClaudePaneRestartRefusal,
  type ClaudeTerminalRestartPort
} from './claude-terminal-restart'
import { runClaudeChatMigrationWithRestarts } from './claude-terminal-migration'

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
  dir = mkdtempSync(join(tmpdir(), 'term-restart-'))
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
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

const SID = '0f3c1d2e-1111-4222-8333-944455556666'

type PaneState = {
  headless: boolean
  live: boolean
  running: boolean
  /** Hook states returned in turn; the last one repeats. */
  hooks: string[]
  title: 'working' | 'permission' | 'idle' | null
  result: { ok: true; ptyId: string } | { ok: false; reason: ClaudePaneRestartRefusal }
  /** What stillCurrent answered when the runtime asked. */
  stillCurrent: boolean[]
  restarts: { ptyId: string; sessionId: string }[]
  clock: number
}

function fakePane(overrides: Partial<PaneState> = {}): {
  port: ClaudeTerminalRestartPort
  state: PaneState
} {
  const state: PaneState = {
    headless: true,
    live: true,
    running: true,
    hooks: ['done'],
    title: 'idle',
    result: { ok: true, ptyId: 'pty-2' },
    stillCurrent: [],
    restarts: [],
    clock: 1000,
    ...overrides
  }
  const port: ClaudeTerminalRestartPort = {
    headless: () => state.headless,
    terminalForPane: (paneKey) =>
      state.live && paneKey === 'tab1:leaf1' ? { handle: 'h1', ptyId: 'pty-1' } : null,
    hookState: () =>
      state.hooks.length > 1 ? (state.hooks.shift() ?? null) : (state.hooks[0] ?? null),
    providerSession: (_paneKey, id) => ({ key: 'session_id', id, cwd: '/w' }),
    agentStatus: async () => ({ isRunningAgent: state.running, status: state.title }),
    restartPane: async (ptyId, session, stillCurrent) => {
      const current = await stillCurrent()
      state.stillCurrent.push(current)
      if (!current) {
        return { ok: false, reason: 'busy' }
      }
      state.restarts.push({ ptyId, sessionId: session.id })
      return state.result
    },
    sleep: async (ms) => {
      state.clock += ms
    },
    now: () => state.clock
  }
  return { port, state }
}

const INPUT = { paneKey: 'tab1:leaf1', claudeSessionId: SID }
const opts = (state: PaneState, waitMs = 10_000) => ({
  idleDeadline: state.clock + waitMs,
  pollMs: 100
})

describe('terminal restart through restart-in-place', () => {
  it('restarts an idle Claude pane through the runtime with its session', async () => {
    const { port, state } = fakePane()
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, opts(state))
    expect(outcome.kind).toBe('restarted')
    expect(state.restarts).toEqual([{ ptyId: 'pty-1', sessionId: SID }])
    expect(state.stillCurrent).toEqual([true])
  })

  it('refuses on a host with a desktop window, stopping nothing', async () => {
    const { port, state } = fakePane({ headless: false })
    expect(await restartClaudeTerminalInPlace(port, INPUT, opts(state))).toEqual({
      kind: 'refused',
      reason: NOT_HEADLESS
    })
    expect(state.restarts).toEqual([])
  })

  it('waits for the turn to end, then restarts', async () => {
    const { port, state } = fakePane({ hooks: ['working', 'working', 'done'] })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, opts(state))
    expect(outcome.kind).toBe('restarted')
    expect(state.clock).toBeGreaterThan(1000)
  })

  it('never interrupts a running turn: it times out untouched', async () => {
    const { port, state } = fakePane({ hooks: ['working'] })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, opts(state, 1000))
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'Claude was still working when the wait timed out'
    })
    expect(state.restarts).toEqual([])
  })

  it('refuses while Claude waits for an answer or a permission', async () => {
    for (const overrides of [{ hooks: ['blocked'] }, { title: 'permission' as const }]) {
      const { port, state } = fakePane(overrides)
      expect(await restartClaudeTerminalInPlace(port, INPUT, opts(state))).toEqual({
        kind: 'refused',
        reason: QUESTION
      })
      expect(state.restarts).toEqual([])
    }
  })

  it('refuses without a session id, with a non-UUID one, without a live pane or without Claude', async () => {
    const cases: [Partial<PaneState>, { paneKey: string; claudeSessionId: string | null }][] = [
      [{}, { paneKey: 'tab1:leaf1', claudeSessionId: null }],
      [{}, { paneKey: 'tab1:leaf1', claudeSessionId: 'not-a-uuid' }],
      [{ live: false }, INPUT],
      [{ running: false }, INPUT]
    ]
    for (const [overrides, input] of cases) {
      const { port, state } = fakePane(overrides)
      expect((await restartClaudeTerminalInPlace(port, input, opts(state))).kind).toBe('refused')
      expect(state.restarts).toEqual([])
    }
  })

  it('dry run checks and restarts nothing, also for a busy pane', async () => {
    for (const hooks of [['done'], ['working']]) {
      const { port, state } = fakePane({ hooks })
      const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
        ...opts(state),
        dryRun: true
      })
      expect(outcome.kind).toBe('would-restart')
      expect(state.restarts).toEqual([])
    }
  })

  it('refuses when the pane started working again right before the stop', async () => {
    // Idle at the check, working when the runtime asks stillCurrent.
    const { port, state } = fakePane({ hooks: ['done', 'working'] })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, opts(state))
    expect(state.stillCurrent).toEqual([false])
    expect(outcome.kind).toBe('refused')
    expect(state.restarts).toEqual([])
  })

  it('maps each runtime refusal: nothing stopped is refused, a stop without a new terminal fails', async () => {
    const expected: [ClaudePaneRestartRefusal, string][] = [
      ['not_local', 'refused'],
      ['viewer_cannot_follow', 'refused'],
      ['no_resume_command', 'refused'],
      ['busy', 'refused'],
      ['stop_failed', 'stopped-midway'],
      ['create_failed', 'stopped-midway']
    ]
    for (const [reason, kind] of expected) {
      const { port, state } = fakePane({ result: { ok: false, reason } })
      expect((await restartClaudeTerminalInPlace(port, INPUT, opts(state))).kind).toBe(kind)
    }
  })
})

describe('resume line', () => {
  it('clears the follow-the-switch marker and quotes the home', () => {
    expect(claudeTerminalResumeLine('/p/home', 'sess-1')).toBe(
      "ORCA_CLAUDE_INJECTED_CONFIG_DIR= CLAUDE_CONFIG_DIR='/p/home' claude --resume 'sess-1'"
    )
    expect(claudeTerminalResumeLine(null, 'sess-1')).toBe(
      "CLAUDE_CONFIG_DIR= claude --resume 'sess-1'"
    )
  })
})

function terminalDeps(
  router: ReturnType<typeof routerFixture>,
  panes: string[]
): ClaudeChatAccountDeps {
  return {
    router,
    records: () => [],
    orchestrationDb: () => null,
    terminals: () => panes.map((paneKey) => ({ paneKey, claudeSessionId: SID }))
  }
}

const manual = (id: string) =>
  `ORCA_CLAUDE_INJECTED_CONFIG_DIR= CLAUDE_CONFIG_DIR='/profiles/${id}/home' claude --resume '${SID}'`

describe('migrate with terminal restarts', () => {
  it('without --restart pins and prints the manual line, typing nothing', async () => {
    const router = routerFixture(TEAM.id)
    const { port, state } = fakePane()
    const result = await runClaudeChatMigrationWithRestarts(
      terminalDeps(router, ['tab1:leaf1']),
      { to: PERSONAL.id, chatIds: ['terminal:tab1:leaf1'] },
      port
    )
    expect(result.ok).toBe(true)
    expect(result.lines.at(-1)).toBe(
      `  terminal tab1:leaf1: when idle, type /exit, then run: ${manual(PERSONAL.id)}`
    )
    expect(claudeChatAccountPinsFor(router).all()).toEqual({ 'terminal:tab1:leaf1': PERSONAL.id })
    expect(state.restarts).toEqual([])
  })

  it('--restart --dry-run runs the real checks per pane, says the shared budget, stops nothing', async () => {
    const router = routerFixture(TEAM.id)
    const { port, state } = fakePane()
    const result = await runClaudeChatMigrationWithRestarts(
      terminalDeps(router, ['tab1:leaf1', 'tab2:leaf2']),
      {
        to: PERSONAL.id,
        chatIds: ['terminal:tab1:leaf1', 'terminal:tab2:leaf2'],
        restart: true,
        dryRun: true
      },
      port
    )
    expect(result.lines.slice(-3)).toEqual([
      'Terminal panes (2): idle wait up to 180s in total, one budget shared by all of them, in this order:',
      '  terminal tab1:leaf1: would restart (every check passed; a real run would restart the pane in a new terminal now)',
      `  terminal tab2:leaf2: would NOT restart (the pane has no live terminal); pin only, manual: ${manual(PERSONAL.id)}`
    ])
    expect(claudeChatAccountPinsFor(router).all()).toEqual({})
    expect(state.restarts).toEqual([])
  })

  it('--restart pins, restarts what it safely can, and is not ok when a pane was not restarted', async () => {
    const router = routerFixture(TEAM.id)
    const { port } = fakePane()
    const result = await runClaudeChatMigrationWithRestarts(
      terminalDeps(router, ['tab1:leaf1', 'tab2:leaf2']),
      {
        to: 'me@example.com',
        chatIds: ['terminal:tab1:leaf1', 'terminal:tab2:leaf2'],
        restart: true
      },
      port
    )
    expect(result.ok).toBe(false)
    expect(claudeChatAccountPinsFor(router).all()).toEqual({
      'terminal:tab1:leaf1': PERSONAL.id,
      'terminal:tab2:leaf2': PERSONAL.id
    })
    expect(result.lines.slice(-3)).toEqual([
      `  terminal tab1:leaf1: restarted in a new terminal in the same pane; the pane's pin sets CLAUDE_CONFIG_DIR, and Claude resumes session ${SID}`,
      `  terminal tab2:leaf2: not restarted automatically (the pane has no live terminal); when idle, type /exit, then run: ${manual(PERSONAL.id)}`,
      'Restarted 1 of 2 terminal pane(s).'
    ])
  })

  it('--restart with --all-on or --with-workers lists and changes nothing without --yes', async () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('terminal:tab1:leaf1', TEAM.id)
    const { port, state } = fakePane()
    const deps = terminalDeps(router, ['tab1:leaf1'])
    const result = await runClaudeChatMigrationWithRestarts(
      deps,
      { to: PERSONAL.id, allOn: TEAM.id, restart: true },
      port
    )
    expect(result.ok).toBe(false)
    expect(result.moved).toEqual([])
    expect(result.lines.at(-1)).toContain('needs --yes')
    expect(claudeChatAccountPinsFor(router).all()).toEqual({ 'terminal:tab1:leaf1': TEAM.id })
    expect(state.restarts).toEqual([])
    const confirmed = await runClaudeChatMigrationWithRestarts(
      deps,
      { to: PERSONAL.id, allOn: TEAM.id, restart: true, yes: true },
      port
    )
    expect(confirmed.ok).toBe(true)
    expect(state.restarts).toEqual([{ ptyId: 'pty-1', sessionId: SID }])
  })

  it('--all-on picks terminal panes by their pin, never the global selection; unpinned ones are skipped and listed', async () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('terminal:tab2:leaf2', TEAM.id)
    const result = await runClaudeChatMigrationWithRestarts(
      terminalDeps(router, ['tab1:leaf1', 'tab2:leaf2']),
      { to: PERSONAL.id, allOn: TEAM.id, dryRun: true },
      null
    )
    expect(result.moved).toEqual(['terminal:tab2:leaf2'])
    expect(
      result.lines.some((line) => line.includes('skipped terminal:tab1:leaf1: not pinned'))
    ).toBe(true)
  })
})

describe('terminal workers', () => {
  it('a terminal worker inherits its coordinator pin at spawn; its own pin wins', () => {
    const router = routerFixture(TEAM.id)
    const pins = claudeChatAccountPinsFor(router)
    pins.set('coordinator-chat', PERSONAL.id)
    installClaudeChatCoordinatorLookup((id) =>
      id === 'terminal:w:1' ? ['coordinator-chat', 'terminal:c:1'] : null
    )
    expect(pinnedClaudeAccountForTerminal(router, 'w:1')).toEqual({
      accountId: PERSONAL.id,
      source: 'coordinator'
    })
    expect(pinnedClaudeTerminalHome(router, 'w:1')).toBe(`/profiles/${PERSONAL.id}/home`)
    pins.set('terminal:w:1', TEAM.id)
    expect(pinnedClaudeAccountForTerminal(router, 'w:1')).toEqual({
      accountId: TEAM.id,
      source: 'pin'
    })
    expect(pinnedClaudeTerminalHome(router, 'other:pane')).toBeNull()
  })

  it('a terminal coordinator pin reaches a chat-UI worker through its pane', () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('terminal:c:1', PERSONAL.id)
    installClaudeChatCoordinatorLookup((id) => (id === 'terminal:w:1' ? ['terminal:c:1'] : null))
    expect(pinnedClaudeAccountForTerminal(router, 'w:1')?.accountId).toBe(PERSONAL.id)
  })

  it('finds terminal workers of a terminal coordinator by pane', () => {
    const queries: { sql: string; arg: unknown }[] = []
    const db = {
      db: {
        prepare: (sql: string) => ({
          all: (arg: unknown) => {
            queries.push({ sql, arg })
            return sql.includes("'terminal:' || assignee_pane_key") ? [{ id: 'terminal:w:1' }] : []
          }
        })
      }
    }
    expect(workersOfCoordinator(db, 'terminal:c:1')).toEqual(['terminal:w:1'])
    expect(
      queries.every((query) => query.arg === 'c:1' && query.sql.includes('creator_pane_key = ?'))
    ).toBe(true)
    queries.length = 0
    coordinatorCandidatesOfWorker(db, 'terminal:w:1')
    expect(queries.every((query) => query.sql.includes('assignee_pane_key = ?'))).toBe(true)
  })
})
