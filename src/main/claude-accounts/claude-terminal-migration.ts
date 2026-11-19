// Overhedge: `orca account migrate` with in-place restarts of terminal Claude chats. Pins are written
// first (as before); each terminal pane in the plan is then restarted in its own shell, one at a
// time and workers first, or gets the manual command when an automatic restart is not safe.
import {
  claudeTerminalResumeLine,
  runClaudeChatMigration,
  terminalMigrationInstruction,
  type ClaudeChatAccountDeps,
  type ClaudeChatMigrationRequest,
  type ClaudeChatMigrationResult
} from './claude-chat-account-commands'
import {
  precheckClaudeTerminalRestart,
  restartClaudeTerminalInPlace,
  type ClaudeTerminalRestartPort
} from './claude-terminal-restart'

export const DEFAULT_TERMINAL_IDLE_WAIT_SECONDS = 180

export type ClaudeTerminalMigrationRequest = ClaudeChatMigrationRequest & {
  /** Do not wait for the agent's turn to end; interrupt it. */
  now?: boolean
  /** Total idle wait across all terminal chats of this migration, in seconds. */
  timeoutSeconds?: number
  /** Only pin; print the manual command for terminal chats (the pre-restart behaviour). */
  noRestart?: boolean
}

export async function runClaudeChatMigrationWithRestarts(
  deps: ClaudeChatAccountDeps,
  request: ClaudeTerminalMigrationRequest,
  port: ClaudeTerminalRestartPort | null
): Promise<ClaudeChatMigrationResult> {
  if (!port || request.noRestart === true) {
    const result = runClaudeChatMigration(deps, request)
    if (!port && result.ok && (result.terminalPanes?.length ?? 0) > 0) {
      result.lines.push('  (terminal chats: automatic restart is not available on this host)')
    }
    return result
  }
  const result = runClaudeChatMigration(deps, request, { terminalLines: false })
  const panes = result.terminalPanes ?? []
  if (!result.ok || panes.length === 0) {
    return result
  }
  const home = result.home ?? null
  const lines = [...result.lines]
  let ok = true
  const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_TERMINAL_IDLE_WAIT_SECONDS
  const idleDeadline = port.now() + timeoutSeconds * 1000
  for (const pane of panes) {
    if (request.dryRun) {
      const check = await precheckClaudeTerminalRestart(port, pane.paneKey, pane.claudeSessionId)
      lines.push(
        check.ok
          ? `  terminal ${pane.paneKey}: would restart in place ${request.now ? 'now (interrupting a running turn)' : `once idle (waits up to ${timeoutSeconds}s)`}`
          : `  terminal ${pane.paneKey}: pin only, not restarted (${check.reason}); manual: ${claudeTerminalResumeLine(home, pane.claudeSessionId)}`
      )
      continue
    }
    const outcome = await restartClaudeTerminalInPlace(
      port,
      {
        paneKey: pane.paneKey,
        claudeSessionId: pane.claudeSessionId,
        resumeLine: claudeTerminalResumeLine(home, pane.claudeSessionId)
      },
      { now: request.now === true, idleDeadline }
    )
    if (outcome.kind === 'refused') {
      lines.push(terminalMigrationInstruction(pane, home, outcome.reason))
    } else if (outcome.kind === 'stopped-midway') {
      ok = false
      lines.push(
        `  terminal ${pane.paneKey}: stopped midway: ${outcome.reason}. The pin is kept; when the shell prompt is back, run: ${claudeTerminalResumeLine(home, pane.claudeSessionId)}`
      )
    } else {
      lines.push(`  terminal ${pane.paneKey}: ${outcome.detail} (same shell and terminal)`)
    }
  }
  return { ...result, ok, lines }
}
