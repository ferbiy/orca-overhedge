// Overhedge: each paired Orca server's open chats, for the composer's "Open chats" mentions. See
// OVERHEDGE.md, "Chat mentions of open chats".
import {
  OPEN_CHAT_LIST_METHOD,
  openChatRowsOfAnswer,
  openChatRowsOfLegacyAgentList,
  type OpenChatHostListing
} from './open-chat-contracts'

export type OpenChatPairedServers = {
  servers: () => Promise<readonly { environmentId: string; label: string | null }[]>
  call: (environmentId: string, method: string, params: unknown) => Promise<unknown>
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}

// A plain server name passes as `--on <name>`; anything else is named by its id.
const PLAIN_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Each paired server's open chats, as that server lists its own. A server whose Orca predates
 *  `agent.listOpenChats` is read with `agent.list` (chats only, no names); one that can't be
 *  reached now is marked so, with no rows. */
export async function listPairedOpenChats(
  paired: OpenChatPairedServers
): Promise<OpenChatHostListing[]> {
  let servers: readonly { environmentId: string; label: string | null }[]
  try {
    servers = await paired.servers()
  } catch {
    return []
  }
  const labels = servers.map((server) => server.label)
  return Promise.all(
    servers.map(async ({ environmentId, label }): Promise<OpenChatHostListing> => {
      const unique = label !== null && labels.filter((other) => other === label).length === 1
      const base = {
        hostId: `runtime:${environmentId}`,
        environmentId,
        ...(label ? { label } : {}),
        selector: unique && label !== null && PLAIN_SELECTOR.test(label) ? label : environmentId
      }
      try {
        const answer = await paired.call(environmentId, OPEN_CHAT_LIST_METHOD, {})
        return { ...base, chats: openChatRowsOfAnswer(answer) }
      } catch (error) {
        if (errorCode(error) !== 'method_not_found') {
          return { ...base, chats: [], unreachable: true }
        }
      }
      try {
        const answer = await paired.call(environmentId, 'agent.list', {})
        return { ...base, chats: openChatRowsOfLegacyAgentList(answer), legacy: true }
      } catch {
        return { ...base, chats: [], unreachable: true }
      }
    })
  )
}
