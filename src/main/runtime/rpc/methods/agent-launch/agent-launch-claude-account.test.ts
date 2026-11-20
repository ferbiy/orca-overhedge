// Overhedge: agent.launch `claudeAccount` (`--account` on `orca agent launch` and
// `orca worktree create --agent claude`) validates first and pins the new chat before it starts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../../../../shared/agent-accounts/managed-account-types'
import { AgentLaunch } from '../../../../../shared/rpc-contract/agent-launch/agent-launch-params'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'
import { computeAgentLaunchFingerprint } from '../../../../../shared/agent-launch/contracts/agent-launch-operation'
import type { AgentLaunchResult } from '../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { claudeChatAccountPinsFor } from '../../../../claude-accounts/chat-pins/claude-chat-account-pin-store'
import {
  pinnedClaudeAccountForChat,
  pinnedClaudeAccountForTerminal
} from '../../../../claude-accounts/chat-pins/claude-chat-account-pins'
import {
  coordinatorClaudeLaunchAccount,
  reserveClaudeLaunchIdentity
} from '../../../../claude-accounts/chat-pins/claude-chat-account-launch'
import { InvalidArgumentError } from '../../core'
import { reserveAgentLaunchClaudeAccount } from './agent-launch-claude-account'

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
const OPERATION = '1763500000000-0123456789abcdef0123456789abcdef'

let dir: string | undefined
function router() {
  dir = mkdtempSync(join(tmpdir(), 'launch-account-'))
  return {
    pointerPath: join(dir, 'claude-profiles', 'selected-host'),
    listAccounts: () => [TEAM, PERSONAL]
  }
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

const owner = { callerScope: undefined }

function launch(fields: Record<string, unknown>) {
  return AgentLaunch.parse({
    agent: 'claude',
    target: { kind: 'existing', worktree: 'id:wt_1' },
    ...fields
  })
}

function result(kind: 'terminal' | 'structured'): AgentLaunchResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settle reads only outcome.kind.
  return { outcome: { kind } } as AgentLaunchResult
}

