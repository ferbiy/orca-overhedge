import { describe, expect, it } from 'vitest'

import { buildHandlerRoutes, dispatch, type HandlerContext } from './dispatch'
import { HANDLER_GROUPS, type HandlerGroup } from './handler-group-manifest'
import { ACCOUNT_COMMAND_SPECS } from './specs/account'
import { CLI_BOOLEAN_FLAGS } from '../shared/cli-argument-boundary'
import { COMMAND_SPECS } from './specs/index'
import { formatCommandHelp } from './help'

describe('duplicate command keys', () => {
  const group = (name: string, keys: string[]): HandlerGroup => ({
    name,
    keys,
    load: async () => ({})
  })

  it('rejects the same key claimed by two groups', () => {
    expect(() =>
      buildHandlerRoutes([group('alpha', ['ship it']), group('beta', ['ship it'])])
    ).toThrow('Duplicate CLI handler registration for "ship it" (alpha and beta)')
  })

  it('rejects a key duplicated inside one group list', () => {
    expect(() => buildHandlerRoutes([group('alpha', ['ship it', 'ship it'])])).toThrow(
      'Duplicate CLI handler registration for "ship it"'
    )
  })
})

describe('dispatch errors', () => {
  const ctx = {
    flags: new Map(),
    cwd: '/tmp',
    json: false
  } as unknown as HandlerContext

  it('reports an unknown command with the joined path', async () => {
    await expect(dispatch(['not', 'a', 'command'], ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unknown command: not a command'
    })
  })
})

describe('account handler group', () => {
  const group = HANDLER_GROUPS.find((entry) => entry.name === 'account')

  it('routes every handler the account module exports, and nothing else', async () => {
    expect(group).toBeDefined()
    const handlers = await group?.load()
    expect([...(group?.keys ?? [])].sort()).toEqual(Object.keys(handlers ?? {}).sort())
  })

  it('routes every account command spec', () => {
    const routes = buildHandlerRoutes(HANDLER_GROUPS)
    for (const spec of ACCOUNT_COMMAND_SPECS) {
      expect(routes.has(spec.path.join(' ')), spec.path.join(' ')).toBe(true)
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
      expect(buildHandlerRoutes(HANDLER_GROUPS).has(command)).toBe(true)
      expect(spec && formatCommandHelp(spec)).toContain(
        'Start Claude under this Orca-managed Claude account'
      )
    })
  }
})
