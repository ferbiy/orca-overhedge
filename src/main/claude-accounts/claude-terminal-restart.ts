// Overhedge: restart a terminal (TUI) Claude chat in place under another account. In the pane's own
// shell: wait for the agent to be idle, type /exit, prove Claude left the foreground, then type the
// resume line. The shell, terminal handle and orchestration identity stay. Every check that fails
// before /exit leaves the pane untouched; the caller then reports the manual command instead.
import { recognizeAgentProcess } from '../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../shared/agent-status/process/shell-process-detection'

/** What the restart reads and writes; the runtime adapter lives next to the RPC method. */
export type ClaudeTerminalRestartPort = {
  /** The live terminal of a pane (handle and the shell's PTY id), or null when the pane is gone. */
  terminalForPane(paneKey: string): { handle: string; ptyId: string } | null
  /** The agent-status hook row of the pane (`working`, `blocked`, `waiting`, `done`), if any. */
  hookState(paneKey: string): string | null
  /** Title/foreground based state; `isRunningAgent` false once the agent left the pane. */
  agentStatus(
    handle: string
  ): Promise<{ isRunningAgent: boolean; status: 'working' | 'permission' | 'idle' | null }>
  /** The pane's foreground process name; null when the PTY host cannot tell (e.g. older daemon). */
  foregroundProcess(handle: string): Promise<string | null>
  /** Types into the pane; false when the terminal refused the input. */
  send(handle: string, action: { text?: string; enter?: boolean }): Promise<boolean>
  /** Throws when the resume line is not allowed in a terminal (session owned by a chat-UI chat). */
  assertResumeAllowed?(line: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

export type ClaudeTerminalRestartOptions = {
  /** Skip the idle wait; a running turn is interrupted first. Open questions still refuse. */
  now: boolean
  /** Absolute deadline (port clock) for the idle wait. */
  idleDeadline: number
  pollMs?: number
  /** How long Claude may take to exit after /exit, and to show up again after the resume line. */
  exitTimeoutMs?: number
  startTimeoutMs?: number
}

export type ClaudeTerminalRestartOutcome =
  | { kind: 'restarted' | 'started-unconfirmed'; detail: string }
  /** Nothing was typed into the pane. */
  | { kind: 'refused'; reason: string }
  /** /exit (or an interrupt) was typed but the restart could not finish safely. */
  | { kind: 'stopped-midway'; reason: string }

const NATIVE_CLAUDE_VERSION_NAME = /^\d+\.\d+\.\d+$/
const ESCAPE = '\x1b'

/** Claude's process, by name or as the native binary named after its version. */
export function isClaudeForegroundProcess(name: string | null): boolean {
  if (!name) {
    return false
  }
  return (
    recognizeAgentProcess(name)?.agent === 'claude' || NATIVE_CLAUDE_VERSION_NAME.test(name.trim())
  )
}

type Check = { ok: true } | { ok: false; reason: string }

type PaneTerminal = { handle: string; ptyId: string }

/** The pane still runs the same shell (same PTY) it ran when the restart began. */
function samePty(port: ClaudeTerminalRestartPort, paneKey: string, terminal: PaneTerminal): boolean {
  return port.terminalForPane(paneKey)?.ptyId === terminal.ptyId
}

async function claudeInForeground(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  terminal: PaneTerminal
): Promise<Check> {
  const handle = terminal.handle
  if (!samePty(port, paneKey, terminal)) {
    return { ok: false, reason: 'the pane changed its terminal' }
  }
  const foreground = await port.foregroundProcess(handle)
  if (foreground === null) {
    return {
      ok: false,
      reason: "the terminal host cannot report the pane's foreground process (older PTY daemon?)"
    }
  }
  if (!isClaudeForegroundProcess(foreground)) {
    return {
      ok: false,
      reason: isShellProcess(foreground)
        ? 'Claude is not running in this pane (the shell is in the foreground)'
        : `the foreground process is ${foreground}, not Claude`
    }
  }
  const status = await port.agentStatus(handle)
  if (!status.isRunningAgent) {
    return { ok: false, reason: 'Orca does not see a running agent in this pane' }
  }
  return { ok: true }
}

/** Idle: the hooks say the turn ended and the title does not show work or a permission prompt. */
async function idleState(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  handle: string
): Promise<'idle' | 'working' | 'question'> {
  const hook = port.hookState(paneKey)
  const { status } = await port.agentStatus(handle)
  if (hook === 'blocked' || hook === 'waiting' || status === 'permission') {
    return 'question'
  }
  return hook === 'done' && status !== 'working' ? 'idle' : 'working'
}

async function until(
  port: ClaudeTerminalRestartPort,
  deadline: number,
  pollMs: number,
  test: () => Promise<boolean>
): Promise<boolean> {
  while (true) {
    if (await test()) {
      return true
    }
    if (port.now() >= deadline) {
      return false
    }
    await port.sleep(Math.max(1, Math.min(pollMs, deadline - port.now())))
  }
}

/** The state once the turn ended (idle, or a question opened); null when the deadline passed. */
async function waitForTurnEnd(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  handle: string,
  deadline: number,
  pollMs: number
): Promise<'idle' | 'question' | null> {
  let last: 'idle' | 'working' | 'question' = 'working'
  const ended = await until(port, deadline, pollMs, async () => {
    last = await idleState(port, paneKey, handle)
    return last !== 'working'
  })
  return ended && last !== 'working' ? last : null
}

/** Read-only: would an automatic restart start now (ignoring whether the agent is idle)? */
export async function precheckClaudeTerminalRestart(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  claudeSessionId: string | null
): Promise<Check & { terminal?: PaneTerminal }> {
  if (!claudeSessionId) {
    return { ok: false, reason: "Orca does not know this pane's Claude session id" }
  }
  const terminal = port.terminalForPane(paneKey)
  if (!terminal) {
    return { ok: false, reason: 'the pane has no live terminal' }
  }
  const check = await claudeInForeground(port, paneKey, terminal)
  return check.ok ? { ok: true, terminal } : check
}

export async function restartClaudeTerminalInPlace(
  port: ClaudeTerminalRestartPort,
  input: { paneKey: string; claudeSessionId: string | null; resumeLine: string },
  options: ClaudeTerminalRestartOptions
): Promise<ClaudeTerminalRestartOutcome> {
  const pollMs = options.pollMs ?? 500
  const pre = await precheckClaudeTerminalRestart(port, input.paneKey, input.claudeSessionId)
  if (!pre.ok || !pre.terminal) {
    return { kind: 'refused', reason: pre.ok ? 'the pane has no live terminal' : pre.reason }
  }
  const terminal = pre.terminal
  const handle = terminal.handle
  try {
    await port.assertResumeAllowed?.(input.resumeLine)
  } catch (error) {
    return {
      kind: 'refused',
      reason: `the resume is not allowed in a terminal (${error instanceof Error ? error.message : String(error)})`
    }
  }
  let interrupted = false
  let state = await idleState(port, input.paneKey, handle)
  if (state === 'question') {
    return { kind: 'refused', reason: 'Claude is waiting for an answer or a permission in this pane' }
  }
  if (state === 'working' && !options.now) {
    const waited = await waitForTurnEnd(port, input.paneKey, handle, options.idleDeadline, pollMs)
    if (waited === null) {
      return { kind: 'refused', reason: 'Claude was still working when the wait timed out' }
    }
    if (waited === 'question') {
      return { kind: 'refused', reason: 'Claude is waiting for an answer or a permission in this pane' }
    }
    state = waited
  }
  if (state === 'working') {
    // --now: interrupt the turn once (a second Escape would open Claude's rewind menu).
    const check = await claudeInForeground(port, input.paneKey, terminal)
    if (!check.ok) {
      return { kind: 'refused', reason: check.reason }
    }
    if (!(await port.send(handle, { text: ESCAPE }))) {
      return { kind: 'refused', reason: 'the terminal refused input' }
    }
    interrupted = true
    const settled = await until(port, port.now() + 15_000, pollMs, async () => {
      const { status } = await port.agentStatus(handle)
      return status !== 'working' && port.hookState(input.paneKey) !== 'working'
    })
    if (!settled) {
      return { kind: 'stopped-midway', reason: 'Claude was interrupted but did not settle; it was not exited' }
    }
  }
  const check = await claudeInForeground(port, input.paneKey, terminal)
  if (!check.ok) {
    return interrupted
      ? { kind: 'stopped-midway', reason: `Claude was interrupted, then ${check.reason}` }
      : { kind: 'refused', reason: check.reason }
  }
  if (!(await port.send(handle, { text: '/exit', enter: true }))) {
    return interrupted
      ? { kind: 'stopped-midway', reason: 'Claude was interrupted, then the terminal refused /exit' }
      : { kind: 'refused', reason: 'the terminal refused input' }
  }
  const exited = await until(
    port,
    port.now() + (options.exitTimeoutMs ?? 20_000),
    pollMs,
    async () => {
      if (!samePty(port, input.paneKey, terminal)) {
        return false
      }
      const foreground = await port.foregroundProcess(handle)
      return foreground !== null && isShellProcess(foreground)
    }
  )
  if (!exited || !samePty(port, input.paneKey, terminal)) {
    return {
      kind: 'stopped-midway',
      reason: 'typed /exit but could not prove Claude exited, so no second Claude was started'
    }
  }
  if (!(await port.send(handle, { text: input.resumeLine, enter: true }))) {
    return {
      kind: 'stopped-midway',
      reason: 'Claude exited but the terminal refused the resume line'
    }
  }
  const started = await until(
    port,
    port.now() + (options.startTimeoutMs ?? 20_000),
    pollMs,
    async () => isClaudeForegroundProcess(await port.foregroundProcess(handle))
  )
  return started
    ? { kind: 'restarted', detail: 'restarted in place' }
    : { kind: 'started-unconfirmed', detail: 'resume line typed; Claude not yet seen in the foreground' }
}
