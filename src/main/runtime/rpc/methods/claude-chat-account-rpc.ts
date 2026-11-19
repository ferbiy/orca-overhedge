// Overhedge: wires the Claude per-chat account commands into the runtime RPC surface.
import { z } from 'zod'
import { getClaudeProfileRouter } from '../../../claude-accounts/claude-profile-installed-router'
import {
  describeChatAccount,
  NO_MANAGED_ACCOUNTS,
  orchestrationDbOf,
  runClaudeChatMigration,
  type ClaudeChatAccountDeps
} from '../../../claude-accounts/claude-chat-account-commands'
import {
  ORCA_ACCOUNT_USAGE,
  parseAccountSlashCommand,
  type AccountSlashCommand
} from '../../../claude-accounts/claude-chat-account-slash'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  acceptedOrcaCommandReply,
  orcaCommandReplies
} from '../../../native-chat/agent-session-wire/structured-agent-session-orca-notice'
import { refuseUnclassified } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { defineMethod, type RpcContext } from '../core'
import { runClaudeChatMigrationWithRestarts } from '../../../claude-accounts/claude-terminal-migration'
import type { ClaudeTerminalRestartPort } from '../../../claude-accounts/claude-terminal-restart'
import {
  getProviderForPty,
  hasPtyProviderForInspection
} from '../../../ipc/pty/provider/registry'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import { denyRpcMethodForCaller, OWNER_RPC_CALLER_SCOPE } from '../rpc-caller-scope'

const MIGRATE_METHOD = 'accounts.migrateClaudeChats'

function orchestrationDb(ctx: RpcContext) {
  try {
    return orchestrationDbOf(ctx.runtime.getOrchestrationDb())
  } catch {
    return null
  }
}

type HookRow = {
  paneKey: string
  agentType?: string
  state?: string
  providerSession?: { id: string }
}

function hookRows(value: unknown): HookRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is HookRow =>
          row !== null && typeof row === 'object' && 'paneKey' in row && typeof row.paneKey === 'string'
      )
    : []
}

function agentStatusRows(ctx: RpcContext): HookRow[] {
  // The runtime keeps this snapshot reader as an instance field; it is absent before hooks start.
  const runtime: unknown = ctx.runtime
  const read =
    runtime !== null && typeof runtime === 'object' && 'getAgentStatusSnapshotFn' in runtime
      ? runtime.getAgentStatusSnapshotFn
      : null
  return hookRows(typeof read === 'function' ? read.call(runtime) : [])
}

/** Claude terminal panes the agent-status hooks currently know about. */
function claudeTerminalChats(ctx: RpcContext) {
  return agentStatusRows(ctx)
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

/** What a pin change from chat needs: the permission `accounts.migrateClaudeChats` needs. The whole
 *  command is refused without it (not narrowed to this chat), the safer of the two choices. */
function moveDenial(ctx: RpcContext): string | null {
  return denyRpcMethodForCaller(ctx.callerScope ?? OWNER_RPC_CALLER_SCOPE, MIGRATE_METHOD, 'accounts-admin')
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
    const changes = command.kind === 'move' || command.kind === 'unpin'
    const first = changes ? "Changing this chat's Claude account…" : runAccountCommand(command, sessionId, ctx, host)
    const notice = await host.appendOrcaNotice(sessionId, rowId, first).catch(() => null)
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
    const text = runAccountCommand(command, sessionId, ctx, host)
    const settled = await host.appendOrcaNotice(sessionId, rowId, text).catch(() => null)
    return acceptedOrcaCommandReply(clientOperationId, settled ?? notice)
  })
}

/** The runtime side of an in-place terminal restart: only reads and plain input writes, so it
 *  works with any PTY daemon; a daemon that cannot report the foreground process makes the restart
 *  refuse (and print the manual command) instead of typing blind. */
function terminalRestartPort(ctx: RpcContext): ClaudeTerminalRestartPort {
  const runtime = ctx.runtime
  const terminalForPane = (paneKey: string) => {
    try {
      const handle = runtime.getTerminalHandleForPaneKey(paneKey)
      const ptyId = handle ? runtime.resolveLiveLeafForHandle(handle)?.ptyId : null
      return handle && ptyId ? { handle, ptyId } : null
    } catch {
      return null
    }
  }
  return {
    terminalForPane,
    hookState: (paneKey) =>
      agentStatusRows(ctx).find((row) => row.paneKey === paneKey)?.state ?? null,
    agentStatus: async (handle) => {
      try {
        const status = await runtime.getTerminalAgentStatus(handle)
        return { isRunningAgent: status.isRunningAgent, status: status.status }
      } catch {
        return { isRunningAgent: false, status: null }
      }
    },
    foregroundProcess: async (handle) => {
      try {
        const ptyId = runtime.resolveLiveLeafForHandle(handle)?.ptyId
        if (!ptyId || !hasPtyProviderForInspection(ptyId)) {
          return null
        }
        return await getProviderForPty(ptyId).getForegroundProcess(ptyId)
      } catch {
        return null
      }
    },
    send: async (handle, action) => {
      try {
        const sent = await runtime.sendTerminal(
          handle,
          { text: action.text, enter: action.enter === true },
          { inputKind: 'driving' }
        )
        return sent.accepted === true
      } catch {
        return false
      }
    },
    assertResumeAllowed: (line) =>
      assertLegacyAiVaultResumeCommandAllowed(line, () =>
        runtime.ensureStructuredAgentSessionHost()
      ),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

const MigrateParams = z
  .object({
    to: z.string().min(1).max(512).optional(),
    unpin: z.boolean().optional(),
    chatIds: z.array(z.string().min(1).max(512)).max(512).optional(),
    withWorkersOf: z.array(z.string().min(1).max(512)).max(64).optional(),
    allOn: z.string().min(1).max(512).optional(),
    dryRun: z.boolean().optional(),
    now: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(0).max(3600).optional(),
    noRestart: z.boolean().optional()
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
      const { ok, lines, moved } = await runClaudeChatMigrationWithRestarts(
        deps,
        params,
        terminalRestartPort(ctx)
      )
      return { ok, lines, moved }
    }
  })
]
