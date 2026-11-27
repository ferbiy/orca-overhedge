// Overhedge: argument completion for Orca's own chat commands.
import { describe, expect, it } from 'vitest'
import type { AgentSessionSlashCommand } from '../../../agent-session/agent-session-wire'
import { sessionSlashCommandSuggestions } from '../commands/native-chat-slash-commands'
import {
  applyOrcaSlashArgument,
  deriveOrcaSlashArgumentAutocomplete,
  isOrcaSlashArgumentItem,
  orcaSlashCommandNeedsArgument,
  readOrcaSlashArguments,
  type WithOrcaSlashArguments
} from './orca-command-arguments'
import type { NativeChatPickerItem } from './native-chat-picker-items'

const accounts = [
  { value: 'team@example.com', description: 'id aaaa1111' },
  { value: 'me@example.com', hint: 'current', description: 'id bbbb2222' },
  { value: 'auto', description: 'Remove the pin' }
]
const reported: (AgentSessionSlashCommand & WithOrcaSlashArguments)[] = [
  { name: 'compact', kind: 'command' },
  {
    name: 'orca-account',
    kind: 'command',
    argumentHint: '[<account>|auto]',
    orcaArguments: { positions: [accounts] }
  },
  {
    name: 'orca-migrate',
    kind: 'command',
    orcaArguments: { positions: [accounts, [{ value: '--with-workers' }]], required: true }
  },
  {
    name: 'rc',
    kind: 'command',
    orcaArguments: { positions: [[{ value: 'on', hint: '[name]' }, { value: 'off' }, { value: 'status' }]] }
  }
]
const commands = sessionSlashCommandSuggestions('claude', reported)

function values(before: string, dismissed: string | null = null): string[] | null {
  const menu = deriveOrcaSlashArgumentAutocomplete(before, commands, dismissed)
  if (!menu) {
    return null
  }
  return menu.mode === 'slash' ? menu.items.map((item) => item.token) : []
}

describe('reported rows', () => {
  it('keep their argument values in the composer catalog', () => {
    const row = commands.find((command) => command.name === 'orca-migrate')
    expect(readOrcaSlashArguments(row)?.required).toBe(true)
    expect(readOrcaSlashArguments(commands.find((command) => command.name === 'compact'))).toBe(
      undefined
    )
  })

  it('drop malformed values', () => {
    expect(readOrcaSlashArguments({ orcaArguments: { positions: 'x' } })).toBeUndefined()
    expect(
      readOrcaSlashArguments({
        orcaArguments: { positions: [[{ value: 'two words' }, { value: 3 }, { value: 'ok' }]] }
      })?.positions
    ).toEqual([[{ value: 'ok' }]])
  })
})

describe('deriveOrcaSlashArgumentAutocomplete', () => {
  it('lists the accounts after the command and a space', () => {
    expect(values('/orca-account ')).toEqual(['team@example.com', 'me@example.com', 'auto'])
    const menu = deriveOrcaSlashArgumentAutocomplete('/orca-account ', commands, null)
    expect(menu).toMatchObject({ mode: 'slash', dispatchable: false, grouped: false })
    if (menu?.mode === 'slash') {
      expect(menu.items[1]).toMatchObject({ argumentHint: 'current', description: 'id bbbb2222' })
      expect(menu.items.every(isOrcaSlashArgumentItem)).toBe(true)
    }
  })

  it('filters by the typed word, prefix matches first', () => {
    expect(values('/orca-migrate m')).toEqual(['me@example.com', 'team@example.com', 'auto'])
    expect(values('/orca-migrate au')).toEqual(['auto'])
  })

  it('offers --with-workers after the account of /orca-migrate, nothing after /orca-account', () => {
    expect(values('/orca-migrate me@example.com ')).toEqual(['--with-workers'])
    expect(values('/orca-account me@example.com ')).toBeNull()
  })

  it('stays closed for a fully typed value, an unknown word, other commands and other lines', () => {
    expect(values('/orca-account auto')).toBeNull()
    expect(values('/rc myproject')).toBeNull()
    expect(values('/rc ')).toEqual(['on', 'off', 'status'])
    expect(values('/compact ')).toBeNull()
    expect(values('/orca-account')).toBeNull()
    expect(values('hello /orca-account ')).toBeNull()
    expect(values('/orca-account \n')).toBeNull()
  })

  it('honours Escape on the same word', () => {
    const menu = deriveOrcaSlashArgumentAutocomplete('/orca-account t', commands, null)
    const key = menu?.mode === 'slash' ? menu.triggerKey : ''
    expect(values('/orca-account te', key)).toEqual([])
    expect(values('/orca-migrate me@example.com ', key)).toEqual(['--with-workers'])
  })
})

describe('applyOrcaSlashArgument', () => {
  const pick = (token: string) =>
    ({
      kind: 'command',
      id: `orca-arg:${token}`,
      name: token,
      token,
      skillCollision: false
    }) satisfies NativeChatPickerItem

  it('replaces the word at the caret and adds one space', () => {
    expect(applyOrcaSlashArgument('/orca-account te', 16, pick('team@example.com'))).toMatchObject({
      draft: '/orca-account team@example.com ',
      caret: 31
    })
    const draft = '/orca-migrate me --with-workers'
    expect(applyOrcaSlashArgument(draft, 15, pick('me@example.com')).draft).toBe(
      '/orca-migrate me@example.com --with-workers'
    )
  })
})

describe('orcaSlashCommandNeedsArgument', () => {
  const row = (name: string): NativeChatPickerItem => ({
    kind: 'command',
    id: `command:${name}`,
    name,
    token: `/${name}`,
    skillCollision: false
  })

  it('is true only for a command whose bare form is a usage error', () => {
    expect(orcaSlashCommandNeedsArgument(commands, row('orca-migrate'))).toBe(true)
    expect(orcaSlashCommandNeedsArgument(commands, row('orca-account'))).toBe(false)
    expect(orcaSlashCommandNeedsArgument(commands, row('compact'))).toBe(false)
  })
})
