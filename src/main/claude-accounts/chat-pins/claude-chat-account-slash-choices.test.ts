// Overhedge: the account values `/orca-account ` and `/orca-migrate ` offer in the composer.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeManagedAccount } from '../../../shared/agent-accounts/managed-account-types'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session/agent-session-wire'
import { readOrcaSlashArguments } from '../../../shared/native-chat/input/composer/orca-command-arguments'
import { claudeChatAccountPinsFor } from './claude-chat-account-pin-store'
import { claudeChatAccountChoices } from './claude-chat-account-slash-choices'
import { withOrcaAccountCommands } from './claude-chat-account-slash'

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
function router(accounts: ClaudeManagedAccount[], selected: string | null = TEAM.id) {
  dir = mkdtempSync(join(tmpdir(), 'slash-choices-'))
  return {
    pointerPath: join(dir, 'claude-profiles', 'selected-host'),
    listAccounts: () => accounts,
    selectedProfile: () => (selected ? { accountId: selected } : null)
  }
}

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

describe('claudeChatAccountChoices', () => {
  it('lists every account by email, then auto, marking the global one for an unpinned chat', () => {
    const choices = claudeChatAccountChoices(router([TEAM, PERSONAL]), 'chat-1')
    expect(choices.map((choice) => choice.value)).toEqual([
      'team@example.com',
      'me@example.com',
      'auto'
    ])
    expect(choices[0]).toMatchObject({ hint: 'global' })
    expect(choices[0].description).toContain('id aaaa1111')
    expect(choices[1].hint).toBeUndefined()
    expect(choices[2]).toMatchObject({ hint: 'current' })
    expect(choices[2].description).toContain('team@example.com')
  })

  it('marks the pinned account as current and auto as not', () => {
    const r = router([TEAM, PERSONAL])
    claudeChatAccountPinsFor(r).set('chat-1', PERSONAL.id)
    const choices = claudeChatAccountChoices(r, 'chat-1')
    expect(choices[1]).toMatchObject({ value: 'me@example.com', hint: 'current' })
    expect(choices[1].description).toContain('pinned')
    expect(choices[0].hint).toBeUndefined()
    expect(choices[2].hint).toBeUndefined()
  })

  it('offers the id when two accounts share an email', () => {
    const twin = account('cccc3333-twin', 'team@example.com')
    const values = claudeChatAccountChoices(router([TEAM, twin]), 'chat-1').map((c) => c.value)
    expect(values).toEqual([TEAM.id, twin.id, 'auto'])
  })

  it('offers nothing on a host without managed accounts', () => {
    expect(claudeChatAccountChoices(router([], null), 'chat-1')).toEqual([])
  })
})

describe('withOrcaAccountCommands with choices', () => {
  const base: AgentSessionSlashCommand[] = [{ name: 'compact', kind: 'command' }]
  const choices = [{ value: 'me@example.com' }, { value: 'auto' }]

  it('attaches the values to both rows and --with-workers to /orca-migrate', () => {
    const rows = withOrcaAccountCommands('claude', base, true, () => choices) ?? []
    const account = readOrcaSlashArguments(rows[1])
    const migrate = readOrcaSlashArguments(rows[2])
    expect(account?.positions).toEqual([choices])
    expect(account?.required).toBeUndefined()
    expect(migrate?.positions.map((p) => p.map((c) => c.value))).toEqual([
      ['me@example.com', 'auto'],
      ['--with-workers']
    ])
    expect(migrate?.required).toBe(true)
  })

  it('keeps one copy per catalog and choices, and a new one when the choices change', () => {
    const first = withOrcaAccountCommands('claude', base, true, () => choices)
    expect(withOrcaAccountCommands('claude', base, true, () => [...choices])).toBe(first)
    const other = withOrcaAccountCommands('claude', base, true, () => [{ value: 'auto' }])
    expect(other).not.toBe(first)
  })

  it('reads the choices only when it extends the catalog', () => {
    let reads = 0
    const count = () => {
      reads += 1
      return choices
    }
    withOrcaAccountCommands('codex', base, true, count)
    withOrcaAccountCommands('claude', undefined, true, count)
    withOrcaAccountCommands('claude', base, false, count)
    expect(reads).toBe(0)
  })
})
