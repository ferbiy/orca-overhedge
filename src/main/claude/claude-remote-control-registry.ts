// overhedge: per-chat Claude Code Remote Control state (see claude-remote-control.ts).
import type { ClaudeRemoteControlCommand, ClaudeRemoteControlResponse } from './claude-remote-control'

/** The part of a Claude connection this feature uses. */
export type ClaudeRemoteControlConnection = {
  remoteControl?: (
    enabled: boolean,
    name?: string,
    options?: { timeoutMs?: number }
  ) => Promise<ClaudeRemoteControlResponse>
  initializationResult: () => Promise<unknown>
  /** True once the child was closed. */
  readonly closed?: boolean
  /** Settles when the child's process ended. */
  exited?: Promise<unknown>
}

const running = (connection: ClaudeRemoteControlConnection | undefined) =>
  connection !== undefined && connection.closed !== true

export type ClaudeRemoteControlNote = { text: string; tone?: 'warning' | 'error' }
type NoteWriter = (sessionId: string, note: ClaudeRemoteControlNote) => Promise<boolean>

/** Bridge registration makes network round trips, so allow longer than ordinary controls. */
export const CLAUDE_REMOTE_CONTROL_TIMEOUT_MS = 60_000

type SessionState = {
  /** The running Claude child; absent once it exited (the chat starts a new one on its next send). */
  connection?: ClaudeRemoteControlConnection
  /** The user asked for Remote Control and has not turned it off. */
  wanted: boolean
  name?: string
  url?: string
  /** The connection Remote Control is known to run on. */
  enabledOn?: ClaudeRemoteControlConnection
  /** Toggles of one chat run one at a time, in the order they were sent. */
  queue: Promise<unknown>
}

function unsupportedNote(detail: string): string {
  return `Remote Control is unavailable: ${detail}`
}

const NOT_RUNNING = unsupportedNote(
  "this chat's Claude process is not running. Send a message to start it, then run /rc again."
)

/** Turn CLI/SDK failures into text a person can act on. */
export function claudeRemoteControlErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/Query closed before response received/u.test(message)) {
    return unsupportedNote(
      "this chat's Claude process stopped. Send a message to start it, then run /rc again."
    )
  }
  if (/unsupported|unknown (?:control )?request|not supported/iu.test(message)) {
    return unsupportedNote(
      `this Claude Code version does not support it in Orca chats (${message}). Update Claude Code.`
    )
  }
  if (/timed out/iu.test(message)) {
    return unsupportedNote(`Claude did not answer in time (${message}).`)
  }
  return unsupportedNote(message)
}

function availabilityProblem(initialization: unknown): string | null {
  if (initialization === null || typeof initialization !== 'object') {
    return null
  }
  const available: unknown =
    'remote_control_available' in initialization
      ? initialization.remote_control_available
      : undefined
  return available === false
    ? "Claude reports it is not available for this chat's account. It needs a claude.ai Pro, Max, Team or Enterprise login (not an API key), and no custom ANTHROPIC_BASE_URL."
    : null
}

