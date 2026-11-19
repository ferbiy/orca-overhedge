// Overhedge: worker-start pins a new Claude worker (explicit --account, else its coordinator's
// effective account) before its first process starts, for terminal and chat-UI workers.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentLaunchModeReceipt } from '../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { ClaudeManagedAccount } from '../../../../../../shared/managed-account-types'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerIdentities } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { claudeChatAccountPinsFor } from '../../../../../claude-accounts/claude-chat-account-pin-store'
import {
  pinnedClaudeAccountForChat,
  pinnedClaudeAccountForTerminal
} from '../../../../../claude-accounts/claude-chat-account-pins'
import type { WorkerEffect } from './worker-topology'

const state = vi.hoisted(
  (): {
    router: { pointerPath: string; listAccounts: () => readonly ClaudeManagedAccount[] } | undefined
    sessionCreates: { sessionId: string; pinned: string | null }[]
  } => ({ router: undefined, sessionCreates: [] })
)

vi.mock('../../../../../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () => state.router
}))

vi.mock('../../structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => {
    const router = state.router
    state.sessionCreates.push({
      sessionId: args.envelope.sessionId,
      // What the chat would launch under, read at the moment the session is created.
      pinned: router
        ? (pinnedClaudeAccountForChat(router, args.envelope.sessionId)?.accountId ?? null)
        : null
    })
    return { ok: true, value: { sessionId: args.envelope.sessionId, fence: 7 } }
  }
}))

const { placeWorkerAgent } = await import('./worker-start-agent-placement')
const { resolveWorkerStartClaudeAccount, workerClaudeLaunchAccount } = await import(
  './worker-start-claude-account'
)

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

function fixtureRouter(router: { pointerPath: string }) {
  return { pointerPath: router.pointerPath, listAccounts: () => [TEAM, PERSONAL] }
}

let dir: string | undefined
function installRouter() {
  dir = mkdtempSync(join(tmpdir(), 'worker-account-'))
  const router = fixtureRouter({ pointerPath: join(dir, 'claude-profiles', 'selected-host') })
  state.router = router
  return router
}

beforeEach(() => {
  state.sessionCreates = []
  structuredWorkerIdentities.clear()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host supplies subscribe and a complete writable record for the newly minted id.
  setStructuredAgentSessionHost({
    subscribe: () => () => {},
    deps: {
      store: {
        requireWritableRecord: (sessionId: string) =>
          agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
      }
    }
  } as never)
})

