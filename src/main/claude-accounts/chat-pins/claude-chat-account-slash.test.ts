import { describe, expect, it } from 'vitest'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session/agent-session-wire'
import { parseAccountSlashCommand, withOrcaAccountCommands } from './claude-chat-account-slash'

describe('withOrcaAccountCommands', () => {
  const base: AgentSessionSlashCommand[] = [{ name: 'compact', kind: 'command' }]

  it('adds both commands with hints to a Claude catalog, once per report', () => {
    const added = withOrcaAccountCommands('claude', base, true)
    expect(added?.map((command) => command.name)).toEqual([
      'compact',
      'orca-account',
      'orca-migrate'
    ])
    expect(added?.slice(1).every((command) => command.argumentHint && command.description)).toBe(
      true
    )
    // Subscribers compare catalogs by identity.
    expect(withOrcaAccountCommands('claude', base, true)).toBe(added)
    expect(withOrcaAccountCommands('claude', added, true)).toBe(added)
  })

  it('leaves other agents, unknown catalogs and hosts without accounts alone', () => {
    expect(withOrcaAccountCommands('codex', base, true)).toBe(base)
    expect(withOrcaAccountCommands(undefined, base, true)).toBe(base)
    expect(withOrcaAccountCommands('claude', undefined, true)).toBeUndefined()
    expect(withOrcaAccountCommands('claude', base, false)).toBe(base)
  })

  it('offers only commands the chat intercepts', () => {
    const added = withOrcaAccountCommands('claude', [], true) ?? []
    for (const command of added) {
      expect(parseAccountSlashCommand(`/${command.name}`)).not.toBeNull()
    }
  })
})
