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
  isClaudeForegroundProcess,
  isPosixEnvPrefixShell,
  restartClaudeTerminalInPlace,
  type ClaudeTerminalRestartPort
} from './claude-terminal-restart'
import { proveClaudeEmptyPrompt } from './claude-terminal-screen-proof'
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

const RULE = '─'.repeat(40)
const idleScreen = (box = '> ', footer = '  ? for shortcuts') => [
  'Done. All tests pass.',
  RULE,
  box,
  RULE,
  footer
]
const SID = '0f3c1d2e-1111-4222-8333-944455556666'

/** A fake pane: a shell running Claude; /exit + Enter hands the foreground back to the shell, the
 *  resume line starts Claude again and posts a SessionStart row. The clock advances only through sleep. */
function fakePane(
  init: {
    foreground?: string | null
    hook?: string | null
    title?: 'working' | 'permission' | 'idle' | null
    screen?: string[] | null
    shell?: string | null
    exitsOnSlashExit?: boolean
    resumeStarts?: boolean
    resumeSession?: string
    /** Hook state turns to `done` after this many ms of waiting. */
    idleAfterMs?: number
    refuseInput?: boolean
    resumeAllowed?: boolean
    inFlight?: boolean | null
    held?: boolean
  } = {}
) {
  const sent: string[] = []
  const state = {
    clock: 0,
    foreground: init.foreground === undefined ? 'claude' : init.foreground,
    hook: init.hook === undefined ? 'done' : init.hook,
    title: init.title === undefined ? 'idle' : init.title,
    screen: init.screen === undefined ? idleScreen() : init.screen,
    session: { id: SID, at: -1 },
    ptyId: 'pty-1',
    holds: 0,
    released: 0,
    sent
  }
  const port: ClaudeTerminalRestartPort = {
    terminalForPane: (paneKey) =>
      paneKey === 'tab1:leaf1' ? { handle: 'term-1', ptyId: state.ptyId } : null,
    hookState: () => state.hook,
    sessionIdSince: (_paneKey, since) => (state.session.at >= since ? state.session.id : null),
    agentStatus: async () => ({
      isRunningAgent: isClaudeForegroundProcess(state.foreground),
      status: state.title
    }),
    foregroundProcess: async () => state.foreground,
    readScreen: async () => (state.screen ? { lines: state.screen } : null),
    rootShell: async () => (init.shell === undefined ? 'zsh' : init.shell),
    promptDeliveryInFlight: () => (init.inFlight === undefined ? false : init.inFlight),
    holdInput: () => {
      if (init.held) {
        return null
      }
      state.holds += 1
      let done = false
      return () => {
        if (!done) {
          done = true
          state.released += 1
        }
      }
    },
    write: async (_ptyId, data) => {
      if (init.refuseInput) {
        return false
      }
      state.sent.push(data)
      if (data === '/exit') {
        state.screen = idleScreen('> /exit')
      } else if (data === '\r' && init.exitsOnSlashExit !== false) {
        state.foreground = 'zsh'
        state.screen = ['$ ']
      } else if (data.includes('claude --resume') && init.resumeStarts !== false) {
        state.foreground = '2.1.328'
        state.session = { id: init.resumeSession ?? SID, at: state.clock }
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

const RESUME = `RESUME claude --resume ${SID}`
const INPUT = { paneKey: 'tab1:leaf1', claudeSessionId: SID, resumeLine: RESUME }

describe('terminal restart in place', () => {
  it('exits an idle Claude, proves the exit, resumes, and proves the same session runs again', async () => {
    const { port, state } = fakePane()
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 1000 })
    expect(outcome.kind).toBe('restarted')
    expect(state.sent).toEqual(['/exit', '\r', `${RESUME}\r`])
    expect(state.holds).toBe(1)
    expect(state.released).toBe(1)
  })

  it('waits for the turn to end before typing anything', async () => {
    const { port, state } = fakePane({ hook: 'working', title: 'working', idleAfterMs: 3000 })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      idleDeadline: 10_000,
      pollMs: 500
    })
    expect(outcome.kind).toBe('restarted')
    expect(state.clock).toBeGreaterThanOrEqual(3000)
    expect(state.sent[0]).toBe('/exit')
  })

  it('never interrupts a running turn: it times out untouched', async () => {
    const { port, state } = fakePane({ hook: 'working', title: 'working' })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 2000 })
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'Claude was still working when the wait timed out'
    })
    expect(state.sent).toEqual([])
  })

  it.each([
    ['a shell in the foreground', { foreground: 'zsh' }, 'Claude is not running in this pane'],
    ['another program', { foreground: 'vim' }, 'the foreground process is vim, not Claude'],
    ['an older daemon that cannot tell', { foreground: null }, 'older PTY daemon'],
    ['an open permission prompt', { hook: 'blocked' }, 'waiting for an answer or a permission'],
    ['a question', { hook: 'waiting' }, 'waiting for an answer or a permission'],
    ['a resume a chat-UI chat owns', { resumeAllowed: false }, 'not allowed in a terminal'],
    ['a terminal that refuses input', { refuseInput: true }, 'refused input'],
    ['an unreadable screen', { screen: null }, 'could not be read'],
    ['a draft in the input box', { screen: idleScreen('> please also fix the') }, 'not empty'],
    [
      'a multi-line draft',
      { screen: ['x', RULE, '> line one', '  line two', RULE] },
      'not recognised'
    ],
    [
      'an open picker',
      { screen: ['Select model', '❯ 1. Default', '  2. Opus', 'Enter to select · Esc to cancel'] },
      'not recognised'
    ],
    [
      'a dialog under the box',
      { screen: idleScreen('> ', '  Enter to confirm · Esc to cancel') },
      'menu or dialog'
    ],
    [
      'background shells',
      { screen: idleScreen('> ', '  2 background shells running') },
      'background'
    ],
    ['vim NORMAL mode', { screen: idleScreen('> ', '  -- NORMAL --') }, 'vim'],
    ['a fish shell', { shell: 'fish' }, "the pane's shell is fish"],
    ['PowerShell', { shell: 'pwsh' }, 'shell is pwsh'],
    ['an unknown shell', { shell: null }, 'cannot tell which shell'],
    ['a prompt delivery in flight', { inFlight: true }, 'delivering a prompt'],
    ['unknown prompt delivery state', { inFlight: null }, 'cannot tell whether a prompt'],
    ['input held by another operation', { held: true }, 'holds this pane']
  ])('never types into a pane with %s', async (_name, init, reason) => {
    const { port, state } = fakePane(init)
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 0 })
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' && outcome.reason).toContain(reason)
    expect(state.sent).toEqual([])
  })

  it('refuses a composer draft Orca holds for the pane', async () => {
    const { port, state } = fakePane()
    port.readScreen = async () => ({ lines: idleScreen(), draft: 'half a reply' })
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 0 })
    expect(outcome.kind === 'refused' && outcome.reason).toContain('composer')
    expect(state.sent).toEqual([])
  })

  it('refuses without a session id, with a non-UUID one, or without a live pane', async () => {
    const { port, state } = fakePane()
    for (const input of [
      { ...INPUT, claudeSessionId: null },
      { ...INPUT, claudeSessionId: "x'; rm -rf ~" },
      { ...INPUT, paneKey: 'gone:pane' }
    ]) {
      expect((await restartClaudeTerminalInPlace(port, input, { idleDeadline: 0 })).kind).toBe(
        'refused'
      )
    }
    expect(state.sent).toEqual([])
  })

  it('refuses a second migration of a pane mid-sequence', async () => {
    const { port, state } = fakePane({ hook: 'working', title: 'working', idleAfterMs: 2000 })
    const first = restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 10_000 })
    const second = await restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 10_000 })
    expect(second).toEqual({
      kind: 'refused',
      reason: 'another migration is already restarting this pane'
    })
    expect((await first).kind).toBe('restarted')
    expect(state.sent.filter((data) => data === '/exit')).toHaveLength(1)
  })

  it('stops before /exit when cancelled, and types nothing', async () => {
    const { port, state } = fakePane({ hook: 'working', title: 'working', idleAfterMs: 5000 })
    const controller = new AbortController()
    const advance = port.sleep
    port.sleep = async (ms) => {
      await advance(ms)
      controller.abort()
    }
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      idleDeadline: 10_000,
      signal: controller.signal
    })
    expect(outcome.kind === 'refused' && outcome.reason).toContain('cancelled')
    expect(state.sent).toEqual([])
  })

  it('dry run runs the checks, takes and releases the hold, and types nothing', async () => {
    const { port, state } = fakePane()
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      idleDeadline: 0,
      dryRun: true
    })
    expect(outcome.kind).toBe('would-restart')
    expect(state.sent).toEqual([])
    expect([state.holds, state.released]).toEqual([1, 1])
    const refused = fakePane({ shell: 'fish' })
    expect(
      (await restartClaudeTerminalInPlace(refused.port, INPUT, { idleDeadline: 0, dryRun: true }))
        .kind
    ).toBe('refused')
  })

  it('does not press Enter when /exit does not show in the input box', async () => {
    const { port, state } = fakePane()
    const write = port.write
    port.write = async (ptyId, data) => {
      const ok = await write(ptyId, data)
      if (data === '/exit') {
        state.screen = idleScreen('> X/exit')
      }
      return ok
    }
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 0 })
    expect(outcome.kind).toBe('stopped-midway')
    expect(state.sent).toEqual(['/exit'])
  })

  it('does not start a second Claude when the first never exits, and does not answer a confirmation', async () => {
    const { port, state } = fakePane({ exitsOnSlashExit: false })
    const write = port.write
    port.write = async (ptyId, data) => {
      const ok = await write(ptyId, data)
      if (data === '\r') {
        state.screen = ['Background tasks are still running. Exit anyway?', '❯ 1. Yes', '  2. No']
      }
      return ok
    }
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      idleDeadline: 0,
      exitTimeoutMs: 2000
    })
    expect(outcome.kind).toBe('stopped-midway')
    expect(outcome.kind === 'stopped-midway' && outcome.reason).toContain('Exit anyway?')
    expect(state.sent).toEqual(['/exit', '\r'])
  })

  it('does not type the resume line when the pane got a new shell meanwhile', async () => {
    const { port, state } = fakePane()
    const write = port.write
    port.write = async (ptyId, data) => {
      const ok = await write(ptyId, data)
      if (data === '\r') {
        state.ptyId = 'pty-2'
      }
      return ok
    }
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
      idleDeadline: 0,
      exitTimeoutMs: 1000
    })
    expect(outcome.kind).toBe('stopped-midway')
    expect(state.sent).toEqual(['/exit', '\r'])
  })

  it('reports failure (never success) when Claude does not come back under the same session', async () => {
    for (const init of [
      { resumeStarts: false },
      { resumeSession: '99999999-1111-4222-8333-944455556666' }
    ]) {
      const { port } = fakePane(init)
      const outcome = await restartClaudeTerminalInPlace(port, INPUT, {
        idleDeadline: 0,
        startTimeoutMs: 2000
      })
      expect(outcome.kind).toBe('stopped-midway')
    }
  })

  it('refuses the resume line when a non-POSIX shell is in front after /exit', async () => {
    const { port, state } = fakePane()
    const write = port.write
    port.write = async (ptyId, data) => {
      const ok = await write(ptyId, data)
      if (data === '\r') {
        state.foreground = 'fish'
      }
      return ok
    }
    const outcome = await restartClaudeTerminalInPlace(port, INPUT, { idleDeadline: 0 })
    expect(outcome.kind).toBe('stopped-midway')
    expect(state.sent).toEqual(['/exit', '\r'])
  })
})

