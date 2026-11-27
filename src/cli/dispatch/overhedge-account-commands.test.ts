// Overhedge: `orca account migrate` and `--account` on the commands that start a Claude agent are
// routed, parsed as the right kind of flag, and documented.
import { describe, expect, it } from 'vitest'

import { HANDLER_COMMAND_KEYS } from './dispatch'
import { HANDLER_GROUPS } from './handler-group-manifest'
import { ACCOUNT_COMMAND_SPECS } from '../specs/account'
import { CLI_BOOLEAN_FLAGS } from '../../shared/cli/cli-argument-boundary'
import { COMMAND_SPECS } from '../specs/index'
import { formatCommandHelp } from '../discovery/help'

describe('account handler group', () => {
  const group = HANDLER_GROUPS.find((entry) => entry.name === 'account')

  it('routes every handler the account module exports, and nothing else', async () => {
    expect(group).toBeDefined()
    const handlers = await group?.load()
    expect([...(group?.keys ?? [])].sort()).toEqual(Object.keys(handlers ?? {}).sort())
  })

  it('routes every account command spec', () => {
    for (const spec of ACCOUNT_COMMAND_SPECS) {
      expect(HANDLER_COMMAND_KEYS.has(spec.path.join(' ')), spec.path.join(' ')).toBe(true)
    }
  })
})

describe('account migrate flags', () => {
  it('registers its switches as boolean flags, so a following value is never swallowed', () => {
    const spec = ACCOUNT_COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'account migrate')
    for (const flag of ['unpin', 'dry-run', 'restart', 'yes', 'pin-only']) {
      expect(spec?.allowedFlags, flag).toContain(flag)
      expect(CLI_BOOLEAN_FLAGS.has(flag), flag).toBe(true)
    }
    expect(spec?.allowedFlags).not.toContain('now')
    expect(spec?.allowedFlags).toContain('timeout')
    expect(CLI_BOOLEAN_FLAGS.has('timeout')).toBe(false)
  })
})

describe('--account on the commands that start a Claude agent', () => {
  for (const command of ['agent launch', 'worktree create', 'orchestration worker-start']) {
    it(`${command} registers --account as a value flag, routes it and documents it`, () => {
      const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === command)
      expect(spec?.allowedFlags).toContain('account')
      // A value flag: registered as boolean, the account would be parsed as a stray positional.
      expect(CLI_BOOLEAN_FLAGS.has('account')).toBe(false)
      expect(spec?.usage).toContain('[--account <id|email>]')
      expect(HANDLER_COMMAND_KEYS.has(command)).toBe(true)
      expect(spec && formatCommandHelp(spec)).toContain(
        'Start Claude under this Orca-managed Claude account'
      )
    })
  }
})
