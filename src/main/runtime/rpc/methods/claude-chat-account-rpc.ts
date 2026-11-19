// Overhedge: wires the Claude per-chat account commands into the runtime RPC surface.
import { z } from 'zod'
import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import {
  describeChatAccount,
  parseAccountSlashCommand,
  runClaudeChatMigration,
  type ClaudeChatAccountDeps,
  type OrchestrationDbLike
} from '../../../claude-accounts/claude-chat-account-commands'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { acceptedOrcaCommandReply } from '../../../native-chat/agent-session-wire/structured-agent-session-orca-notice'
import { defineMethod, type RpcContext } from '../core'

function orchestrationDb(ctx: RpcContext) {
  try {
    return ctx.runtime.getOrchestrationDb() as unknown as OrchestrationDbLike
  } catch {
    return null
  }
}

type HookRow = { paneKey: string; agentType?: string; providerSession?: { id: string } }

/** Claude terminal panes the agent-status hooks currently know about. */
function claudeTerminalChats(ctx: RpcContext) {
  // The runtime keeps this snapshot reader as an instance field; it is absent before hooks start.
  const runtime = ctx.runtime as unknown as { getAgentStatusSnapshotFn?: (() => HookRow[]) | null }
  return (runtime.getAgentStatusSnapshotFn?.() ?? [])
    .filter((row) => row.agentType === 'claude' && row.paneKey)
    .map((row) => ({ paneKey: row.paneKey, claudeSessionId: row.providerSession?.id ?? null }))
}

function depsFor(ctx: RpcContext, host: StructuredAgentSessionHost): ClaudeChatAccountDeps | null {
  const router = getClaudeProfileRouter()
  if (!router) {
    return null
  }
  return {
    router,
    records: () => host.deps.store.listRecords(),
    terminals: () => claudeTerminalChats(ctx),
    orchestrationDb: () => orchestrationDb(ctx)
  }
}

type SendParamsLike = {
  envelope: { sessionId: string; clientOperationId: string }
  body: { blocks: readonly { type: string; text?: string }[] }
}

/** Handles `/account` and `/migrate` typed into a Claude chat before they reach Claude.
 *  Returns null for every other message, which then goes through the normal send. */
export async function interceptClaudeAccountSlashCommand(
  params: SendParamsLike,
  ctx: RpcContext,
  host: StructuredAgentSessionHost
) {
  const blocks = params.body.blocks
  if (blocks.length !== 1 || blocks[0].type !== 'text' || typeof blocks[0].text !== 'string') {
    return null
  }
  const command = parseAccountSlashCommand(blocks[0].text)
  const sessionId = params.envelope.sessionId
  const record = command ? host.deps.store.getRecord(sessionId) : undefined
  if (!command || !record || record.provider !== 'claude') {
    return null
  }
  const deps = depsFor(ctx, host)
  let text: string
  if (!deps) {
    text = 'Claude accounts are not managed on this Orca host. Add one with `orca account add`.'
  } else if (command.kind === 'show') {
    text = describeChatAccount(deps, record, deps.router.listAccounts())
  } else {
    const result = runClaudeChatMigration(deps, {
      to: command.to,
      ...(command.withWorkers ? { withWorkersOf: [sessionId] } : { chatIds: [sessionId] })
    })
    text = result.lines.join('\n')
  }
  const clientMessageId = params.envelope.clientOperationId
  const notice = await host.appendOrcaNotice(
    sessionId,
    `overhedge-account:${clientMessageId}`,
    text
  )
  return notice ? acceptedOrcaCommandReply(clientMessageId, notice) : null
}

const MigrateParams = z
  .object({
    to: z.string().min(1).max(512),
    chatIds: z.array(z.string().min(1).max(512)).max(512).optional(),
    withWorkersOf: z.array(z.string().min(1).max(512)).max(64).optional(),
    allOn: z.string().min(1).max(512).optional(),
    dryRun: z.boolean().optional()
  })
  .strict()

export const CLAUDE_CHAT_ACCOUNT_METHODS = [
  defineMethod({
    name: 'accounts.migrateClaudeChats',
    permission: 'accounts-admin',
    params: MigrateParams,
    handler: async (params, ctx) => {
      const host = getStructuredAgentSessionHost()
      const deps = host ? depsFor(ctx, host) : null
      if (!host || !deps) {
        return {
          ok: false,
          lines: [
            'Claude chat sessions or managed Claude accounts are not available on this host.'
          ],
          moved: []
        }
      }
      return runClaudeChatMigration(deps, params)
    }
  })
]
