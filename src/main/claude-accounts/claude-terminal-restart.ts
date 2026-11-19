// Overhedge: restart a terminal (TUI) Claude chat in place under another account (opt-in, `--restart`).
// In the pane's own shell: wait for the turn to end, take the pane's input exclusively, prove from the
// screen that Claude sits at an empty prompt, type /exit, prove Claude left and a POSIX shell is back,
// type the resume line, and prove Claude runs again under the same session. Every check that fails
// before /exit leaves the pane untouched; the caller then prints the manual command instead.
import { isShellProcess } from '../../shared/agent-status/process/shell-process-detection'
import { claudePromptLineText } from './claude-terminal-screen-proof'
import {
  CANCELLED,
  claudeInForeground,
  claudeReadyForKeys,
  idleState,
  isClaudeForegroundProcess,
  isPosixEnvPrefixShell,
  QUESTION,
  samePty,
  screenTail,
  SESSION_ID_RE,
  until,
  type ClaudeTerminalRestartOptions,
  type ClaudeTerminalRestartOutcome,
  type ClaudeTerminalRestartPort,
  type PaneTerminal
} from './claude-terminal-restart-checks'

export {
  isClaudeForegroundProcess,
  isPosixEnvPrefixShell,
  type ClaudeTerminalRestartOptions,
  type ClaudeTerminalRestartOutcome,
  type ClaudeTerminalRestartPort
} from './claude-terminal-restart-checks'

/** Panes with a restart in progress in this process; a second request for one is refused. */
const panesInRestart = new Set<string>()

export function isClaudeTerminalRestartInProgress(paneKey: string): boolean {
  return panesInRestart.has(paneKey)
}

export async function restartClaudeTerminalInPlace(
  port: ClaudeTerminalRestartPort,
  input: { paneKey: string; claudeSessionId: string | null; resumeLine: string },
  options: ClaudeTerminalRestartOptions
): Promise<ClaudeTerminalRestartOutcome> {
  if (panesInRestart.has(input.paneKey)) {
    return { kind: 'refused', reason: 'another migration is already restarting this pane' }
  }
  panesInRestart.add(input.paneKey)
  try {
    return await restartLocked(port, input, options)
  } finally {
    panesInRestart.delete(input.paneKey)
  }
}

async function restartLocked(
  port: ClaudeTerminalRestartPort,
  input: { paneKey: string; claudeSessionId: string | null; resumeLine: string },
  options: ClaudeTerminalRestartOptions
): Promise<ClaudeTerminalRestartOutcome> {
  const pollMs = options.pollMs ?? 500
  const signal = options.signal
  const sessionId = input.claudeSessionId
  if (!sessionId) {
    return { kind: 'refused', reason: "Orca does not know this pane's Claude session id" }
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    return { kind: 'refused', reason: "this pane's Claude session id is not a UUID" }
  }
  const terminal = port.terminalForPane(input.paneKey)
  if (!terminal) {
    return { kind: 'refused', reason: 'the pane has no live terminal' }
  }
  const pre = await claudeInForeground(port, input.paneKey, terminal)
  if (!pre.ok) {
    return { kind: 'refused', reason: pre.reason }
  }
  const shell = await port.rootShell(terminal.ptyId)
  if (!isPosixEnvPrefixShell(shell)) {
    return {
      kind: 'refused',
      reason: shell
        ? `the pane's shell is ${shell}; only bash, zsh, sh, dash and ksh are restarted automatically`
        : "Orca cannot tell which shell runs in this pane"
    }
  }
  try {
    await port.assertResumeAllowed?.(input.resumeLine)
  } catch (error) {
    return {
      kind: 'refused',
      reason: `the resume is not allowed in a terminal (${error instanceof Error ? error.message : String(error)})`
    }
  }
  let state = await idleState(port, input.paneKey, terminal.handle)
  if (state === 'question') {
    return { kind: 'refused', reason: QUESTION }
  }
  if (state === 'working') {
    if (options.dryRun) {
      return {
        kind: 'would-restart',
        detail: 'Claude is busy now; a real run waits for the turn to end (shared --timeout budget), then repeats every check before typing'
      }
    }
    const seen: { state: 'idle' | 'working' | 'question' } = { state }
    await until(
      port,
      options.idleDeadline,
      pollMs,
      async () => {
        seen.state = await idleState(port, input.paneKey, terminal.handle)
        return seen.state !== 'working'
      },
      signal
    )
    state = seen.state
    if (signal?.aborted === true) {
      return { kind: 'refused', reason: CANCELLED }
    }
    if (state !== 'idle') {
      return {
        kind: 'refused',
        reason: state === 'question' ? QUESTION : 'Claude was still working when the wait timed out'
      }
    }
  }
  const release = port.holdInput(terminal.ptyId)
  if (!release) {
    return { kind: 'refused', reason: "another operation holds this pane's input" }
  }
  try {
    return await typeRestart(port, input, sessionId, terminal, options, pollMs)
  } finally {
    release()
  }
}

