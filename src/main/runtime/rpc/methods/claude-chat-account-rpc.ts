// Overhedge: wires the Claude per-chat account commands into the runtime RPC surface.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { refuseUnclassified } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
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
import { defineMethod, type RpcContext } from '../core'

function orchestrationDb(ctx: RpcContext) {
  try {
    return ctx.runtime.getOrchestrationDb() as unknown as OrchestrationDbLike
  } catch {
    return null
  }
}

function depsFor(ctx: RpcContext, host: StructuredAgentSessionHost): ClaudeChatAccountDeps | null {
  const router = getClaudeProfileRouter()
  if (!router) {
    return null
  }
  return {
    router,
    records: () => host.deps.store.listRecords(),
    orchestrationDb: () => orchestrationDb(ctx)
  }
}

type SendParamsLike = {
  envelope: { sessionId: string }
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
  await host.appendOrcaNotice(sessionId, `overhedge-account:${randomUUID()}`, text)
  // The command never reaches Claude; the status row above carries its outcome.
  return {
    ok: false as const,
    refusal: refuseUnclassified('agent_session_operation_invalid', text)
  }
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
          lines: ['Claude chat sessions or managed Claude accounts are not available on this host.'],
          moved: []
        }
      }
      return runClaudeChatMigration(deps, params)
    }
  })
]
