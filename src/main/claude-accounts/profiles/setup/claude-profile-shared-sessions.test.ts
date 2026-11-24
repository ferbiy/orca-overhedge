// Overhedge: account folders share Claude's live-session registry and nothing account-bound.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-test-path' } }))
import { shareClaudeProfileHistory } from './claude-profile-history'

const roots: string[] = []
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'claude-profile-sessions-')))
  roots.push(root)
  const userHome = join(root, 'user')
  const defaultHome = join(userHome, '.claude')
  const profiles = [join(root, 'account-a'), join(root, 'account-b')]
  for (const home of profiles) {
    fs.mkdirSync(home)
  }
  const share = (profileHome: string) =>
    shareClaudeProfileHistory({ profileHome, userHome, platform: 'linux' })
  const hub = join(defaultHome, 'sessions')
  return { root, userHome, defaultHome, profiles, share, hub }
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
const KEY = '1001.' + 'a'.repeat(64) + '.key'
// Real symlinks require additional privileges on Windows.
const itLinks = it.skipIf(process.platform === 'win32')

describe('Claude profile live-session sharing', () => {
  itLinks('links every account folder to one owner-only registry', async () => {
    const f = fixture()
    for (const home of f.profiles) {
      expect((await f.share(home)).surfaces.sessions).toBe('linked')
      expect(fs.realpathSync(join(home, 'sessions'))).toBe(f.hub)
    }
    expect(fs.statSync(f.hub).mode & 0o777).toBe(0o700)
    // A record one account's Claude writes is listed from the other.
    fs.writeFileSync(join(f.profiles[0], 'sessions/1001.json'), '{"name":"a"}')
    expect(fs.readdirSync(join(f.profiles[1], 'sessions'))).toEqual(['1001.json'])
  })

  itLinks('moves the records of running sessions without copying them', async () => {
    const f = fixture()
    const [home] = f.profiles
    fs.mkdirSync(join(home, 'sessions'))
    fs.writeFileSync(join(home, 'sessions/1001.json'), 'record')
    fs.writeFileSync(join(home, 'sessions', KEY), 'key', { mode: 0o600 })
    const before = fs.statSync(join(home, 'sessions/1001.json')).ino
    expect((await f.share(home)).surfaces.sessions).toBe('linked')
    expect(fs.statSync(join(f.hub, '1001.json')).ino).toBe(before)
    expect(fs.statSync(join(f.hub, KEY)).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(join(home, 'sessions.orca-profile-merge'))).toBe(false)
  })

  itLinks('survives every later launch and keeps a conflicting name aside', async () => {
    const f = fixture()
    const [home] = f.profiles
    fs.mkdirSync(f.hub, { recursive: true })
    fs.writeFileSync(join(f.hub, '1001.json'), 'shared')
    fs.mkdirSync(join(home, 'sessions'))
    fs.writeFileSync(join(home, 'sessions/1001.json'), 'private')
    const report = await f.share(home)
    expect(report.warnings).toContainEqual(
      expect.objectContaining({ surface: 'sessions', code: 'retained-conflict' })
    )
    expect(fs.readFileSync(join(f.hub, '1001.json'), 'utf8')).toBe('shared')
    expect((await f.share(home)).surfaces.sessions).toBe('unchanged')
    expect(fs.realpathSync(join(home, 'sessions'))).toBe(f.hub)
  })

  itLinks('keeps a link the user pointed elsewhere', async () => {
    const f = fixture()
    const [home] = f.profiles
    const own = join(f.root, 'own-sessions')
    fs.mkdirSync(own)
    fs.symlinkSync(own, join(home, 'sessions'))
    expect((await f.share(home)).surfaces.sessions).toBe('user-owned')
    expect(fs.readlinkSync(join(home, 'sessions'))).toBe(own)
  })

  itLinks('shares no login, account state, daemon or jobs', async () => {
    const f = fixture()
    const [home] = f.profiles
    const own = ['.credentials.json', '.claude.json', 'daemon.lock', 'daemon.status.json']
    for (const name of own) {
      fs.writeFileSync(join(home, name), name, { mode: 0o600 })
    }
    for (const name of ['daemon', 'jobs', 'state']) {
      fs.mkdirSync(join(home, name))
    }
    await f.share(home)
    for (const name of [...own, 'daemon', 'jobs', 'state']) {
      expect(fs.lstatSync(join(home, name)).isSymbolicLink()).toBe(false)
      expect(fs.existsSync(join(f.defaultHome, name))).toBe(false)
    }
    expect(fs.readFileSync(join(home, '.credentials.json'), 'utf8')).toBe('.credentials.json')
  })
})
