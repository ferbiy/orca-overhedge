// Overhedge: the runtime side of an in-place terminal restart (`orca account migrate --restart`).
// Reads only, plus raw writes to a local PTY whose input it holds exclusively. Anything it cannot
// read (older daemon, remote host, no rendered screen, unknown shell) reads as "unknown", and the
// restart then refuses and prints the manual command instead of typing blind.
import { readFile } from 'node:fs/promises'
import type { RpcContext } from '../core'
import type { ClaudeTerminalRestartPort } from '../../../claude-accounts/claude-terminal-restart'
import { getProviderForPty, hasPtyProviderForInspection } from '../../../ipc/pty/provider/registry'
import { assertLegacyAiVaultResumeCommandAllowed } from '../../../ai-vault/structured-session-ownership'
import { holdTerminalInputExclusively } from '../../terminal/input/terminal-input-exclusive-hold'

export type HookRow = {
  paneKey: string
  agentType?: string
  state?: string
  receivedAt?: number
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

export function agentStatusRows(ctx: RpcContext): HookRow[] {
  // The runtime keeps this snapshot reader as an instance field; it is absent before hooks start.
  const runtime: unknown = ctx.runtime
  const read =
    runtime !== null && typeof runtime === 'object' && 'getAgentStatusSnapshotFn' in runtime
      ? runtime.getAgentStatusSnapshotFn
      : null
  return hookRows(typeof read === 'function' ? read.call(runtime) : [])
}

/** Agent prompts the runtime is serialising into this PTY (orchestration dispatch, mail, sends). */
function promptDeliveryInFlight(ctx: RpcContext, ptyId: string): boolean | null {
  const runtime: unknown = ctx.runtime
  const tails =
    runtime !== null && typeof runtime === 'object' && 'agentPromptSubmissionTailByPtyId' in runtime
      ? runtime.agentPromptSubmissionTailByPtyId
      : null
  if (!(tails instanceof Map)) {
    return null
  }
  return [...tails.keys()].some((key) => typeof key === 'string' && key.startsWith(`${ptyId}\u0000`))
}

/** The PTY's root process name (its shell) from /proc; null off Linux or when not reported. */
async function rootShell(ptyId: string): Promise<string | null> {
  try {
    if (!hasPtyProviderForInspection(ptyId)) {
      return null
    }
    const processes = await getProviderForPty(ptyId).listProcesses({
      deadlineMs: 3000,
      ptyIds: [ptyId]
    })
    const pid = processes.find((entry) => entry.id === ptyId)?.rootProcessId
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return null
    }
    const name = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim()
    return name || null
  } catch {
    return null
  }
}

export function terminalRestartPort(ctx: RpcContext): ClaudeTerminalRestartPort {
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
  const hookRow = (paneKey: string) => agentStatusRows(ctx).find((row) => row.paneKey === paneKey)
  return {
    terminalForPane,
    hookState: (paneKey) => hookRow(paneKey)?.state ?? null,
    sessionIdSince: (paneKey, since) => {
      const row = hookRow(paneKey)
      return row && typeof row.receivedAt === 'number' && row.receivedAt >= since
        ? (row.providerSession?.id ?? null)
        : null
    },
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
    readScreen: async (handle) => {
      try {
        const read = await runtime.readTerminal(handle, { screen: true, limit: 60 })
        if (read.source !== 'screen') {
          return null
        }
        return read.draft === undefined ? { lines: read.tail } : { lines: read.tail, draft: read.draft }
      } catch {
        return null
      }
    },
    rootShell,
    promptDeliveryInFlight: (ptyId) => promptDeliveryInFlight(ctx, ptyId),
    holdInput: (ptyId) => holdTerminalInputExclusively(ptyId),
    write: async (ptyId, data) => {
      try {
        if (!hasPtyProviderForInspection(ptyId)) {
          return false
        }
        return getProviderForPty(ptyId).write(ptyId, data) !== false
      } catch {
        return false
      }
    },
    assertResumeAllowed: (line) =>
      assertLegacyAiVaultResumeCommandAllowed(line, () => runtime.ensureStructuredAgentSessionHost()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => console.warn(message)
  }
}
