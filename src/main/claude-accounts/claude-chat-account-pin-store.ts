// Overhedge: the on-disk map of per-chat Claude account pins (ids only, no credentials).
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

export const CLAUDE_CHAT_ACCOUNT_PINS_FILE = 'chat-account-pins.json'

/** How long a cached read is trusted before the file's size and mtime are checked again. */
const PIN_FILE_RECHECK_MS = 1_000

type PinRead = { chats: Readonly<Record<string, string>>; corrupt: boolean }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Null when the text is not a pin file this build can read. */
export function parseClaudeChatAccountPinFile(text: string): Record<string, string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.chats)) {
    return null
  }
  const chats: Record<string, string> = {}
  for (const [chatId, accountId] of Object.entries(parsed.chats)) {
    if (typeof accountId === 'string' && accountId) {
      chats[chatId] = accountId
    }
  }
  return chats
}

export class ClaudeChatAccountPins {
  private cached: (PinRead & { mtimeMs: number; size: number; checkedAt: number }) | null = null

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now
  ) {}

  /** Cached; re-validated against the file's size and mtime at most once a second, and replaced
   *  on every write, so sends and spawns do not read the file each time. */
  private read(): PinRead {
    const at = this.now()
    const cached = this.cached
    if (cached && at - cached.checkedAt < PIN_FILE_RECHECK_MS) {
      return cached
    }
    let stat: { mtimeMs: number; size: number }
    try {
      stat = statSync(this.path)
    } catch {
      this.cached = { chats: {}, corrupt: false, mtimeMs: -1, size: -1, checkedAt: at }
      return this.cached
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.checkedAt = at
      return cached
    }
    let text: string | null
    try {
      text = readFileSync(this.path, 'utf8')
    } catch {
      text = null
    }
    const chats = text === null ? null : parseClaudeChatAccountPinFile(text)
    // A corrupt pin file must not stop launches; chats then follow the global selection.
    this.cached = {
      chats: chats ?? {},
      corrupt: chats === null,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      checkedAt: at
    }
    return this.cached
  }

  get(chatId: string): string | null {
    const value = this.read().chats[chatId]
    return typeof value === 'string' && value ? value : null
  }

  hasAny(): boolean {
    return Object.keys(this.read().chats).length > 0
  }

  /** One read-modify-write. Writes are synchronous, so calls in this process never interleave; the
   *  file is replaced atomically, and a corrupt file is copied aside first instead of lost. */
  update(change: (chats: Record<string, string>) => void): void {
    this.cached = null
    const current = this.read()
    const chats = { ...current.chats }
    change(chats)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    if (current.corrupt) {
      copyFileSync(this.path, `${this.path}.corrupt-${this.now()}`)
    }
    writeFileAtomically(this.path, `${JSON.stringify({ version: 1, chats }, null, 2)}\n`, {
      mode: 0o600
    })
    this.cached = null
  }

  set(chatId: string, accountId: string | null): void {
    this.update((chats) => {
      if (accountId) {
        chats[chatId] = accountId
      } else {
        delete chats[chatId]
      }
    })
  }

  all(): Record<string, string> {
    return { ...this.read().chats }
  }
}

const byPath = new Map<string, ClaudeChatAccountPins>()

/** Pins live beside the router's `selected-host` pointer (`<userData>/claude-profiles`). */
export function claudeChatAccountPinsFor(router: { pointerPath: string }): ClaudeChatAccountPins {
  const path = join(dirname(router.pointerPath), CLAUDE_CHAT_ACCOUNT_PINS_FILE)
  let pins = byPath.get(path)
  if (!pins) {
    pins = new ClaudeChatAccountPins(path)
    byPath.set(path, pins)
  }
  return pins
}
