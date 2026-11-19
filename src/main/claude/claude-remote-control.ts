// overhedge: Claude Code Remote Control for structured (chat) Claude sessions.
// Stream-json Claude does not register /remote-control, but accepts the `remote_control` control
// request; the Agent SDK exposes it as the undeclared Query.enableRemoteControl.

import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentSessionSlashCommand } from '../../shared/agent-session/agent-session-wire'

export type ClaudeRemoteControlCommand =
  | { action: 'enable'; name?: string }
  | { action: 'disable' }
  | { action: 'status' }

// `.` never matches a line break, so the whole command sits on one line.
const COMMAND = /^\/(?:remote-control|rc)(?:[ \t]+(.*))?$/u
const NAMED = /^on[ \t]+(.+)$/iu
const MAX_NAME_LENGTH = 200

/** The command when the whole message, on one line, is `/rc` or `/remote-control` followed by
 *  nothing, `on`, `off`, `stop`, `status` or `on <name>`. Null otherwise: the text goes to Claude. */
export function parseClaudeRemoteControlCommand(text: string): ClaudeRemoteControlCommand | null {
  const match = COMMAND.exec(text.trim())
  if (!match) {
    return null
  }
  const argument = (match[1] ?? '').trim()
  const word = argument.toLowerCase()
  if (word === '' || word === 'on') {
    return { action: 'enable' }
  }
  if (word === 'off' || word === 'stop') {
    return { action: 'disable' }
  }
  if (word === 'status') {
    return { action: 'status' }
  }
  const name = NAMED.exec(argument)?.[1]?.trim()
  return name && name.length <= MAX_NAME_LENGTH ? { action: 'enable', name } : null
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

export const CLAUDE_REMOTE_CONTROL_SLASH_COMMANDS: AgentSessionSlashCommand[] = [
  {
    name: 'remote-control',
    kind: 'command',
    description: 'Orca: turn Claude Code Remote Control on (off, status) for this chat',
    argumentHint: '[on [name]|off|status]'
  },
  {
    name: 'rc',
    kind: 'command',
    description: 'Orca: alias for /remote-control',
    argumentHint: '[on [name]|off|status]'
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
