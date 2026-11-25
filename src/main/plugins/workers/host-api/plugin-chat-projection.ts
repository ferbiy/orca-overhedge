// Overhedge: plugin chat send (`chat:send`); see OVERHEDGE.md "Plugin chat send".
import { z } from 'zod'
import { AGENT_STATUS_STATES } from '../../../../shared/agent-status/contracts/agent-status-types'
import { structuredAgentSessionIdFromTabId } from '../../../../shared/agent-session/view/structured-agent-session-tab-id'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isPluginPlainLine } from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import {
  PLUGIN_CHAT_LABEL_MAX,
  PLUGIN_CHAT_TITLE_MAX,
  pluginChatIdSchema
} from '../../../../shared/plugins/workers/plugin-host-api-chat'
import type { PluginHostResult } from '../../../../shared/plugins/workers/plugin-host-api'

/** overhedge: `agent.list` rows (the runtime's, as `orca agent list` reads them) as `chat.list`
 *  rows. Only chats: a terminal agent's pane names no chat session, so it is never listed. */

export type PluginChatRow = PluginHostResult<'chat.list'>['chats'][number]

// The parts of an `agent.list` answer this reads; the last reply and anything else are dropped.
export const agentListAnswer = z.object({
  agents: z.array(
    z.object({
      kind: z.string(),
      agent: z.string().nullable().optional(),
      state: z.enum(AGENT_STATUS_STATES),
      workspace: z.string(),
      repo: z.string().optional(),
      hostId: z.string().optional(),
      paneKey: z.string(),
      title: z.string().nullable().optional(),
      updatedAt: z.number().finite()
    })
  ),
  truncated: z.boolean().optional(),
  hostScope: z
    .object({ hostIds: z.array(z.string()), omittedHostIds: z.array(z.string()) })
    .optional()
})
export type AgentListAnswer = z.output<typeof agentListAnswer>

/** The chat session a status row's pane shows; null for a terminal agent or a malformed key. */
export function chatSessionIdOfPane(paneKey: string): string | null {
  const tabId = parsePaneKey(paneKey)?.tabId
  const id = tabId ? structuredAgentSessionIdFromTabId(tabId) : null
  return id !== null && pluginChatIdSchema.safeParse(id).success ? id : null
}

/** One line, plain, at most `max`: names come from people and agents. */
function label(text: string, max: number): string {
  const line = [...text.replace(/\s+/g, ' ').trim()].filter((char) => isPluginPlainLine(char))
  return line.join('').slice(0, max)
}

/**
 * The open chats of one host's answer. `hostId` is the host as the plugin addresses it: a paired
 * server answers about itself as `local`, so its rows are re-addressed, and rows it lists for
 * hosts beyond it (its own SSH hosts) are left out, as no call here can reach them.
 */
export function projectPluginChats(
  answer: AgentListAnswer,
  hostId: string,
  hostLabel: string | null
): PluginChatRow[] {
  const seen = new Set<string>()
  const rows: PluginChatRow[] = []
  for (const row of answer.agents) {
    const chatId = row.kind === 'chat' ? chatSessionIdOfPane(row.paneKey) : null
    if (!chatId || seen.has(chatId) || (row.hostId ?? 'local') !== 'local') {
      continue
    }
    seen.add(chatId)
    rows.push({
      chatId,
      hostId,
      hostLabel: hostLabel === null ? null : label(hostLabel, PLUGIN_CHAT_LABEL_MAX),
      agent: row.agent ? label(row.agent, 128) || null : null,
      title: row.title ? label(row.title, PLUGIN_CHAT_TITLE_MAX) || null : null,
      workspace: label(row.workspace, PLUGIN_CHAT_LABEL_MAX),
      project: row.repo ? label(row.repo, PLUGIN_CHAT_LABEL_MAX) || null : null,
      state: row.state,
      updatedAt: row.updatedAt
    })
  }
  return rows
}

/** Paired Orca servers this desktop's own listing leaves to them (`runtime:` hosts). */
export function pairedRuntimeHostIds(answer: AgentListAnswer): string[] {
  return (answer.hostScope?.omittedHostIds ?? []).filter((id) =>
    /^runtime:[A-Za-z0-9._-]+$/.test(id)
  )
}
