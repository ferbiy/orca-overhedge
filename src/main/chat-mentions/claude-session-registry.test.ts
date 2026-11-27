import { describe, expect, it } from 'vitest'
import {
  createClaudeSessionRegistry,
  type ClaudeSessionRegistryDeps
} from './claude-session-registry'

const files: Record<string, string> = {
  '/s/101.json': JSON.stringify({ pid: 101, sessionId: 'a', name: 'paper', nameSource: 'user' }),
  '/s/102.json': JSON.stringify({
    pid: 102,
    sessionId: 'b',
    name: 'repo-2f',
    nameSource: 'derived'
  }),
  // Its process is gone: a stale record.
  '/s/103.json': JSON.stringify({ pid: 103, sessionId: 'c', name: 'old', nameSource: 'user' }),
  '/s/104.json': '{not json',
  '/s/105.abc.key': 'secret'
}

describe('claude session registry', () => {
  it('lists live sessions from <pid>.json records only, never the key files, read at most every 2 s', async () => {
    const read: string[] = []
    let now = 0
    const deps: ClaudeSessionRegistryDeps = {
      dir: '/s',
      readdir: async () => Object.keys(files).map((path) => path.slice(3)),
      readFile: async (path) => {
        read.push(path)
        return files[path] ?? ''
      },
      isAlive: (pid) => pid !== 103,
      now: () => now
    }
    const registry = createClaudeSessionRegistry(() => deps)
    const sessions = await registry.bySessionId()
    expect([...sessions.values()]).toEqual([
      { pid: 101, sessionId: 'a', name: 'paper', nameSource: 'user' },
      { pid: 102, sessionId: 'b', name: 'repo-2f', nameSource: 'derived' }
    ])
    expect(read.some((path) => path.endsWith('.key'))).toBe(false)
    now = 1_000
    await registry.bySessionId()
    expect(read).toHaveLength(4)
    now = 2_500
    await registry.bySessionId()
    expect(read).toHaveLength(8)
  })

  it('reads none when the folder is missing', async () => {
    const registry = createClaudeSessionRegistry(() => ({
      dir: '/missing',
      readdir: async () => {
        throw new Error('ENOENT')
      },
      readFile: async () => '',
      isAlive: () => true,
      now: () => 0
    }))
    expect((await registry.bySessionId()).size).toBe(0)
  })
})
