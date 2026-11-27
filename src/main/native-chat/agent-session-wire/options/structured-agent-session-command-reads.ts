import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import { AT_REST_COMMANDS_READ_BUDGET_MS } from './at-rest-command-catalog'
import { withOrcaAccountCommands } from '../../../claude-accounts/chat-pins/claude-chat-account-slash'
import { claudeChatAccountChoices } from '../../../claude-accounts/chat-pins/claude-chat-account-slash-choices'
import { getClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session/agent-session-wire'

export function createStructuredAgentSessionCommandReads(
  deps: () => Pick<StructuredAgentSessionHostDeps, 'adapter' | 'store'>
) {
  // overhedge: Orca's own chat commands join a Claude chat's catalog, with this host's accounts.
  const withOrca = (sessionId: string, commands: AgentSessionSlashCommand[] | undefined) => {
    const router = getClaudeProfileRouter()
    return withOrcaAccountCommands(
      deps().store.getRecord(sessionId)?.provider,
      commands,
      router !== undefined,
      () => (router ? claudeChatAccountChoices(router, sessionId) : [])
    )
  }

  function read(sessionId: string, commandsOnRequest = false) {
    return withOrca(sessionId, upstreamRead(sessionId, commandsOnRequest))
  }

  function upstreamRead(sessionId: string, commandsOnRequest: boolean) {
    const { adapter, store } = deps()
    const live = adapter.readCommands?.(sessionId)
    if (live !== undefined) {
      return live
    }
    const record = store.getRecord(sessionId)
    return record
      ? commandsOnRequest
        ? adapter.atRestCommands?.snapshot?.(record).commands
        : adapter.atRestCommands?.read(record)
      : undefined
  }

  /** One-shot menu readers do not receive later scan updates. */
  async function settled(sessionId: string, commandsOnRequest = false) {
    const { adapter, store } = deps()
    const live = adapter.readCommands?.(sessionId)
    const record = store.getRecord(sessionId)
    if (live !== undefined || !record) {
      return {
        commands: withOrca(sessionId, live),
        ...(commandsOnRequest ? { commandsPending: false } : {})
      }
    }
    const commands = adapter.atRestCommands?.settled
      ? await adapter.atRestCommands.settled(
          record,
          AT_REST_COMMANDS_READ_BUDGET_MS,
          commandsOnRequest
        )
      : adapter.atRestCommands?.read(record)
    const current = adapter.readCommands?.(sessionId)
    const snapshot = commandsOnRequest ? adapter.atRestCommands?.snapshot?.(record) : undefined
    if (current === undefined && snapshot?.retryableFailure) {
      throw new Error('Command discovery unavailable')
    }
    return {
      commands: withOrca(sessionId, current ?? (snapshot ? snapshot.commands : commands)),
      ...(commandsOnRequest
        ? {
            commandsPending: current === undefined && (snapshot?.commandsPending ?? false)
          }
        : {})
    }
  }

  return { read, settled }
}
