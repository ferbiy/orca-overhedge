// overhedge: Claude Code Remote Control for structured (chat) Claude sessions.
// Stream-json Claude does not register /remote-control, but accepts the `remote_control` control
// request; the Agent SDK exposes it as the undeclared Query.enableRemoteControl.

import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionSlashCommand } from '../../shared/agent-session/agent-session-wire'

export type ClaudeRemoteControlCommand =
  | { action: 'enable'; name?: string }
  | { action: 'disable' }
  | { action: 'status' }

const COMMAND = /^\/(?:remote-control|rc)(?:\s+([\s\S]*))?$/u

/** Null unless the whole message is `/remote-control` or `/rc` with optional argument. */
export function parseClaudeRemoteControlCommand(text: string): ClaudeRemoteControlCommand | null {
  const match = COMMAND.exec(text.trim())
  if (!match) {
    return null
  }
  const argument = (match[1] ?? '').trim()
  const word = argument.toLowerCase()
  if (word === 'off' || word === 'stop' || word === 'disable') {
    return { action: 'disable' }
  }
  if (word === 'status') {
    return { action: 'status' }
  }
  if (word === '' || word === 'on' || word === 'start' || word === 'enable') {
    return { action: 'enable' }
  }
  return { action: 'enable', name: argument.slice(0, 200) }
}

export type ClaudeRemoteControlResponse = {
  session_url?: string
  connect_url?: string
  environment_id?: string
  bridge_session_id?: string
}

const text = (entry: unknown): string | undefined => (typeof entry === 'string' ? entry : undefined)

/** Keep only the reported URL and ids; other fields are not used. */
function readRemoteControlResponse(value: unknown): ClaudeRemoteControlResponse {
  if (value === null || typeof value !== 'object') {
    return {}
  }
  const sessionUrl = text('session_url' in value ? value.session_url : undefined)
  const connectUrl = text('connect_url' in value ? value.connect_url : undefined)
  const environmentId = text('environment_id' in value ? value.environment_id : undefined)
  const bridgeSessionId = text('bridge_session_id' in value ? value.bridge_session_id : undefined)
  return {
    ...(sessionUrl === undefined ? {} : { session_url: sessionUrl }),
    ...(connectUrl === undefined ? {} : { connect_url: connectUrl }),
    ...(environmentId === undefined ? {} : { environment_id: environmentId }),
    ...(bridgeSessionId === undefined ? {} : { bridge_session_id: bridgeSessionId })
  }
}

/** Runtime check: enableRemoteControl is absent from Query's declaration. */
export function claudeQueryRemoteControl(
  query: Query
): ((enabled: boolean, name?: string) => Promise<ClaudeRemoteControlResponse>) | null {
  const enable = 'enableRemoteControl' in query ? query.enableRemoteControl : null
  return typeof enable === 'function'
    ? async (enabled, name) =>
        readRemoteControlResponse(await enable.call(query, enabled, name))
    : null
}

/** Bridge registration makes network round trips, so allow longer than ordinary controls. */
export const CLAUDE_REMOTE_CONTROL_TIMEOUT_MS = 60_000

export const CLAUDE_REMOTE_CONTROL_SLASH_COMMANDS: AgentSessionSlashCommand[] = [
  {
    name: 'remote-control',
    kind: 'command',
    description: 'Orca: turn Claude Code Remote Control on (off, status) for this chat',
    argumentHint: '[off|status|name]'
  },
  {
    name: 'rc',
    kind: 'command',
    description: 'Orca: alias for /remote-control',
    argumentHint: '[off|status|name]'
  }
]

/** Live catalogs gain Orca's commands when the child can take the request; unknown stays unknown. */
export function withClaudeRemoteControlCommands(
  session:
    | {
        commands: { commands: AgentSessionSlashCommand[] | undefined }
        connection: { remoteControl?: unknown }
      }
    | undefined
): AgentSessionSlashCommand[] | undefined {
  const commands = session?.commands.commands
  if (commands === undefined || typeof session?.connection.remoteControl !== 'function') {
    return commands
  }
  const names = new Set(commands.map((command) => command.name))
  const added = CLAUDE_REMOTE_CONTROL_SLASH_COMMANDS.filter((command) => !names.has(command.name))
  return added.length === 0 ? commands : [...commands, ...added]
}