describe('agent.launch claudeAccount', () => {
  it('is an optional field older callers never send', () => {
    expect(launch({}).claudeAccount).toBeUndefined()
    expect(launch({ claudeAccount: 'me@example.com' }).claudeAccount).toBe('me@example.com')
  })

  it('pins the reserved pane and chat before the launch runs, and strips the field', () => {
    const r = router()
    const reserved = reserveAgentLaunchClaudeAccount(
      launch({ claudeAccount: 'ME@example.com' }),
      owner,
      r
    )
    expect('claudeAccount' in reserved.params).toBe(false)
    const paneKey = reserved.params.paneKey ?? ''
    const sessionId = reserved.params.sessionId ?? ''
    expect(parsePaneKey(paneKey)).not.toBeNull()
    expect(isOrcaSessionId(sessionId)).toBe(true)
    // What the terminal spawn and the chat launch would each read, before either exists.
    expect(pinnedClaudeAccountForTerminal(r, paneKey)).toEqual({
      accountId: PERSONAL.id,
      source: 'pin'
    })
    expect(pinnedClaudeAccountForChat(r, sessionId)?.accountId).toBe(PERSONAL.id)
  })

  it('keeps a caller-reserved pane and session id', () => {
    const r = router()
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const reserved = reserveAgentLaunchClaudeAccount(
      launch({ claudeAccount: TEAM.id, paneKey, sessionId: 'claude_abc' }),
      owner,
      r
    )
    expect(reserved.params).toMatchObject({ paneKey, sessionId: 'claude_abc' })
    expect(claudeChatAccountPinsFor(r).all()).toEqual({
      [`terminal:${paneKey}`]: TEAM.id,
      claude_abc: TEAM.id
    })
  })

  it('drops the pin of the identity the launch did not use', () => {
    const r = router()
    const terminal = reserveAgentLaunchClaudeAccount(launch({ claudeAccount: TEAM.id }), owner, r)
    terminal.settle(result('terminal'))
    expect(Object.keys(claudeChatAccountPinsFor(r).all())).toEqual([
      `terminal:${terminal.params.paneKey}`
    ])
    const chat = reserveAgentLaunchClaudeAccount(launch({ claudeAccount: TEAM.id }), owner, r)
    chat.settle(result('structured'))
    expect(claudeChatAccountPinsFor(r).get(chat.params.sessionId ?? '')).toBe(TEAM.id)
    expect(claudeChatAccountPinsFor(r).get(`terminal:${chat.params.paneKey}`)).toBeNull()
  })

  it('reserves the same identities, and fingerprint, when a launch operation is retried', () => {
    const r = router()
    const first = reserveAgentLaunchClaudeAccount(
      launch({ claudeAccount: TEAM.id, operationId: OPERATION }),
      owner,
      r
    )
    const retry = reserveAgentLaunchClaudeAccount(
      launch({ claudeAccount: TEAM.id, operationId: OPERATION }),
      owner,
      r
    )
    expect(retry.params).toEqual(first.params)
    expect(computeAgentLaunchFingerprint(retry.params)).toBe(
      computeAgentLaunchFingerprint(first.params)
    )
    expect(reserveClaudeLaunchIdentity(undefined)).not.toEqual(reserveClaudeLaunchIdentity(undefined))
  })

  it('leaves a launch without claudeAccount untouched', () => {
    const r = router()
    const reserved = reserveAgentLaunchClaudeAccount(launch({}), owner, r)
    expect(reserved.params).toEqual(launch({}))
    expect(claudeChatAccountPinsFor(r).all()).toEqual({})
  })

  it('refuses an unknown account before anything is pinned, listing the valid names', () => {
    const r = router()
    let error: unknown
    try {
      reserveAgentLaunchClaudeAccount(launch({ claudeAccount: 'nobody@example.com' }), owner, r)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(InvalidArgumentError)
    expect(String(error)).toContain('me@example.com (id bbbb2222-personal)')
    expect(String(error)).toContain('nothing was started')
    expect(claudeChatAccountPinsFor(r).all()).toEqual({})
  })

  it('refuses an ambiguous account', () => {
    const r = {
      ...router(),
      listAccounts: () => [TEAM, { ...PERSONAL, email: TEAM.email }]
    }
    expect(() =>
      reserveAgentLaunchClaudeAccount(launch({ claudeAccount: TEAM.email }), owner, r)
    ).toThrow(/names several accounts/)
  })

  it('refuses another agent and a reused terminal', () => {
    const r = router()
    expect(() =>
      reserveAgentLaunchClaudeAccount(
        AgentLaunch.parse({
          agent: 'codex',
          target: { kind: 'existing', worktree: 'id:wt_1' },
          claudeAccount: TEAM.id
        }),
        owner,
        r
      )
    ).toThrow(/only to Claude/)
    expect(() =>
      reserveAgentLaunchClaudeAccount(
        launch({ claudeAccount: TEAM.id, reuseTerminal: { handle: 'term_1' } }),
        owner,
        r
      )
    ).toThrow(/reused terminal/)
    expect(claudeChatAccountPinsFor(r).all()).toEqual({})
  })

  it('refuses a client without the accounts-admin permission', () => {
    const r = router()
    expect(() =>
      reserveAgentLaunchClaudeAccount(
        launch({ claudeAccount: TEAM.id }),
        { callerScope: { kind: 'mobile' } },
        r
      )
    ).toThrow()
    expect(claudeChatAccountPinsFor(r).all()).toEqual({})
  })
})

describe('coordinatorClaudeLaunchAccount', () => {
  it('reads the coordinator session pin, then its pane pin, else null', () => {
    const r = router()
    expect(coordinatorClaudeLaunchAccount(r, { orcaSessionId: 's1', paneKey: 'tab:leaf' })).toBeNull()
    claudeChatAccountPinsFor(r).set('terminal:tab:leaf', TEAM.id)
    expect(coordinatorClaudeLaunchAccount(r, { orcaSessionId: 's1', paneKey: 'tab:leaf' })).toBe(
      TEAM.id
    )
    claudeChatAccountPinsFor(r).set('s1', PERSONAL.id)
    expect(coordinatorClaudeLaunchAccount(r, { orcaSessionId: 's1', paneKey: 'tab:leaf' })).toBe(
      PERSONAL.id
    )
    expect(coordinatorClaudeLaunchAccount(undefined, { orcaSessionId: 's1' })).toBeNull()
  })
})
