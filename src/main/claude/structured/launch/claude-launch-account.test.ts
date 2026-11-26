import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../../../shared/agent-accounts/managed-account-types'
import { agentSessionAccountHomesEqual } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { claudeChatAccountPinsFor } from '../../../claude-accounts/chat-pins/claude-chat-account-pin-store'
import { claudeAccountPreparation } from '../../../claude-accounts/chat-pins/claude-chat-account-preparation'
import { pinnedClaudeLaunchAccountHome } from '../../../claude-accounts/chat-pins/claude-chat-account-pin-home'
import { prepareClaudeLaunchAccount } from './claude-launch-account'

// The upstream resolver follows the global selection; here the global selection is account B.
vi.mock('../../../runtime/agent-session/environment/structured-agent-account-home', () => ({
  resolveStructuredClaudeAccountHomePath: async () => '/profiles/b'
}))

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

// X was never signed in separately, so the System default login covers it.
const X = account('x', 'x@example.com')
const B = account('b', 'b@example.com')

let dir: string | undefined
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

function routerFixture() {
  dir = mkdtempSync(join(tmpdir(), 'launch-pin-'))
  const reads = {
    pointerPath: join(dir, 'claude-profiles', 'selected-host'),
    coveredBySystemDefault: (id: string) => id === X.id,
    accountHome: (id: string) => `/profiles/${id}`,
    systemDefaultHome: () => '/home/u/.claude'
  }
  return {
    ...reads,
    listAccounts: () => [X, B],
    prepareLaunch: async () => claudeAccountPreparation(reads, B.id),
    prepareLaunchForAccount: async () => {}
  }
}

describe('a chat pinned to the account the System default login covers', () => {
  it('launches under that login while the global selection is another account', async () => {
    const router = routerFixture()
    claudeChatAccountPinsFor(router).set('chat-1', X.id)
    const recipe = await prepareClaudeLaunchAccount(router, {}, '/record/home', 'chat-1')
    expect(recipe).toEqual({ route: 'system', home: '/home/u/.claude', configDir: null })
  })

  it('compares equal to its pin, so the wrong-account check does not restart it on every send', async () => {
    const router = routerFixture()
    claudeChatAccountPinsFor(router).set('chat-1', X.id)
    const recipe = await prepareClaudeLaunchAccount(router, {}, '/record/home', 'chat-1')
    const pinned = pinnedClaudeLaunchAccountHome('chat-1', router)
    expect(pinned).not.toBeNull()
    expect(
      pinned &&
        agentSessionAccountHomesEqual(pinned, { variable: 'CLAUDE_CONFIG_DIR', path: recipe.home })
    ).toBe(true)
  })

  it('keeps upstream routing for an unpinned chat', async () => {
    const router = routerFixture()
    const recipe = await prepareClaudeLaunchAccount(router, {}, '/record/home', 'chat-2')
    expect(recipe).toEqual({ route: 'managed', accountId: B.id, home: '/profiles/b' })
    expect(pinnedClaudeLaunchAccountHome('chat-2', router)).toBeNull()
  })
})
