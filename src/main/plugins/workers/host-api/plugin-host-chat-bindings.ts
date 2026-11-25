import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { PLUGIN_CHAT_LIST_LIMIT } from '../../../../shared/plugins/workers/plugin-host-api-chat'
import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { isUnresolvedOwnerHostId } from '../../../../shared/execution-host/execution-host'
import {
  bind,
  type BoundPluginHostMethod,
  type PluginHostMethodContext
} from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import { pluginHostEffect as effect, pluginHostRpc as rpc } from './plugin-host-runtime-call'
import {
  agentListAnswer,
  pairedRuntimeHostIds,
  projectPluginChats,
  type PluginChatRow
} from './plugin-chat-projection'
import { desktopPairedRuntimeHosts, type PairedRuntimeHosts } from './plugin-chat-paired-runtime'

/** overhedge: `chat.list` and `chat.send` (`chat:send`). Reads and sends go through the runtime
 *  methods Orca's own chat composer uses: in process for this computer, and for a paired Orca
 *  server through the transport the desktop window uses for that server. See OVERHEDGE.md. */

const LIST_TIMEOUT_MS = 8_000
const RUNTIME_PREFIX = 'runtime:'

const historyAnswer = z.object({
  page: z.object({ fence: z.number().int().positive().optional() }),
  fence: z.number().int().positive().optional()
})
const sendAnswer = z.union([
  z.object({ ok: z.literal(true), value: z.object({}).passthrough() }),
  z.object({ ok: z.literal(false), refusal: z.object({ code: z.string() }).passthrough() })
])

type HostCall = (method: string, params: unknown) => Promise<unknown>

const unreachable = (detail: string): PluginHostCallError =>
  new PluginHostCallError(
    'unavailable',
    'that Orca server cannot be reached now',
    undefined,
    detail
  )

/** Reads and writes on the host a chat lives on. Writes on this computer go through the effect
 *  path (approval re-checked right before the runtime acts, plugin provenance recorded). */
function hostCalls(
  ctx: PluginHostMethodContext,
  hostId: string,
  paired: PairedRuntimeHosts,
  timeoutMs?: number
): { read: HostCall; write: HostCall } {
  if (hostId === 'local') {
    const call = rpc(ctx.services)
    return { read: (method, params) => call(method, params), write: (m, p) => effect(ctx, m, p) }
  }
  // Paired servers are reached through the desktop's transport; headless serve has none.
  if (!ctx.services.desktop) {
    throw new PluginHostCallError('unavailable', 'only the Orca desktop app reaches paired servers')
  }
  const environmentId = hostId.slice(RUNTIME_PREFIX.length)
  const remote =
    (background: boolean): HostCall =>
    (method, params) =>
      paired
        .call(environmentId, method, params, { ...(timeoutMs ? { timeoutMs } : {}), background })
        .catch((error: unknown) => {
          throw unreachable(error instanceof Error ? error.message : String(error))
        })
  return {
    read: remote(true),
    write: (method, params) => {
      ctx.scope.assertActive()
      return remote(false)(method, params)
    }
  }
}

async function hostChats(
  ctx: PluginHostMethodContext,
  hostId: string,
  paired: PairedRuntimeHosts
): Promise<{ chats: PluginChatRow[]; truncated: boolean; pairedHostIds: string[] }> {
  const answer = agentListAnswer.parse(
    await hostCalls(ctx, hostId, paired, LIST_TIMEOUT_MS).read('agent.list', {})
  )
  const label = hostId === 'local' ? null : await paired.label(hostId.slice(RUNTIME_PREFIX.length))
  return {
    chats: projectPluginChats(answer, hostId, label ?? hostId),
    truncated: answer.truncated === true,
    pairedHostIds:
      hostId === 'local'
        ? pairedRuntimeHostIds(answer).filter((id) => !isUnresolvedOwnerHostId(id))
        : []
  }
}

/** This computer, or a paired Orca server this desktop's own listing names: never another
 *  environment a selector could resolve to. */
function knownHost(hostId: string, pairedHostIds: readonly string[]): string {
  if (hostId !== 'local' && !pairedHostIds.includes(hostId)) {
    throw new PluginHostCallError('action_failed', 'no paired Orca server has this host id')
  }
  return hostId
}

export function createPluginChatHandlers(
  paired: PairedRuntimeHosts
): Record<'chat.list' | 'chat.send', BoundPluginHostMethod> {
  return {
    'chat.list': bind(PLUGIN_HOST_API['chat.list'], async (params, ctx) => {
      const local = await hostChats(ctx, 'local', paired)
      const hosts = params?.hostId
        ? [knownHost(params.hostId, local.pairedHostIds)]
        : ['local', ...(ctx.services.desktop ? local.pairedHostIds : [])]
      const unreachableHostIds: string[] = []
      const answers = await Promise.all(
        hosts.map(async (hostId) => {
          if (hostId === 'local') {
            return local
          }
          try {
            return await hostChats(ctx, hostId, paired)
          } catch (error) {
            if (!(error instanceof PluginHostCallError)) {
              throw error
            }
            unreachableHostIds.push(hostId)
            return { chats: [], truncated: false, pairedHostIds: [] }
          }
        })
      )
      const chats = answers
        .flatMap((answer) => answer.chats)
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
      return {
        chats: chats.slice(0, PLUGIN_CHAT_LIST_LIMIT),
        unreachableHostIds: unreachableHostIds.toSorted(),
        truncated: chats.length > PLUGIN_CHAT_LIST_LIMIT || answers.some((a) => a.truncated)
      }
    }),
    'chat.send': bind(PLUGIN_HOST_API['chat.send'], async ({ chatId, hostId, text }, ctx) => {
      // Only a chat open now on that host: never a closed one (a send would reopen it), a
      // terminal agent, or an id that would start a new chat.
      if (hostId !== 'local') {
        knownHost(hostId, (await hostChats(ctx, 'local', paired)).pairedHostIds)
      }
      const { chats } = await hostChats(ctx, hostId, paired)
      if (!chats.some((chat) => chat.chatId === chatId)) {
        throw new PluginHostCallError('action_failed', 'no open chat has this id on that host')
      }
      const calls = hostCalls(ctx, hostId, paired)
      const history = historyAnswer.parse(
        await calls.read('agentSession.history', {
          sessionId: chatId,
          direction: 'tail',
          limit: 1
        })
      )
      const fence = history.page.fence ?? history.fence
      if (fence === undefined) {
        throw new PluginHostCallError('action_failed', 'the chat is not ready for messages')
      }
      const answer = sendAnswer.parse(
        await calls.write(
          'agentSession.send',
          structuredAgentSessionMessageSendMutation({
            sessionId: chatId,
            clientOperationId: `plugin-chat-${randomUUID()}`,
            expectedRuntimeFence: fence,
            delivery: 'queue-if-active',
            body: structuredAgentSessionSendBody(text, [])
          })
        )
      )
      if (!answer.ok) {
        throw new PluginHostCallError(
          'action_failed',
          'the chat did not take the message',
          undefined,
          answer.refusal.code
        )
      }
      return { status: 'queued' in answer.value ? ('queued' as const) : ('sent' as const) }
    })
  }
}

export const PLUGIN_CHAT_HANDLERS = createPluginChatHandlers(desktopPairedRuntimeHosts)