/** The part of a Claude connection this feature uses. */
export type ClaudeRemoteControlConnection = {
  remoteControl?: (
    enabled: boolean,
    name?: string,
    options?: { timeoutMs?: number }
  ) => Promise<ClaudeRemoteControlResponse>
  initializationResult: () => Promise<unknown>
}

export type ClaudeRemoteControlNote = { text: string; tone?: 'warning' | 'error' }
type NoteWriter = (sessionId: string, note: ClaudeRemoteControlNote) => Promise<boolean>

type SessionState = {
  connection: ClaudeRemoteControlConnection
  /** The user asked for Remote Control and has not turned it off. */
  wanted: boolean
  name?: string
  url?: string
  /** The connection Remote Control is known to run on. */
  enabledOn?: ClaudeRemoteControlConnection
}

function unsupportedNote(detail: string): string {
  return `Remote Control is unavailable: ${detail}`
}

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

/** Per-chat Remote Control state; in memory, so an Orca restart forgets it. */
export class ClaudeRemoteControlRegistry {
  private readonly sessions = new Map<string, SessionState>()
  private readonly noteWriters = new Set<NoteWriter>()

  /** Called whenever a chat's Claude child is published; re-enables Remote Control the user wanted. */
  observeConnection(sessionId: string, connection: ClaudeRemoteControlConnection): void {
    const previous = this.sessions.get(sessionId)
    if (previous?.connection === connection) {
      return
    }
    const state: SessionState = {
      ...previous,
      wanted: previous?.wanted ?? false,
      connection,
      enabledOn: undefined
    }
    this.sessions.set(sessionId, state)
    if (previous?.wanted) {
      void this.reenable(sessionId, state)
    }
  }

  addNoteWriter(writer: NoteWriter): () => void {
    this.noteWriters.add(writer)
    return () => this.noteWriters.delete(writer)
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  async run(sessionId: string, command: ClaudeRemoteControlCommand): Promise<ClaudeRemoteControlNote> {
    const state = this.sessions.get(sessionId)
    if (command.action === 'status') {
      return state?.wanted && state.enabledOn === state.connection
        ? { text: `Remote Control is on: ${state.url ?? '(no URL reported)'}` }
        : { text: 'Remote Control is off for this chat.' }
    }
    if (!state) {
      return {
        text: unsupportedNote(
          "this chat's Claude process is not running. Send a message to start it, then run /rc again."
        ),
        tone: 'warning'
      }
    }
    if (command.action === 'disable') {
      state.wanted = false
      try {
        await this.request(state.connection, false)
      } catch (error) {
        state.enabledOn = undefined
        return { text: claudeRemoteControlErrorText(error), tone: 'warning' }
      }
      state.enabledOn = undefined
      state.url = undefined
      return { text: 'Remote Control is off for this chat.' }
    }
    try {
      const problem = availabilityProblem(await state.connection.initializationResult())
      if (problem) {
        return { text: unsupportedNote(problem), tone: 'error' }
      }
      const response = await this.request(state.connection, true, command.name)
      state.wanted = true
      state.name = command.name ?? state.name
      state.url = response.session_url ?? response.connect_url
      state.enabledOn = state.connection
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
    return connection.remoteControl(enabled, name, { timeoutMs: CLAUDE_REMOTE_CONTROL_TIMEOUT_MS })
  }

  private async reenable(sessionId: string, state: SessionState): Promise<void> {
    let note: ClaudeRemoteControlNote
    try {
      await state.connection.initializationResult()
      const response = await this.request(state.connection, true, state.name)
      if (this.sessions.get(sessionId) !== state || !state.wanted) {
        return
      }
      state.url = response.session_url ?? response.connect_url
      state.enabledOn = state.connection
      note = { text: `Claude restarted; ${this.onText(state.url)}` }
    } catch (error) {
      if (this.sessions.get(sessionId) !== state) {
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
