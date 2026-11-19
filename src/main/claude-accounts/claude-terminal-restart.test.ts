import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import {
  installClaudeChatCoordinatorLookup,
  pinnedClaudeAccountForTerminal
} from './claude-chat-account-pins'
import { claudeChatAccountPinsFor } from './claude-chat-account-pin-store'
import {
  claudeTerminalResumeLine,
  coordinatorCandidatesOfWorker,
  workersOfCoordinator,
  type ClaudeChatAccountDeps
} from './claude-chat-account-commands'
import { pinnedClaudeTerminalHome } from './claude-chat-account-terminal'
import {
  isClaudeForegroundProcess,
  restartClaudeTerminalInPlace,
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

/** A fake pane: a shell running Claude; /exit hands the foreground back to the shell, the resume
 *  line starts Claude again. The clock advances only through sleep. */
function fakePane(
  init: {
    foreground?: string | null
    hook?: string | null
    title?: 'working' | 'permission' | 'idle' | null
    exitsOnSlashExit?: boolean
    /** Hook state turns to `done` after this many ms of waiting. */
    idleAfterMs?: number
    refuseInput?: boolean
    resumeAllowed?: boolean
  } = {}
) {
  const state = {
    clock: 0,
    foreground: init.foreground === undefined ? 'claude' : init.foreground,
    hook: init.hook === undefined ? 'done' : init.hook,
    title: init.title === undefined ? 'idle' : init.title,
    ptyId: 'pty-1',
    sent: [] as string[]
  }
  const port: ClaudeTerminalRestartPort = {
    terminalForPane: (paneKey) =>
      paneKey === 'tab1:leaf1' ? { handle: 'term-1', ptyId: state.ptyId } : null,
    hookState: () => state.hook,
    agentStatus: async () => ({
      isRunningAgent: isClaudeForegroundProcess(state.foreground),
      status: state.title
    }),
    foregroundProcess: async () => state.foreground,
    send: async (_handle, action) => {
      if (init.refuseInput) {
        return false
      }
      const text = `${action.text ?? ''}${action.enter ? '⏎' : ''}`
      state.sent.push(text)
      if (text === '/exit⏎' && init.exitsOnSlashExit !== false) {
        state.foreground = 'zsh'
      } else if (text === '\x1b') {
        state.title = 'idle'
        state.hook = 'done'
      } else if (text.includes('claude --resume')) {
        state.foreground = '2.1.328'
      }
      return true
    },
    assertResumeAllowed: async () => {
      if (init.resumeAllowed === false) {
        throw new Error('owned by a chat')
      }
    },
    sleep: async (ms) => {
      state.clock += ms
      if (init.idleAfterMs !== undefined && state.clock >= init.idleAfterMs) {
        state.hook = 'done'
        state.title = 'idle'
      }
    },
    now: () => state.clock
  }
  return { port, state }
}

const INPUT = { paneKey: 'tab1:leaf1', claudeSessionId: 'sess-1', resumeLine: 'RESUME claude --resume sess-1' }

describe('terminal restart in place', () => {
  it('exits an idle Claude, proves the exit, then resumes in the same shell', async () => {
    const { port, state } = fakePane()
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { now: false, idleDeadline: 1000 })
    expect(outcome.kind).toBe('restarted')
    expect(state.sent).toEqual(['/exit⏎', 'RESUME claude --resume sess-1⏎'])
  })

  it('waits for the turn to end before typing anything', async () => {
    const { port, state } = fakePane({ hook: 'working', title: 'working', idleAfterMs: 3000 })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      now: false,
      idleDeadline: 10_000,
      pollMs: 500
    })
    expect(outcome.kind).toBe('restarted')
    expect(state.clock).toBeGreaterThanOrEqual(3000)
    expect(state.sent[0]).toBe('/exit⏎')
  })

  it('gives up untouched when the agent stays busy past the timeout', async () => {
    const { port, state } = fakePane({ hook: 'working', title: 'working' })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { now: false, idleDeadline: 2000 })
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'Claude was still working when the wait timed out'
    })
    expect(state.sent).toEqual([])
  })

  it('--now interrupts once, then exits and resumes', async () => {
    const { port, state } = fakePane({ hook: 'working', title: 'working' })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { now: true, idleDeadline: 0 })
    expect(outcome.kind).toBe('restarted')
    expect(state.sent).toEqual(['\x1b', '/exit⏎', 'RESUME claude --resume sess-1⏎'])
  })

  it.each([
    ['a shell in the foreground', { foreground: 'zsh' }, 'Claude is not running in this pane'],
    ['another program', { foreground: 'vim' }, 'the foreground process is vim, not Claude'],
    ['an older daemon that cannot tell', { foreground: null }, 'older PTY daemon'],
    ['an open permission prompt', { hook: 'blocked' }, 'waiting for an answer or a permission'],
    ['a question, even with --now', { hook: 'waiting' }, 'waiting for an answer or a permission'],
    ['a resume a chat-UI chat owns', { resumeAllowed: false }, 'not allowed in a terminal'],
    ['a terminal that refuses input', { refuseInput: true }, 'refused input']
  ])('never types into a pane with %s', async (_name, init, reason) => {
    const { port, state } = fakePane(init)
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { now: true, idleDeadline: 0 })
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.reason).toContain(reason)
    expect(state.sent).toEqual([])
  })

  it('refuses without a session id or a live pane', async () => {
    const { port } = fakePane()
    expect(
      (await restartClaudeTerminalInPlace(port, { ...INPUT, claudeSessionId: null }, { now: true, idleDeadline: 0 }))
        .kind
    ).toBe('refused')
    expect(
      (await restartClaudeTerminalInPlace(port, { ...INPUT, paneKey: 'gone:pane' }, { now: true, idleDeadline: 0 }))
        .kind
    ).toBe('refused')
  })

  it('does not start a second Claude when the first never exits', async () => {
    const { port, state } = fakePane({ exitsOnSlashExit: false })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      now: false,
      idleDeadline: 0,
      exitTimeoutMs: 2000
    })
    expect(outcome.kind).toBe('stopped-midway')
    expect(state.sent).toEqual(['/exit⏎'])
  })

  it('does not type the resume line when the pane got a new shell meanwhile', async () => {
    const { port, state } = fakePane()
    const send = port.send
    port.send = async (handle, action) => {
      const ok = await send(handle, action)
      state.ptyId = 'pty-2'
      return ok
    }
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      now: false,
      idleDeadline: 0,
      exitTimeoutMs: 1000
    })
    expect(outcome.kind).toBe('stopped-midway')
    expect(state.sent).toEqual(['/exit⏎'])
  })
})

