// Overhedge: the orcad server bundle must stay ASCII (config/scripts/orcad-distribution/server-bundle/
// orcad-entry-build.mjs refuses it otherwise, and only in the package build). This catches a
// non-ASCII character in the fork's own source files at unit-test time instead. Write such
// characters as \uXXXX escapes: in a string literal, or via new RegExp(String.raw`...`) for a regex
// (the formatter unescapes regex literals).
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = join(__dirname, '..')
const ROOTS = ['main', 'shared', 'cli']
/** Fork files that predate the `// Overhedge` header convention. */
const UNMARKED_FORK_FILES = [
  'main/claude/claude-remote-control-registry.ts',
  'main/claude/claude-remote-control.ts',
  'main/native-chat/agent-session-wire/structured-agent-session-remote-control.ts'
]
const SOURCE_RE = /\.(?:ts|mts|cts)$/
const TEST_RE = /\.(?:test|spec)\.|\.test-fixture\.|__fixtures__|fixture/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(path)
    }
    return SOURCE_RE.test(entry.name) && !TEST_RE.test(path) ? [path] : []
  })
}

function isForkFile(path: string, text: string): boolean {
  const name = relative(src, path).replaceAll('\\', '/')
  return UNMARKED_FORK_FILES.includes(name) || /overhedge/i.test(text.split('\n', 5).join('\n'))
}

describe('overhedge source files', () => {
  it('contain only ASCII, so the orcad server bundle stays ASCII', () => {
    const offending = ROOTS.flatMap((root) => sourceFiles(join(src, root))).flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      if (!isForkFile(path, text)) {
        return []
      }
      return text.split('\n').flatMap((line, index) => {
        const chars = [...line].filter((char) => (char.codePointAt(0) ?? 0) > 0x7f)
        return chars.length > 0
          ? [
              `${relative(src, path)}:${index + 1}: ${chars.map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`).join(' ')}`
            ]
          : []
      })
    })
    expect(offending).toEqual([])
  })

  it('finds the fork files it is meant to guard', () => {
    const guarded = ROOTS.flatMap((root) => sourceFiles(join(src, root))).filter((path) =>
      isForkFile(path, readFileSync(path, 'utf8'))
    )
    expect(guarded.map((path) => relative(src, path).replaceAll('\\', '/'))).toEqual(
      expect.arrayContaining([
        'main/claude-accounts/claude-terminal-screen-proof.ts',
        'main/runtime/rpc/methods/claude-chat-account-rpc.ts',
        ...UNMARKED_FORK_FILES
      ])
    )
  })
})
