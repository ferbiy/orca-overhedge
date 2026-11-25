// Overhedge: plugin chat send (`chat:send`); see OVERHEDGE.md "Plugin chat send".
import { z } from 'zod'
import { AGENT_STATUS_STATES } from '../../agent-status/contracts/agent-status-types'
import { PLUGIN_HOST_ID_MAX_LENGTH, isPluginPlainLine } from './plugin-host-api-workspace-methods'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** overhedge: send a message into an existing Orca chat (`chat:send`). Fork-only methods, offered
 *  at the current minor so no upstream minor is claimed; plugins guard with `orca.host.has`. */

export const PLUGIN_CHAT_LIST_LIMIT = 200
export const PLUGIN_CHAT_TEXT_MAX = 4000
export const PLUGIN_CHAT_TITLE_MAX = 512
export const PLUGIN_CHAT_LABEL_MAX = 200

/** The chat's Orca session id, as `chat.list` gives it (an agent session id's own pattern). */
export const pluginChatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'invalid chat id')
/** `local` (this computer) or `runtime:<id>` (a paired Orca server), as `chat.list` gives it. */
export const pluginChatHostIdSchema = z
  .string()
  .min(1)
  .max(PLUGIN_HOST_ID_MAX_LENGTH)
  .refine((id) => id === 'local' || /^runtime:[A-Za-z0-9._-]+$/.test(id), 'unknown host id')

/** Plain text a person could type: lines without control, bidi or invisible characters, and no
 *  leading `/`, which a chat would run as a command (`/clear`, `/compact`, Orca's own). */
export function isPluginChatText(text: string): boolean {
  return (
    text.trim().length > 0 &&
    !text.trimStart().startsWith('/') &&
    text.split('\n').every(isPluginPlainLine)
  )
}

const chatListParams = z
  .strictObject({
    /** Only this host's chats; all reachable hosts when absent. */
    hostId: pluginChatHostIdSchema.optional()
  })
  .optional()
const chatListResult = z.object({
  chats: z
    .array(
      z.object({
        chatId: pluginChatIdSchema,
        hostId: pluginChatHostIdSchema,
        /** The paired server's name; null for this computer. */
        hostLabel: z.string().max(PLUGIN_CHAT_LABEL_MAX).nullable(),
        /** Which agent the chat runs (`claude`, `codex`, ...), when Orca knows. */
        agent: z.string().max(128).nullable(),
        /** The chat's name; null when it has none yet. */
        title: z.string().max(PLUGIN_CHAT_TITLE_MAX).nullable(),
        workspace: z.string().max(PLUGIN_CHAT_LABEL_MAX),
        project: z.string().max(PLUGIN_CHAT_LABEL_MAX).nullable(),
        state: z.enum(AGENT_STATUS_STATES),
        /** Its last activity, in ms since the epoch. */
        updatedAt: z.number().finite()
      })
    )
    .max(PLUGIN_CHAT_LIST_LIMIT),
  /** Paired servers Orca could not ask now; their chats are missing. */
  unreachableHostIds: z.array(z.string().max(PLUGIN_HOST_ID_MAX_LENGTH)).max(32),
  truncated: z.boolean()
})

const chatSendParams = z.strictObject({
  chatId: pluginChatIdSchema,
  hostId: pluginChatHostIdSchema,
  /** Sent as the person's message. */
  text: z
    .string()
    .max(PLUGIN_CHAT_TEXT_MAX)
    .refine(isPluginChatText, 'text must be plain text and must not start with /')
})
const chatSendResult = z.object({
  /** `sent`: handed to the agent; `queued`: the chat was busy, so it runs after the current turn. */
  status: z.enum(['sent', 'queued'])
})

export const PLUGIN_CHAT_API = {
  'chat.list': spec({
    summary:
      'Open Orca chats (not terminal agents) on this computer and on paired Orca servers: id, host, agent, chat name, workspace, project, status. Never their messages.',
    since: 10,
    scope: 'any-workspace',
    capability: 'chat:send',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: chatListParams,
    result: chatListResult
  }),
  'chat.send': spec({
    summary:
      "Sends plain text as the person's message into an open chat `chat.list` gives, on its host; a busy chat queues it. Never opens a chat or reaches a terminal agent.",
    since: 10,
    scope: 'any-workspace',
    capability: 'chat:send',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: chatSendParams,
    result: chatSendResult
  })
}