afterEach(() => {
  state.router = undefined
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

const STRUCTURED: AgentLaunchModeReceipt = {
  mode: 'structured',
  preferred: 'structured',
  reason: 'user_default',
  detail: 'chat'
}
const TERMINAL: AgentLaunchModeReceipt = {
  mode: 'terminal',
  preferred: 'terminal',
  reason: 'user_default',
  detail: 'terminal'
}

function fakes(router: ReturnType<typeof fixtureRouter>) {
  const pinnedAtSpawn: (string | null)[] = []
  const paneAccount = (paneKey: string | undefined) =>
    paneKey ? (pinnedClaudeAccountForTerminal(router, paneKey)?.accountId ?? null) : null
  const runtime = {
    createManagedWorktree: vi.fn(
      async (args: { startupAgent?: string; startupPaneKey?: string }) => {
        if (args.startupAgent) {
          pinnedAtSpawn.push(paneAccount(args.startupPaneKey))
        }
        return {
          worktree: { id: 'wt_new', repoId: 'repo_1' },
          ...(args.startupAgent ? { startupTerminal: { handle: 'term_startup' } } : {})
        }
      }
    ),
    listTerminals: vi.fn(async () => ({ terminals: [] })),
    createTerminal: vi.fn(async (_selector: string, opts: { tabId?: string; leafId?: string }) => {
      pinnedAtSpawn.push(paneAccount(opts.tabId ? `${opts.tabId}:${opts.leafId}` : undefined))
      return { handle: 'term_worker', surface: 'background' }
    }),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    getClientSettings: vi.fn(() => ({})),
    ensureStructuredAgentSessionHost: async () => {}
  }
  const db = { recordWorkerStage: vi.fn() }
  return { runtime, db, pinnedAtSpawn }
}

function place(
  f: ReturnType<typeof fakes>,
  args: { mode: AgentLaunchModeReceipt; existing: boolean; claudeAccountId?: string }
) {
  const effects: WorkerEffect[] = []
  return placeWorkerAgent({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement calls only the methods faked here.
    runtime: f.runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the placement records only worker stages.
    db: f.db as unknown as OrchestrationDb,
    dispatchId: 'ctx_1',
    taskId: 'task_1',
    params: WorkerStartParams.parse({
      from: 'term_coord',
      task: 'task_1',
      ...(args.existing ? {} : { name: 'child' })
    }),
    requestedWorktree: args.existing ? 'id:wt_existing' : 'new-child',
    creationTarget: args.existing
      ? undefined
      : { repoSelector: 'repo_1', parentWorktreeId: 'wt_coord' },
    resolvedWorktree: args.existing ? { id: 'wt_existing', repoId: 'repo_1' } : undefined,
    mode: args.mode,
    agent: 'claude',
    launchPreferences: undefined,
    effects,
    onStage: () => {},
    ...(args.claudeAccountId ? { claudeAccountId: args.claudeAccountId } : {})
  })
}

function pinKeys(router: { pointerPath: string }): string[] {
  return Object.keys(claudeChatAccountPinsFor(router).all())
}

describe('worker placement pins the new worker before it starts', () => {
  it('pins a terminal worker in an existing worktree to its reserved pane', async () => {
    const router = installRouter()
    const f = fakes(router)
    await place(f, { mode: TERMINAL, existing: true, claudeAccountId: PERSONAL.id })
    expect(f.pinnedAtSpawn).toEqual([PERSONAL.id])
    expect(f.runtime.createTerminal).toHaveBeenCalledWith(
      'id:wt_existing',
      expect.objectContaining({ requireFreshPane: true, startupAgent: 'claude' })
    )
    // Only the pane's pin remains: the unused chat-session reservation is dropped.
    expect(pinKeys(router)).toEqual([expect.stringMatching(/^terminal:/)])
  })

  it('pins the startup agent of a worktree the worker creates', async () => {
    const router = installRouter()
    const f = fakes(router)
    await place(f, { mode: TERMINAL, existing: false, claudeAccountId: PERSONAL.id })
    expect(f.pinnedAtSpawn).toEqual([PERSONAL.id])
    expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ startupPaneKey: expect.any(String) })
    )
  })

  it('pins a chat-UI worker under the session id it is created with', async () => {
    const router = installRouter()
    const f = fakes(router)
    await place(f, { mode: STRUCTURED, existing: true, claudeAccountId: TEAM.id })
    expect(state.sessionCreates).toHaveLength(1)
    expect(state.sessionCreates[0].pinned).toBe(TEAM.id)
    expect(pinKeys(router)).toEqual([state.sessionCreates[0].sessionId])
  })

  it('pins nothing and passes no reserved identity without an account', async () => {
    const router = installRouter()
    const f = fakes(router)
    await place(f, { mode: TERMINAL, existing: true })
    expect(f.runtime.createTerminal).toHaveBeenCalledWith(
      'id:wt_existing',
      expect.not.objectContaining({ tabId: expect.anything() })
    )
    expect(pinKeys(router)).toEqual([])
  })
})

