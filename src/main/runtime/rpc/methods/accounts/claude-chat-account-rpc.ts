// Overhedge: wires the Claude per-chat account commands into the runtime RPC surface.
import { z } from 'zod'
import { lazyZodSchema } from '../../../../../shared/schema/lazy-zod-schema'
import { getClaudeProfileRouter } from '../../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import {
  describeChatAccount,
  NO_MANAGED_ACCOUNTS,
  orchestrationDbOf,
  runClaudeChatMigration,
  type ClaudeChatAccountDeps
} from '../../../../claude-accounts/chat-pins/claude-chat-account-commands'
import {
  ORCA_ACCOUNT_USAGE,
  parseAccountSlashCommand,
  type AccountSlashCommand
} from '../../../../claude-accounts/chat-pins/claude-chat-account-slash'
import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  acceptedOrcaCommandReply,
  orcaCommandReplies,
  orcaNotices
} from '../../../../native-chat/agent-session-wire/orca-commands/structured-agent-session-orca-notice'
import { refuseUnclassified } from '../../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { defineMethod, type RpcContext } from '../../core'
import { runClaudeChatMigrationWithRestarts } from '../../../../claude-accounts/terminal-restart/claude-terminal-migration'
import { agentStatusRows, terminalRestartPort } from './claude-terminal-restart-port'
import { denyRpcMethodForCaller, OWNER_RPC_CALLER_SCOPE } from '../../callers/rpc-caller-scope'

const MIGRATE_METHOD = 'accounts.migrateClaudeChats'

function orchestrationDb(ctx: RpcContext) {
  try {
    return orchestrationDbOf(ctx.runtime.getOrchestrationDb())
  } catch {
    return null
  }
}

/** Claude terminal panes the agent-status hooks currently know about. */
function claudeTerminalChats(ctx: RpcContext) {
  return agentStatusRows(ctx)
    .filter((row) => row.agentType === 'claude' && row.paneKey)
    .map((row) => {
      const id = row.providerSession?.id
      return { paneKey: row.paneKey, claudeSessionId: typeof id === 'string' ? id : null }
    })
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
    orchestrationDb: () => orchestrationDb(ctx),
    chatExists: (id) =>
      host.deps.store.getRecord(id) !== null || host.deps.store.isSessionUnreadable(id)
  }
}

type SendParamsLike = {
  envelope: { sessionId: string; clientOperationId: string }
  body: { blocks: readonly { type: string; text?: string }[] }
}

/** What a pin change from chat needs: the permission `accounts.migrateClaudeChats` needs. The whole
 *  command is refused without it (not narrowed to this chat), the safer of the two choices. */
function moveDenial(ctx: RpcContext): string | null {
  return denyRpcMethodForCaller(
    ctx.callerScope ?? OWNER_RPC_CALLER_SCOPE,
    MIGRATE_METHOD,
    'accounts-admin'
  )
    ? 'This client may not change Claude accounts (it lacks the accounts-admin permission). Nothing changed.'
    : null
}

/** The reply text for a command, applying the pin change when it is one. */
function runAccountCommand(
  command: AccountSlashCommand,
  sessionId: string,
  ctx: RpcContext,
  host: StructuredAgentSessionHost
): string {
  if (command.kind === 'usage') {
    return ORCA_ACCOUNT_USAGE
  }
  const deps = depsFor(ctx, host)
  const accounts = deps?.router.listAccounts() ?? []
  const record = host.deps.store.getRecord(sessionId)
  if (!deps || accounts.length === 0 || !record) {
    return NO_MANAGED_ACCOUNTS
  }
  if (command.kind === 'show') {
    return describeChatAccount(deps, record, accounts)
  }
  const denial = moveDenial(ctx)
  if (denial) {
    return denial
  }
  const scope = command.withWorkers ? { withWorkersOf: [sessionId] } : { chatIds: [sessionId] }
  const result = runClaudeChatMigration(
    deps,
    command.kind === 'unpin' ? { unpin: true, ...scope } : { to: command.to, ...scope }
  )
  return result.lines.join('\n')
}

/** Handles `/orca-account` and `/orca-migrate` typed into a Claude chat before they reach Claude.
 *  Returns null for every other message, which then goes through the normal send. Once a command
 *  is recognised it never falls through to Claude: its row is written first (so a failure there
 *  changes nothing and refuses the send), then the pin change runs and the row is revised. */
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
  const { sessionId, clientOperationId } = params.envelope
  if (!command || host.deps.store.getRecord(sessionId)?.provider !== 'claude') {
    return null
  }
  return orcaCommandReplies.once(sessionId, clientOperationId, async () => {
    const rowId = `overhedge-account:${clientOperationId}`
    const writeNotice = orcaNotices(host)
    const changes = command.kind === 'move' || command.kind === 'unpin'
    const first = changes
      ? "Changing this chat's Claude account\u2026"
      : runAccountCommand(command, sessionId, ctx, host)
    const notice = await writeNotice(sessionId, rowId, first).catch(() => null)
    if (!notice) {
      return {
        ok: false as const,
        refusal: refuseUnclassified(
          'structured_agent_session_unsupported',
          'Orca could not record its answer to this command in this chat, so nothing changed'
        )
      }
    }
    if (!changes) {
      return acceptedOrcaCommandReply(clientOperationId, notice)
    }
    let text: string
    try {
      text = runAccountCommand(command, sessionId, ctx, host)
    } catch (error) {
      text = `Orca could not finish changing this chat's Claude account (${error instanceof Error ? error.message : String(error)}). Run /orca-account to see where it stands.`
    }
    // Never leave the interim "Changing ..." row as the last word: retry once, then a short final row.
    const settled =
      (await writeNotice(sessionId, rowId, text).catch(() => null)) ??
      (await writeNotice(
        sessionId,
        rowId,
        "Orca could not record the result here. Run /orca-account to see this chat's Claude account."
      ).catch(() => null))
    return acceptedOrcaCommandReply(clientOperationId, settled ?? notice)
  })
}

const MigrateParams = lazyZodSchema(() =>
  z
    .object({
      to: z.string().min(1).max(512).optional(),
      unpin: z.boolean().optional(),
      chatIds: z.array(z.string().min(1).max(512)).max(512).optional(),
      withWorkersOf: z.array(z.string().min(1).max(512)).max(64).optional(),
      allOn: z.string().min(1).max(512).optional(),
      dryRun: z.boolean().optional(),
      restart: z.boolean().optional(),
      yes: z.boolean().optional(),
      timeoutSeconds: z.number().int().min(0).max(3600).optional()
    })
    .strict()
)

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
      const { ok, lines, moved } = await runClaudeChatMigrationWithRestarts(
        deps,
        params,
        params.restart === true ? terminalRestartPort(ctx) : null,
        ctx.signal
      )
      return { ok, lines, moved }
    }
  })
]