describe('resume line', () => {
  it('clears the follow-the-switch marker and quotes the home', () => {
    expect(claudeTerminalResumeLine('/p/home', 'sess-1')).toBe(
      "ORCA_CLAUDE_INJECTED_CONFIG_DIR= CLAUDE_CONFIG_DIR='/p/home' claude --resume 'sess-1'"
    )
    expect(claudeTerminalResumeLine(null, 'sess-1')).toBe("CLAUDE_CONFIG_DIR= claude --resume 'sess-1'")
  })
})

function terminalDeps(router: ReturnType<typeof routerFixture>, panes: string[]): ClaudeChatAccountDeps {
  return {
    router,
    records: () => [],
    orchestrationDb: () => null,
    terminals: () => panes.map((paneKey) => ({ paneKey, claudeSessionId: `sess-${paneKey}` }))
  }
}

describe('migrate with terminal restarts', () => {
  it('dry-run says per pane whether it would restart or only be pinned, and why', async () => {
    const router = routerFixture(TEAM.id)
    const { port, state } = fakePane()
    const result = await runClaudeChatMigrationWithRestarts(
      terminalDeps(router, ['tab1:leaf1', 'tab2:leaf2']),
      { to: PERSONAL.id, allOn: TEAM.id, dryRun: true },
      port
    )
    expect(result.lines).toEqual([
      `Would move 2 chat(s) to me@example.com (${PERSONAL.id}):`,
      '  1. chat        terminal:tab1:leaf1  (from team@example.com)',
      '  2. chat        terminal:tab2:leaf2  (from team@example.com)',
      '  terminal tab1:leaf1: would restart in place once idle (waits up to 180s)',
      `  terminal tab2:leaf2: pin only, not restarted (the pane has no live terminal); manual: ORCA_CLAUDE_INJECTED_CONFIG_DIR= CLAUDE_CONFIG_DIR='/profiles/${PERSONAL.id}/home' claude --resume 'sess-tab2:leaf2'`
    ])
    expect(claudeChatAccountPinsFor(router).all()).toEqual({})
    expect(state.sent).toEqual([])
  })

  it('pins, restarts what it safely can, and prints the manual line for the rest', async () => {
    const router = routerFixture(TEAM.id)
    const { port } = fakePane()
    const result = await runClaudeChatMigrationWithRestarts(
      terminalDeps(router, ['tab1:leaf1', 'tab2:leaf2']),
      { to: 'me@example.com', chatIds: ['terminal:tab1:leaf1', 'terminal:tab2:leaf2'] },
      port
    )
    expect(result.ok).toBe(true)
    expect(claudeChatAccountPinsFor(router).all()).toEqual({
      'terminal:tab1:leaf1': PERSONAL.id,
      'terminal:tab2:leaf2': PERSONAL.id
    })
    expect(result.lines.slice(-2)).toEqual([
      '  terminal tab1:leaf1: restarted in place (same shell and terminal)',
      `  terminal tab2:leaf2: not restarted automatically (the pane has no live terminal); when idle, type /exit, then run: ORCA_CLAUDE_INJECTED_CONFIG_DIR= CLAUDE_CONFIG_DIR='/profiles/${PERSONAL.id}/home' claude --resume 'sess-tab2:leaf2'`
    ])
  })

  it('--all-on picks terminal panes by their pin or the global selection', async () => {
    const router = routerFixture(TEAM.id)
    claudeChatAccountPinsFor(router).set('terminal:tab2:leaf2', PERSONAL.id)
    const result = await runClaudeChatMigrationWithRestarts(
      terminalDeps(router, ['tab1:leaf1', 'tab2:leaf2']),
      { to: PERSONAL.id, allOn: TEAM.id, dryRun: true },
      null
    )
    expect(result.moved).toEqual(['terminal:tab1:leaf1'])
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
    expect(pinnedClaudeAccountForTerminal(router, 'w:1')).toEqual({ accountId: TEAM.id, source: 'pin' })
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
    expect(queries.every((query) => query.arg === 'c:1' && query.sql.includes('creator_pane_key = ?'))).toBe(true)
    queries.length = 0
    coordinatorCandidatesOfWorker(db, 'terminal:w:1')
    expect(queries.every((query) => query.sql.includes('assignee_pane_key = ?'))).toBe(true)
  })
})