describe('which account a new worker starts under', () => {
  const terminalCreator = (paneKey: string) => () => ({
    kind: 'terminal' as const,
    handle: 'term_coord',
    paneKey
  })

  it('inherits the coordinator terminal pane pin at worker-start', () => {
    const router = installRouter()
    claudeChatAccountPinsFor(router).set('terminal:tab-c:leaf-c', PERSONAL.id)
    expect(
      workerClaudeLaunchAccount({
        explicitAccountId: undefined,
        agent: 'claude',
        reusesTerminal: false,
        creator: terminalCreator('tab-c:leaf-c'),
        router
      })
    ).toBe(PERSONAL.id)
  })

  it('inherits a chat-UI coordinator pin by its Orca session id', () => {
    const router = installRouter()
    claudeChatAccountPinsFor(router).set('coord-session', TEAM.id)
    expect(
      workerClaudeLaunchAccount({
        explicitAccountId: undefined,
        agent: 'claude',
        reusesTerminal: false,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test id stands in for a branded Orca session id.
        creator: () => ({ kind: 'session', orcaSessionId: 'coord-session' as never }),
        router
      })
    ).toBe(TEAM.id)
  })

  it('lets an explicit --account win over the coordinator pin', () => {
    const router = installRouter()
    claudeChatAccountPinsFor(router).set('terminal:tab-c:leaf-c', PERSONAL.id)
    expect(
      workerClaudeLaunchAccount({
        explicitAccountId: TEAM.id,
        agent: 'claude',
        reusesTerminal: false,
        creator: terminalCreator('tab-c:leaf-c'),
        router
      })
    ).toBe(TEAM.id)
  })

  it('follows the global selection under an unpinned coordinator', () => {
    const router = installRouter()
    claudeChatAccountPinsFor(router).set('terminal:other:pane', PERSONAL.id)
    expect(
      workerClaudeLaunchAccount({
        explicitAccountId: undefined,
        agent: 'claude',
        reusesTerminal: false,
        creator: terminalCreator('tab-c:leaf-c'),
        router
      })
    ).toBeNull()
  })

  it('never pins a reused terminal or a non-Claude worker it inherits for', () => {
    const router = installRouter()
    claudeChatAccountPinsFor(router).set('terminal:tab-c:leaf-c', PERSONAL.id)
    const base = { explicitAccountId: undefined, creator: terminalCreator('tab-c:leaf-c'), router }
    expect(workerClaudeLaunchAccount({ ...base, agent: 'claude', reusesTerminal: true })).toBeNull()
    expect(workerClaudeLaunchAccount({ ...base, agent: 'codex', reusesTerminal: false })).toBeNull()
  })

  it('refuses an explicit --account for a worker that resolves to another agent', () => {
    const router = installRouter()
    expect(() =>
      workerClaudeLaunchAccount({
        explicitAccountId: TEAM.id,
        agent: 'codex',
        reusesTerminal: false,
        creator: terminalCreator('tab-c:leaf-c'),
        router
      })
    ).toThrow(/--account applies only to Claude/)
  })
})

describe('explicit worker-start --account validation', () => {
  const owner = { callerScope: undefined }

  it('resolves an id or a full email to the account id', () => {
    const router = installRouter()
    expect(resolveWorkerStartClaudeAccount({ account: 'ME@example.com' }, owner, router)).toBe(
      PERSONAL.id
    )
    expect(resolveWorkerStartClaudeAccount({ account: TEAM.id }, owner, router)).toBe(TEAM.id)
    expect(resolveWorkerStartClaudeAccount({}, owner, router)).toBeUndefined()
  })

  it('refuses an unknown account, listing the valid ones, and writes no pin', () => {
    const router = installRouter()
    let error: unknown
    try {
      resolveWorkerStartClaudeAccount({ account: 'nobody@example.com' }, owner, router)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(OrchestrationError)
    expect(error).toMatchObject({ code: 'invalid_argument' })
    expect(String(error)).toContain(TEAM.id)
    expect(String(error)).toContain('me@example.com')
    expect(pinKeys(router)).toEqual([])
  })

  it('refuses another agent, --terminal and --on', () => {
    const router = installRouter()
    expect(() =>
      resolveWorkerStartClaudeAccount({ account: TEAM.id, agent: 'codex' }, owner, router)
    ).toThrow(/only to Claude/)
    expect(() =>
      resolveWorkerStartClaudeAccount({ account: TEAM.id, terminal: 'term_x' }, owner, router)
    ).toThrow(/--terminal/)
    expect(() =>
      resolveWorkerStartClaudeAccount({ account: TEAM.id, on: 'server-2' }, owner, router)
    ).toThrow(/--on/)
  })

  it('refuses when the host has no managed Claude accounts', () => {
    expect(() =>
      resolveWorkerStartClaudeAccount({ account: TEAM.id }, owner, {
        pointerPath: '/nowhere/selected-host',
        listAccounts: () => []
      })
    ).toThrow(/no Orca-managed Claude accounts/)
  })
})
