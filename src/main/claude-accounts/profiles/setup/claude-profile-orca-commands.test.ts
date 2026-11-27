// Overhedge: `/orca-account` and `/orca-migrate` for terminal Claude, written by account setup.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installOrcaClaudeCommands,
  ORCA_CLAUDE_COMMAND_FILES,
  ORCA_CLAUDE_COMMAND_MARKER
} from './claude-profile-orca-commands'

const roots: string[] = []
function homes() {
  const root = mkdtempSync(join(tmpdir(), 'orca-commands-'))
  roots.push(root)
  const defaultHome = join(root, '.claude')
  const profileHome = join(root, 'profiles', 'a', 'home')
  mkdirSync(profileHome, { recursive: true })
  return { defaultHome, profileHome }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('installOrcaClaudeCommands', () => {
  it('writes both commands into the default home once', async () => {
    const h = homes()
    expect(await installOrcaClaudeCommands(h)).toBe('synced')
    const folder = join(h.defaultHome, 'commands')
    expect(readdirSync(folder).sort()).toEqual(['orca-account.md', 'orca-migrate.md'])
    expect(await installOrcaClaudeCommands(h)).toBe('unchanged')
  })

  it('rewrites an older Orca copy but never a file of the user', async () => {
    const h = homes()
    const folder = join(h.defaultHome, 'commands')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'orca-account.md'), `old <!-- ${ORCA_CLAUDE_COMMAND_MARKER} -->`)
    writeFileSync(join(folder, 'orca-migrate.md'), 'my own command')
    await installOrcaClaudeCommands(h)
    expect(readFileSync(join(folder, 'orca-account.md'), 'utf8')).toBe(
      ORCA_CLAUDE_COMMAND_FILES['orca-account.md']
    )
    expect(readFileSync(join(folder, 'orca-migrate.md'), 'utf8')).toBe('my own command')
    expect(readdirSync(folder).sort()).toEqual(['orca-account.md', 'orca-migrate.md'])
  })

  it("also fills an account folder's own commands folder, not a linked one twice", async () => {
    const h = homes()
    mkdirSync(join(h.profileHome, 'commands'))
    await installOrcaClaudeCommands(h)
    expect(readdirSync(join(h.profileHome, 'commands')).sort()).toEqual([
      'orca-account.md',
      'orca-migrate.md'
    ])
    const linked = homes()
    mkdirSync(join(linked.defaultHome, 'commands'), { recursive: true })
    symlinkSync(join(linked.defaultHome, 'commands'), join(linked.profileHome, 'commands'))
    expect(await installOrcaClaudeCommands(linked)).toBe('synced')
  })

  it('declares the hint Claude Code shows and runs the pane-scoped CLI', () => {
    const account = ORCA_CLAUDE_COMMAND_FILES['orca-account.md']
    const migrate = ORCA_CLAUDE_COMMAND_FILES['orca-migrate.md']
    expect(account).toMatch(/^---\ndescription: "Orca: [^\n]+"\nargument-hint: "\[<account>\|auto\]"\n/u)
    expect(migrate).toContain('argument-hint: "<account>|auto [--with-workers]"')
    for (const text of [account, migrate]) {
      expect(text).toContain('$ARGUMENTS')
      expect(text).toContain('account migrate --unpin --chat "terminal:$ORCA_PANE_KEY" --dry-run')
      expect(text).toContain('disable-model-invocation: true')
      expect([...text].every((char) => char.charCodeAt(0) < 0x80)).toBe(true)
    }
    expect(migrate).toContain('--with-workers "terminal:$ORCA_PANE_KEY"')
  })
})