describe('shell and screen proofs', () => {
  it('accepts only POSIX env-prefix shells', () => {
    expect(['bash', '-zsh', '/bin/sh', 'dash', 'ksh'].every(isPosixEnvPrefixShell)).toBe(true)
    expect(['fish', 'pwsh', 'nu', 'csh', 'tcsh', 'xonsh', null].some(isPosixEnvPrefixShell)).toBe(
      false
    )
  })

  it('reads a rounded box and the bypass-permissions footer as an empty prompt', () => {
    expect(
      proveClaudeEmptyPrompt({
        lines: [
          `╭${'─'.repeat(30)}╮`,
          '│ >                            │',
          `╰${'─'.repeat(30)}╯`,
          '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
        ]
      })
    ).toEqual({ ok: true })
  })

  it('refuses while the spinner line above the box says Claude is working', () => {
    expect(
      proveClaudeEmptyPrompt({ lines: ['✻ Thinking… (esc to interrupt)', ...idleScreen()] }).ok
    ).toBe(false)
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
    expect(state.sent).toEqual([])
  })

  it('--restart --dry-run runs the real checks per pane, says the shared budget, types nothing', async () => {
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
      '  terminal tab1:leaf1: would restart in place (every check passed; a real run would type /exit now)',
      `  terminal tab2:leaf2: would NOT restart (the pane has no live terminal); pin only, manual: ${manual(PERSONAL.id)}`
    ])
    expect(claudeChatAccountPinsFor(router).all()).toEqual({})
    expect(state.sent).toEqual([])
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
      `  terminal tab1:leaf1: restarted in place; Claude runs again under session ${SID} (same shell and terminal)`,
      `  terminal tab2:leaf2: not restarted automatically (the pane has no live terminal); when idle, type /exit, then run: ${manual(PERSONAL.id)}`,
      'Restarted 1 of 2 terminal pane(s) in place.'
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
    expect(state.sent).toEqual([])
    const confirmed = await runClaudeChatMigrationWithRestarts(
      deps,
      { to: PERSONAL.id, allOn: TEAM.id, restart: true, yes: true },
      port
    )
    expect(confirmed.ok).toBe(true)
    expect(state.sent).toEqual(['/exit', '\r', expect.stringContaining('claude --resume')])
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
