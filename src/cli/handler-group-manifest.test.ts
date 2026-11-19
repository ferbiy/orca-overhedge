import { describe, expect, it } from 'vitest'

import { buildHandlerRoutes, dispatch, type HandlerContext } from './dispatch'
import { HANDLER_GROUPS, type HandlerGroup } from './handler-group-manifest'
import { ACCOUNT_COMMAND_SPECS } from './specs/account'

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