/** A child still starting answers its initialization late; never wait on it without a limit. */
function initialized(connection: ClaudeRemoteControlConnection, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for Claude to start (${timeoutMs} ms)`)),
      timeoutMs
    )
  })
  return Promise.race([connection.initializationResult(), timeout]).finally(() =>
    clearTimeout(timer)
  )
}

/** Per-chat Remote Control state; in memory, so an Orca restart forgets it. */
export class ClaudeRemoteControlRegistry {
  private readonly sessions = new Map<string, SessionState>()
  private readonly noteWriters = new Set<NoteWriter>()

  constructor(private readonly timeoutMs = CLAUDE_REMOTE_CONTROL_TIMEOUT_MS) {}

  /** Called whenever a chat's Claude child is published; re-enables Remote Control the user wanted. */
  observeConnection(sessionId: string, connection: ClaudeRemoteControlConnection): void {
    const previous = this.sessions.get(sessionId)
    if (previous?.connection === connection) {
      return
    }
    const state: SessionState = {
      wanted: previous?.wanted ?? false,
      ...(previous?.name === undefined ? {} : { name: previous.name }),
      connection,
      queue: previous?.queue ?? Promise.resolve()
    }
    this.sessions.set(sessionId, state)
    void connection.exited?.then(
      () => this.observeExit(sessionId, connection),
      () => this.observeExit(sessionId, connection)
    )
    if (state.wanted) {
      void this.enqueue(state, () => this.reenable(sessionId, state, connection))
    }
  }

  /** The chat's child exited or closed: Remote Control ended with it. A chat that wanted it keeps
   *  only that wish (it turns back on with the next child); any other chat is forgotten. */
  observeExit(sessionId: string, connection: ClaudeRemoteControlConnection): void {
    const state = this.sessions.get(sessionId)
    if (!state || state.connection !== connection) {
      return
    }
    if (!state.wanted) {
      this.sessions.delete(sessionId)
      return
    }
    state.connection = undefined
    state.enabledOn = undefined
    state.url = undefined
  }

  addNoteWriter(writer: NoteWriter): () => void {
    this.noteWriters.add(writer)
    return () => this.noteWriters.delete(writer)
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /** The answer when no request to Claude is needed (status, or no running child); else null. */
  immediate(sessionId: string, command: ClaudeRemoteControlCommand): ClaudeRemoteControlNote | null {
    const state = this.sessions.get(sessionId)
    if (state && !running(state.connection) && state.connection) {
      this.observeExit(sessionId, state.connection)
      return this.immediate(sessionId, command)
    }
    if (command.action === 'status') {
      if (state?.wanted && state.connection && state.enabledOn === state.connection) {
        return { text: `Remote Control is on: ${state.url ?? '(no URL reported)'}` }
      }
      if (state?.wanted) {
        return {
          text: state.connection
            ? 'Remote Control is turning on for this chat.'
            : "Remote Control is off: this chat's Claude process is not running. It turns back on when the chat next starts."
        }
      }
      return { text: 'Remote Control is off for this chat.' }
    }
    return state?.connection ? null : { text: NOT_RUNNING, tone: 'warning' }
  }

  /** The row shown while a toggle runs. */
  pending(command: ClaudeRemoteControlCommand): ClaudeRemoteControlNote {
    return { text: `Turning Remote Control ${command.action === 'disable' ? 'off' : 'on'}…` }
  }

  async run(sessionId: string, command: ClaudeRemoteControlCommand): Promise<ClaudeRemoteControlNote> {
    const immediate = this.immediate(sessionId, command)
    const state = this.sessions.get(sessionId)
    if (immediate || !state) {
      return immediate ?? { text: NOT_RUNNING, tone: 'warning' }
    }
    return this.enqueue(state, () => this.toggle(state, command))
  }

  private enqueue<T>(state: SessionState, work: () => Promise<T>): Promise<T> {
    const next = state.queue.then(work, work)
    state.queue = next.catch(() => undefined)
    return next
  }

  private async toggle(
    state: SessionState,
    command: ClaudeRemoteControlCommand
  ): Promise<ClaudeRemoteControlNote> {
    const connection = state.connection
    if (!connection) {
      return { text: NOT_RUNNING, tone: 'warning' }
    }
    if (command.action === 'disable') {
      state.wanted = false
      try {
        await this.request(connection, false)
      } catch (error) {
        state.enabledOn = undefined
        return { text: claudeRemoteControlErrorText(error), tone: 'warning' }
      }
      state.enabledOn = undefined
      state.url = undefined
      return { text: 'Remote Control is off for this chat.' }
    }
    try {
      const problem = availabilityProblem(await initialized(connection, this.timeoutMs))
      if (problem) {
        return { text: unsupportedNote(problem), tone: 'error' }
      }
      const response = await this.request(connection, true, command.action === 'enable' ? command.name : undefined)
      state.wanted = true
      state.name = (command.action === 'enable' ? command.name : undefined) ?? state.name
      state.url = response.session_url ?? response.connect_url
      state.enabledOn = connection
      return { text: this.onText(state.url) }
    } catch (error) {
      return { text: claudeRemoteControlErrorText(error), tone: 'error' }
    }
  }

  private onText(url: string | undefined): string {
    return url
      ? `Remote Control is on. Open ${url} on claude.ai or the Claude app (same account as this chat). Send /rc off to stop.`
      : 'Remote Control is on, but Claude reported no session URL. Find the session under claude.ai/code.'
  }

  private async request(
    connection: ClaudeRemoteControlConnection,
    enabled: boolean,
    name?: string
  ): Promise<ClaudeRemoteControlResponse> {
    if (!connection.remoteControl) {
      throw new Error('this Claude connection has no remote_control request (Agent SDK too old)')
    }
    return connection.remoteControl(enabled, name, { timeoutMs: this.timeoutMs })
  }

  private async reenable(
    sessionId: string,
    state: SessionState,
    connection: ClaudeRemoteControlConnection
  ): Promise<void> {
    const current = () => this.sessions.get(sessionId) === state && state.connection === connection
    if (!current() || !state.wanted) {
      return
    }
    let note: ClaudeRemoteControlNote
    try {
      await initialized(connection, this.timeoutMs)
      const response = await this.request(connection, true, state.name)
      if (!current() || !state.wanted) {
        return
      }
      state.url = response.session_url ?? response.connect_url
      state.enabledOn = connection
      note = { text: `Claude restarted; ${this.onText(state.url)}` }
    } catch (error) {
      if (!current()) {
        return
      }
      state.wanted = false
      state.url = undefined
      note = {
        text: `Claude restarted and Remote Control turned off. ${claudeRemoteControlErrorText(error)}`,
        tone: 'warning'
      }
    }
    await this.writeNote(sessionId, note)
  }

  async writeNote(sessionId: string, note: ClaudeRemoteControlNote): Promise<void> {
    for (const writer of this.noteWriters) {
      try {
        if (await writer(sessionId, note)) {
          return
        }
      } catch {
        // Best effort: a failed note must not fail the session.
      }
    }
  }
}

export const claudeRemoteControl = new ClaudeRemoteControlRegistry()
