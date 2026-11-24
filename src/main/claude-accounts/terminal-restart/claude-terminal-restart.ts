// Overhedge: restart a terminal (TUI) Claude chat under its pinned account (opt-in, `--restart` on
// `orca account migrate`). Uses upstream's restart-in-place (restartAgentPaneInPlace, the same
// primitive the host account switch uses): the pane's terminal is stopped and a new one in the same
// tab and leaf resumes the conversation; the pane's pin sets CLAUDE_CONFIG_DIR on that spawn
// (spawn-preflight). Only on a headless host, only once the turn has ended; every refusal before the
// stop leaves the pane untouched and the caller prints the manual command instead.
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'

export type ClaudePaneRestartRefusal =
  | 'not_local'
  | 'viewer_cannot_follow'
  | 'no_resume_command'
  | 'busy'
  | 'stop_failed'
  | 'create_failed'

/** What the restart reads and calls; the runtime adapter lives next to the RPC method. */
export type ClaudeTerminalRestartPort = {
  /** True on a host with no desktop window (orca serve / orcad). A desktop window moves the panes it
   *  holds itself, so a desktop host never respawns them from here. */
  headless(): boolean
  /** The live terminal of a pane (handle and PTY id), or null when the pane is gone. */
  terminalForPane(paneKey: string): { handle: string; ptyId: string } | null
  /** The agent-status hook row state of the pane (`working`, `blocked`, `waiting`, `done`), if any. */
  hookState(paneKey: string): string | null
  /** The hook row's provider session for the pane, when it names `claudeSessionId`. */
  providerSession(paneKey: string, claudeSessionId: string): AgentProviderSessionMetadata | null
  /** Title/foreground based state; `isRunningAgent` false once the agent left the pane. */
  agentStatus(
    handle: string
  ): Promise<{ isRunningAgent: boolean; status: 'working' | 'permission' | 'idle' | null }>
  /** Upstream's runtime.restartAgentPaneInPlace for a Claude pane. */
  restartPane(
    ptyId: string,
    providerSession: AgentProviderSessionMetadata,
    stillCurrent: () => Promise<boolean>
  ): Promise<{ ok: true; ptyId: string } | { ok: false; reason: ClaudePaneRestartRefusal }>
  sleep(ms: number): Promise<void>
  now(): number
  /** Where a result is recorded when the caller has gone away mid-sequence. */
  log?(message: string): void
}

export type ClaudeTerminalRestartOptions = {
  /** Absolute deadline (port clock) for the idle wait; shared by all panes of one migration. */
  idleDeadline: number
  /** Run every check, stop nothing. */
  dryRun?: boolean
  /** Cancellation (CLI Ctrl-C / disconnect); honoured until the restart is handed to the runtime. */
  signal?: AbortSignal
  pollMs?: number
}

export type ClaudeTerminalRestartOutcome =
  | { kind: 'restarted'; detail: string }
  /** Dry run: every check passed; a real run would restart now. */
  | { kind: 'would-restart'; detail: string }
  /** Nothing was stopped. */
  | { kind: 'refused'; reason: string }
  /** The pane's terminal was (or may have been) stopped but no new one runs Claude. Never ok. */
  | { kind: 'stopped-midway'; reason: string }

export const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const QUESTION = 'Claude is waiting for an answer or a permission in this pane'
export const CANCELLED = 'the request was cancelled before the restart'
export const NOT_HEADLESS =
  'automatic restart runs only on a headless Orca server; a desktop window restarts the panes it holds itself'

const REFUSALS: Record<Exclude<ClaudePaneRestartRefusal, 'stop_failed' | 'create_failed'>, string> =
  {
    not_local: 'the pane is not a live local terminal of this host',
    viewer_cannot_follow: 'a client viewing the pane could not follow a new terminal',
    no_resume_command: 'Orca could not build the resume command for this session',
    busy: 'the pane is busy (another restart, or the session runs in another pane, or it changed)'
  }

type IdleState = 'idle' | 'working' | 'question'

/** Idle: the hooks say the turn ended and the title does not show work or a permission prompt. */
async function idleState(
  port: ClaudeTerminalRestartPort,
  paneKey: string,
  handle: string
): Promise<IdleState> {
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

export async function restartClaudeTerminalInPlace(
  port: ClaudeTerminalRestartPort,
  input: { paneKey: string; claudeSessionId: string | null },
  options: ClaudeTerminalRestartOptions
): Promise<ClaudeTerminalRestartOutcome> {
  const pollMs = options.pollMs ?? 500
  const { signal } = options
  const sessionId = input.claudeSessionId
  if (!sessionId) {
    return { kind: 'refused', reason: "Orca does not know this pane's Claude session id" }
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    return { kind: 'refused', reason: "this pane's Claude session id is not a UUID" }
  }
  if (!port.headless()) {
    return { kind: 'refused', reason: NOT_HEADLESS }
  }
  const terminal = port.terminalForPane(input.paneKey)
  if (!terminal) {
    return { kind: 'refused', reason: 'the pane has no live terminal' }
  }
  if (!(await port.agentStatus(terminal.handle)).isRunningAgent) {
    return { kind: 'refused', reason: 'Orca does not see Claude running in this pane' }
  }
  let state = await idleState(port, input.paneKey, terminal.handle)
  if (state === 'question') {
    return { kind: 'refused', reason: QUESTION }
  }
  if (state === 'working') {
    if (options.dryRun) {
      return {
        kind: 'would-restart',
        detail:
          'Claude is busy now; a real run waits for the turn to end (shared --timeout budget), then restarts'
      }
    }
    const seen: { state: IdleState } = { state }
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
  const providerSession = port.providerSession(input.paneKey, sessionId) ?? {
    key: 'session_id' as const,
    id: sessionId
  }
  if (options.dryRun) {
    return {
      kind: 'would-restart',
      detail: 'every check passed; a real run would restart the pane in a new terminal now'
    }
  }
  if (signal?.aborted === true) {
    return { kind: 'refused', reason: CANCELLED }
  }
  // Checked by the runtime as the last step before it stops the terminal.
  const stillCurrent = async (): Promise<boolean> =>
    port.terminalForPane(input.paneKey)?.ptyId === terminal.ptyId &&
    (await idleState(port, input.paneKey, terminal.handle)) === 'idle'
  const result = await port.restartPane(terminal.ptyId, providerSession, stillCurrent)
  if (result.ok) {
    return {
      kind: 'restarted',
      detail: `restarted in a new terminal in the same pane; the pane's pin sets CLAUDE_CONFIG_DIR, and Claude resumes session ${sessionId}`
    }
  }
  if (result.reason === 'stop_failed') {
    return midway(
      port,
      'the stop was sent but its exit is unconfirmed; the terminal may still end with no replacement'
    )
  }
  if (result.reason === 'create_failed') {
    return midway(
      port,
      'the terminal was stopped but no new one started; the pane resumes the conversation on its next view or Start'
    )
  }
  return { kind: 'refused', reason: REFUSALS[result.reason] }
}

function midway(port: ClaudeTerminalRestartPort, reason: string): ClaudeTerminalRestartOutcome {
  port.log?.(`[overhedge] terminal restart stopped midway: ${reason}`)
  return { kind: 'stopped-midway', reason }
}
