// Overhedge: the read-only checks of the in-place terminal restart (claude-terminal-restart.ts).
import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { proveClaudeEmptyPrompt } from './claude-terminal-screen-proof'

/** What the restart reads and writes; the runtime adapter lives next to the RPC method. */
export type ClaudeTerminalRestartPort = {
  /** The live terminal of a pane (handle and the shell's PTY id), or null when the pane is gone. */
  terminalForPane(paneKey: string): { handle: string; ptyId: string } | null
  /** The agent-status hook row of the pane (`working`, `blocked`, `waiting`, `done`), if any. */
  hookState(paneKey: string): string | null
  /** The pane's Claude session id from a hook row received at or after `since` (port clock). */
  sessionIdSince(paneKey: string, since: number): string | null
  /** Title/foreground based state; `isRunningAgent` false once the agent left the pane. */
  agentStatus(
    handle: string
  ): Promise<{ isRunningAgent: boolean; status: 'working' | 'permission' | 'idle' | null }>
  /** The pane's foreground process name; null when the PTY host cannot tell (e.g. older daemon). */
  foregroundProcess(handle: string): Promise<string | null>
  /** The rendered visible screen; null when it cannot be read as a screen. */
  readScreen(handle: string): Promise<{ lines: readonly string[]; draft?: string } | null>
  /** Name of the PTY's root shell process; null when unknown. */
  rootShell(ptyId: string): Promise<string | null>
  /** Whether Orca is delivering an agent prompt to this PTY right now; null when unknown. */
  promptDeliveryInFlight(ptyId: string): boolean | null
  /** Takes the PTY's input exclusively; null when another operation holds it. */
  holdInput(ptyId: string): (() => void) | null
  /** Writes bytes to the PTY directly (past the hold); false when refused. */
  write(ptyId: string, data: string): Promise<boolean>
  /** Throws when the resume line is not allowed in a terminal (session owned by a chat-UI chat). */
  assertResumeAllowed?(line: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
  /** Where a result is recorded when the caller has gone away mid-sequence. */
  log?(message: string): void
}

export type ClaudeTerminalRestartOptions = {
  /** Absolute deadline (port clock) for the idle wait; shared by all panes of one migration. */
  idleDeadline: number
  /** Run every check, take and release the locks, type nothing. */
  dryRun?: boolean
  /** Cancellation (CLI Ctrl-C / disconnect); honoured only where stopping leaves Claude running. */
  signal?: AbortSignal
  pollMs?: number
  /** How long Claude may take to exit after /exit, and to show up again after the resume line. */
  exitTimeoutMs?: number
  startTimeoutMs?: number
  /** Pause between typing `/exit` and its Enter, so Claude does not read both as one paste. */
  enterDelayMs?: number
}

export type ClaudeTerminalRestartOutcome =
  | { kind: 'restarted'; detail: string }
  /** Dry run: every check passed; a real run would type now. */
  | { kind: 'would-restart'; detail: string }
  /** Nothing was typed into the pane. */
  | { kind: 'refused'; reason: string }
  /** Something was typed but the restart could not finish (or could not be proven). Never ok. */
  | { kind: 'stopped-midway'; reason: string }

const NATIVE_CLAUDE_VERSION_NAME = /^\d+\.\d+\.\d+$/
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Shells where `VAR= VAR2='x' cmd` sets the variables for that one command. */
const POSIX_ENV_PREFIX_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh'])

/** Claude's process, by name or as the native binary named after its version. */
export function isClaudeForegroundProcess(name: string | null): boolean {
  if (!name) {
    return false
  }
  return (
    recognizeAgentProcess(name)?.agent === 'claude' || NATIVE_CLAUDE_VERSION_NAME.test(name.trim())
  )
}

/** bash, zsh, sh, dash, ksh (also as a login shell `-zsh` or a path). Anything else is refused. */
export function isPosixEnvPrefixShell(name: string | null): boolean {
  if (!name) {
    return false
  }
  const base = (name.trim().split('/').pop() ?? '').replace(/^-/, '').toLowerCase()
  return POSIX_ENV_PREFIX_SHELLS.has(base)
}

export type Check = { ok: true } | { ok: false; reason: string }

export type PaneTerminal = { handle: string; ptyId: string }

export function samePty(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  terminal: PaneTerminal
): boolean {
  return port.terminalForPane(paneKey)?.ptyId === terminal.ptyId
}

export async function claudeInForeground(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  terminal: PaneTerminal
): Promise<Check> {
  if (!samePty(port, paneKey, terminal)) {
    return { ok: false, reason: 'the pane changed its terminal' }
  }
  const foreground = await port.foregroundProcess(terminal.handle)
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
  const status = await port.agentStatus(terminal.handle)
  if (!status.isRunningAgent) {
    return { ok: false, reason: 'Orca does not see a running agent in this pane' }
  }
  return { ok: true }
}

/** Idle: the hooks say the turn ended and the title does not show work or a permission prompt. */
export async function idleState(
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

export async function until(
  port: ClaudeTerminalRestartPort,
  deadline: number,
  pollMs: number,
  test: () => Promise<boolean>,
  signal?: AbortSignal
): Promise<boolean> {
  while (true) {
    if (await test()) {
      return true
    }
    if (port.now() >= deadline || signal?.aborted === true) {
      return false
    }
    await port.sleep(Math.max(1, Math.min(pollMs, deadline - port.now())))
  }
}

export const QUESTION = 'Claude is waiting for an answer or a permission in this pane'
export const CANCELLED = 'the request was cancelled before anything was typed'

/** Everything that must hold right before a keystroke into Claude: same PTY, Claude in front, idle
 *  by hooks and title, no prompt delivery in flight, and the screen shows an empty prompt. */
export async function claudeReadyForKeys(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  terminal: PaneTerminal,
  signal: AbortSignal | undefined
): Promise<Check> {
  if (signal?.aborted === true) {
    return { ok: false, reason: CANCELLED }
  }
  const foreground = await claudeInForeground(port, paneKey, terminal)
  if (!foreground.ok) {
    return foreground
  }
  const state = await idleState(port, paneKey, terminal.handle)
  if (state !== 'idle') {
    return { ok: false, reason: state === 'question' ? QUESTION : 'Claude started working again' }
  }
  const inFlight = port.promptDeliveryInFlight(terminal.ptyId)
  if (inFlight !== false) {
    return {
      ok: false,
      reason:
        inFlight === null
          ? 'Orca cannot tell whether a prompt is being delivered to this pane'
          : 'Orca is delivering a prompt to this pane'
    }
  }
  const proof = proveClaudeEmptyPrompt(await port.readScreen(terminal.handle))
  return proof.ok ? { ok: true } : proof
}

/** Lines at the bottom of the screen, for a report (never answered). */
export async function screenTail(port: ClaudeTerminalRestartPort, handle: string): Promise<string> {
  const screen = await port.readScreen(handle).catch(() => null)
  const lines = (screen?.lines ?? [])
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
  return lines.length > 0 ? ` Screen shows: ${lines.join(' | ').slice(0, 240)}` : ''
}