/** Runs with the pane's input held. Returns before any keystroke unless every check passes. */
async function typeRestart(
  port: ClaudeTerminalRestartPort,
  input: { paneKey: string; resumeLine: string },
  sessionId: string,
  terminal: PaneTerminal,
  options: ClaudeTerminalRestartOptions,
  pollMs: number
): Promise<ClaudeTerminalRestartOutcome> {
  const signal = options.signal
  const ready = await claudeReadyForKeys(port, input.paneKey, terminal, signal)
  if (!ready.ok) {
    return { kind: 'refused', reason: ready.reason }
  }
  if (options.dryRun) {
    return { kind: 'would-restart', detail: 'every check passed; a real run would type /exit now' }
  }
  // Re-check as close to the write as possible.
  const last = await claudeReadyForKeys(port, input.paneKey, terminal, signal)
  if (!last.ok) {
    return { kind: 'refused', reason: last.reason }
  }
  if (!(await port.write(terminal.ptyId, '/exit'))) {
    return { kind: 'refused', reason: 'the terminal refused input' }
  }
  // From here on cancellation is not honoured until Claude runs again or the run stops and reports.
  await port.sleep(options.enterDelayMs ?? 250)
  const typed = claudePromptLineText((await port.readScreen(terminal.handle))?.lines ?? [])
  if (typed !== '/exit' || !samePty(port, input.paneKey, terminal)) {
    return midway(
      port,
      'typed /exit but the input box did not show exactly /exit, so Enter was NOT pressed; /exit is left in Claude\'s input box: delete it by hand'
    )
  }
  if (!(await port.write(terminal.ptyId, '\r'))) {
    return midway(port, "typed /exit but the terminal refused Enter; /exit is left in Claude's input box")
  }
  const seen: { shell: string | null } = { shell: null }
  const exited = await until(port, port.now() + (options.exitTimeoutMs ?? 20_000), pollMs, async () => {
    if (!samePty(port, input.paneKey, terminal)) {
      return false
    }
    seen.shell = await port.foregroundProcess(terminal.handle)
    return seen.shell !== null && isShellProcess(seen.shell)
  })
  if (!exited || !samePty(port, input.paneKey, terminal)) {
    return midway(
      port,
      `typed /exit but could not prove Claude exited (an exit confirmation may be open; it was not answered), so no second Claude was started.${await screenTail(port, terminal.handle)}`
    )
  }
  if (!isPosixEnvPrefixShell(seen.shell)) {
    return midway(port, `Claude exited but the shell in front is ${seen.shell ?? 'unknown'}, so the resume line was not typed`)
  }
  // Last check right before the write: still the same PTY with a shell in front.
  const front = await port.foregroundProcess(terminal.handle)
  if (!samePty(port, input.paneKey, terminal) || !isPosixEnvPrefixShell(front)) {
    return midway(port, 'Claude exited but the shell was no longer in front, so the resume line was not typed')
  }
  const typedAt = port.now()
  if (!(await port.write(terminal.ptyId, `${input.resumeLine}\r`))) {
    return midway(port, 'Claude exited but the terminal refused the resume line')
  }
  const started = await until(port, port.now() + (options.startTimeoutMs ?? 30_000), pollMs, async () => {
    if (!samePty(port, input.paneKey, terminal)) {
      return false
    }
    return (
      isClaudeForegroundProcess(await port.foregroundProcess(terminal.handle)) &&
      port.sessionIdSince(input.paneKey, typedAt) === sessionId
    )
  })
  if (!started) {
    return midway(
      port,
      `typed the resume line but could not prove Claude runs again under session ${sessionId}.${await screenTail(port, terminal.handle)}`
    )
  }
  return { kind: 'restarted', detail: `restarted in place; Claude runs again under session ${sessionId}` }
}

function midway(port: ClaudeTerminalRestartPort, reason: string): ClaudeTerminalRestartOutcome {
  port.log?.(`[overhedge] terminal restart stopped midway: ${reason}`)
  return { kind: 'stopped-midway', reason }
}
