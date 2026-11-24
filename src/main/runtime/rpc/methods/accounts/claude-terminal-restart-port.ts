// Overhedge: the runtime side of a terminal Claude restart (`orca account migrate --restart`). Reads
// the pane's hook row and title state, and hands the restart itself to upstream's
// runtime.restartAgentPaneInPlace. Anything it cannot read reads as "unknown", and the restart then
// refuses and prints the manual command instead.
import type { RpcContext } from '../../core'
import type { ClaudeTerminalRestartPort } from '../../../../claude-accounts/terminal-restart/claude-terminal-restart'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { normalizeAgentProviderSession } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'

export type HookRow = {
  paneKey: string
  agentType?: string
  state?: string
  receivedAt?: number
  providerSession?: { id?: unknown }
}

function hookRows(value: unknown): HookRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is HookRow =>
          row !== null &&
          typeof row === 'object' &&
          'paneKey' in row &&
          typeof row.paneKey === 'string'
      )
    : []
}

export function agentStatusRows(ctx: RpcContext): HookRow[] {
  // The runtime keeps this snapshot reader as an instance field; it is absent before hooks start.
  const runtime: unknown = ctx.runtime
  const read =
    runtime !== null && typeof runtime === 'object' && 'getAgentStatusSnapshotFn' in runtime
      ? runtime.getAgentStatusSnapshotFn
      : null
  return hookRows(typeof read === 'function' ? read.call(runtime) : [])
}

export function terminalRestartPort(ctx: RpcContext): ClaudeTerminalRestartPort {
  const runtime = ctx.runtime
  const hookRow = (paneKey: string) => agentStatusRows(ctx).find((row) => row.paneKey === paneKey)
  return {
    headless: () => {
      try {
        return runtime.getStatus().authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID
      } catch {
        return false
      }
    },
    terminalForPane: (paneKey) => {
      try {
        const handle = runtime.getTerminalHandleForPaneKey(paneKey)
        const ptyId = handle ? runtime.resolveLiveLeafForHandle(handle)?.ptyId : null
        return handle && ptyId ? { handle, ptyId } : null
      } catch {
        return null
      }
    },
    hookState: (paneKey) => hookRow(paneKey)?.state ?? null,
    providerSession: (paneKey, claudeSessionId) => {
      const session = normalizeAgentProviderSession(hookRow(paneKey)?.providerSession)
      return session?.id === claudeSessionId ? session : null
    },
    agentStatus: async (handle) => {
      try {
        const status = await runtime.getTerminalAgentStatus(handle)
        return { isRunningAgent: status.isRunningAgent, status: status.status }
      } catch {
        return { isRunningAgent: false, status: null }
      }
    },
    restartPane: (ptyId, providerSession, stillCurrent) =>
      runtime.restartAgentPaneInPlace(ptyId, { agent: 'claude', providerSession }, stillCurrent),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => console.warn(message)
  }
}
