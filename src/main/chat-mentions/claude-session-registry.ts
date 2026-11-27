// Overhedge: the live Claude Code sessions on this host, as the composer's "Open chats" mentions
// read their names. See OVERHEDGE.md, "Chat mentions of open chats".
//
// Claude Code lists its peers from `<config dir>/sessions/<pid>.json`; our fork links every
// managed account's folder to the default one (claude-profile-shared-sessions.ts), so one folder
// holds every account's sessions. Only the `<pid>.json` records are read, never the `.key` files.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import {
  readUserClaudeConfigDir,
  resolveClaudeDefaultHome
} from '../claude-accounts/profiles/claude-profile-paths'
import { CLAUDE_SHARED_SESSIONS_DIR } from '../claude-accounts/profiles/setup/claude-profile-shared-sessions'

export type ClaudeLiveSession = {
  pid: number
  sessionId: string
  name: string | null
  /** Claude's own word for who chose the name: `user` for `/rename` or `--name`. */
  nameSource: string | null
}

export type ClaudeSessionRegistryDeps = {
  dir: string
  readdir: (dir: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
  isAlive: (pid: number) => boolean
  now: () => number
}

const CACHE_MS = 2_000
const RECORD = /^\d+\.json$/

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function defaultDeps(): ClaudeSessionRegistryDeps {
  return {
    dir: join(
      resolveClaudeDefaultHome(homedir(), readUserClaudeConfigDir(process.env)),
      CLAUDE_SHARED_SESSIONS_DIR
    ),
    readdir: (dir) => readdir(dir),
    readFile: (path) => readFile(path, 'utf8'),
    isAlive: pidAlive,
    now: Date.now
  }
}

// The fields read from a `<pid>.json` record; Claude writes more, which are ignored.
const sessionRecord = lazyZodSchema(() =>
  z.object({
    pid: z.number().int().positive(),
    sessionId: z.string().min(1),
    name: z.string().nullable().optional(),
    nameSource: z.string().nullable().optional()
  })
)

/** One record, or null when it is not a live session's. */
export function parseClaudeSessionRecord(
  raw: string,
  isAlive: (pid: number) => boolean
): ClaudeLiveSession | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = sessionRecord.safeParse(json)
  if (!parsed.success || !isAlive(parsed.data.pid)) {
    return null
  }
  const { pid, sessionId, name, nameSource } = parsed.data
  return { pid, sessionId, name: name?.trim() ? name : null, nameSource: nameSource || null }
}

/** The host's live Claude sessions by session id, read at most every 2 s. */
export function createClaudeSessionRegistry(deps: () => ClaudeSessionRegistryDeps = defaultDeps) {
  let cached: { at: number; sessions: Promise<Map<string, ClaudeLiveSession>> } | null = null
  const read = async (d: ClaudeSessionRegistryDeps) => {
    const sessions = new Map<string, ClaudeLiveSession>()
    let names: string[]
    try {
      names = await d.readdir(d.dir)
    } catch {
      return sessions
    }
    await Promise.all(
      names
        .filter((name) => RECORD.test(name))
        .map(async (name) => {
          try {
            const session = parseClaudeSessionRecord(await d.readFile(join(d.dir, name)), d.isAlive)
            if (session) {
              sessions.set(session.sessionId, session)
            }
          } catch {
            // A session that just ended removes its record.
          }
        })
    )
    return sessions
  }
  return {
    bySessionId(): Promise<ReadonlyMap<string, ClaudeLiveSession>> {
      const d = deps()
      if (!cached || d.now() - cached.at > CACHE_MS) {
        cached = { at: d.now(), sessions: read(d) }
      }
      return cached.sessions
    }
  }
}

export const claudeSessionRegistry = createClaudeSessionRegistry()
