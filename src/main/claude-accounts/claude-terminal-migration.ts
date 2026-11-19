// Overhedge: `orca account migrate`, with opt-in (`--restart`) in-place restarts of terminal Claude
// chats. Pins are written first (as before); without --restart every terminal pane gets the manual
// command. With --restart each terminal pane in the plan is restarted in its own shell, one at a
// time and workers first, or gets the manual command when an automatic restart is not provably safe.
import {
  claudeTerminalResumeLine,
  runClaudeChatMigration,
  terminalMigrationInstruction,
  type ClaudeChatAccountDeps,
  type ClaudeChatMigrationRequest,
  type ClaudeChatMigrationResult
} from './claude-chat-account-commands'
import {
  restartClaudeTerminalInPlace,
  type ClaudeTerminalRestartPort
} from './claude-terminal-restart'

export const DEFAULT_TERMINAL_IDLE_WAIT_SECONDS = 180

export type ClaudeTerminalMigrationRequest = ClaudeChatMigrationRequest & {
  /** Restart terminal chats in place (opt-in). Without it they are pinned and get the manual line. */
  restart?: boolean
  /** Confirms a --restart that selects panes in bulk (--all-on, --with-workers). */
  yes?: boolean
  /** One idle-wait budget shared by all selected terminal panes, in seconds. */
  timeoutSeconds?: number
}

function needsConfirmation(request: ClaudeTerminalMigrationRequest): boolean {
  return (
    request.restart === true &&
    request.yes !== true &&
    (request.allOn !== undefined || (request.withWorkersOf?.length ?? 0) > 0)
  )
}

export async function runClaudeChatMigrationWithRestarts(
  deps: ClaudeChatAccountDeps,
  request: ClaudeTerminalMigrationRequest,
  port: ClaudeTerminalRestartPort | null,
  signal?: AbortSignal
): Promise<ClaudeChatMigrationResult> {
  if (request.restart !== true) {
    return runClaudeChatMigration(deps, request)
  }
  if (!port) {
    const result = runClaudeChatMigration(deps, request)
    if (result.ok && (result.terminalPanes?.length ?? 0) > 0) {
      result.lines.push('  (--restart: automatic restart is not available on this host; nothing was typed)')
      return { ...result, ok: false }
    }
    return result
  }
  const unconfirmed = needsConfirmation(request)
  const dryRun = request.dryRun === true || unconfirmed
  const result = runClaudeChatMigration(deps, { ...request, dryRun }, { terminalLines: false })
  const panes = result.terminalPanes ?? []
  if (!result.ok) {
    return result
  }
  const home = result.home ?? null
  const lines = [...result.lines]
  let restarted = 0
  const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_TERMINAL_IDLE_WAIT_SECONDS
  const idleDeadline = port.now() + timeoutSeconds * 1000
  if (panes.length > 0) {
    lines.push(
      `Terminal panes (${panes.length}): idle wait up to ${timeoutSeconds}s in total, one budget shared by all of them, in this order:`
    )
  }
  for (const pane of panes) {
    const manual = claudeTerminalResumeLine(home, pane.claudeSessionId)
    if (signal?.aborted === true) {
      lines.push(terminalMigrationInstruction(pane, home, 'the request was cancelled before this pane'))
      continue
    }
    const outcome = await restartClaudeTerminalInPlace(
      port,
      { paneKey: pane.paneKey, claudeSessionId: pane.claudeSessionId, resumeLine: manual },
      { idleDeadline, dryRun, signal }
    )
    if (outcome.kind === 'would-restart') {
      lines.push(`  terminal ${pane.paneKey}: would restart in place (${outcome.detail})`)
    } else if (outcome.kind === 'refused') {
      lines.push(
        dryRun
          ? `  terminal ${pane.paneKey}: would NOT restart (${outcome.reason}); pin only, manual: ${manual}`
          : terminalMigrationInstruction(pane, home, outcome.reason)
      )
    } else if (outcome.kind === 'stopped-midway') {
      lines.push(
        `  terminal ${pane.paneKey}: FAILED midway: ${outcome.reason}. The pin is kept; check the pane, and when the shell prompt is back run: ${manual}`
      )
    } else {
      restarted += 1
      lines.push(`  terminal ${pane.paneKey}: ${outcome.detail} (same shell and terminal)`)
    }
  }
  if (unconfirmed) {
    lines.push(
      'Nothing changed: --restart with --all-on or --with-workers needs --yes. The list above is what it would do.'
    )
    return { ...result, ok: false, lines, moved: [] }
  }
  if (dryRun || panes.length === 0) {
    return { ...result, lines }
  }
  lines.push(`Restarted ${restarted} of ${panes.length} terminal pane(s) in place.`)
  if (signal?.aborted === true) {
    // The client is gone; keep the outcome where an operator can find it.
    port.log?.(`[overhedge] account migrate cancelled by the client: ${lines.slice(-panes.length - 1).join(' / ')}`)
  }
  return { ...result, ok: restarted === panes.length, lines }
}
