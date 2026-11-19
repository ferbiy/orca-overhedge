// Overhedge: `orca account migrate`, a thin client of `accounts.migrateClaudeChats`.
import { REPEATED_FLAG_SEPARATOR } from '../args'
import type { HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

function listFlag(ctx: HandlerContext, name: string): string[] | undefined {
  const value = ctx.flags.get(name)
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !value) {
    throw new RuntimeClientError('invalid_argument', `--${name} needs a value.`)
  }
  return value.split(REPEATED_FLAG_SEPARATOR).filter(Boolean)
}

/** Mirrors DEFAULT_TERMINAL_IDLE_WAIT_SECONDS in claude-terminal-migration.ts (main process). */
const DEFAULT_IDLE_WAIT_SECONDS = 180
const MIGRATE_GRACE_SECONDS = 600

function timeoutFlag(ctx: HandlerContext): number | undefined {
  const value = ctx.flags.get('timeout')
  if (value === undefined) {
    return undefined
  }
  const seconds = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isInteger(seconds) || seconds > 3600) {
    throw new RuntimeClientError('invalid_argument', '--timeout takes whole seconds, 0 to 3600.')
  }
  return seconds
}

export async function migrateClaudeChats(ctx: HandlerContext): Promise<void> {
  const to = ctx.flags.get('to')
  const unpin = ctx.flags.get('unpin') === true
  if (unpin ? to !== undefined : typeof to !== 'string' || !to) {
    throw new RuntimeClientError('invalid_argument', 'Pass either --to <account> or --unpin.')
  }
  const chatIds = listFlag(ctx, 'chat')
  const withWorkersOf = listFlag(ctx, 'with-workers')
  const allOn = ctx.flags.get('all-on')
  if (allOn !== undefined && (typeof allOn !== 'string' || !allOn)) {
    throw new RuntimeClientError('invalid_argument', '--all-on needs an account.')
  }
  if (!chatIds && !withWorkersOf && allOn === undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose chats with --chat, --with-workers or --all-on.'
    )
  }
  const timeoutSeconds = timeoutFlag(ctx)
  const restart = ctx.flags.get('restart') === true
  const yes = ctx.flags.get('yes') === true
  // --pin-only is the default now; it stays accepted as a no-op alias.
  if (ctx.flags.get('pin-only') === true && restart) {
    throw new RuntimeClientError('invalid_argument', '--pin-only cannot be combined with --restart.')
  }
  if (!restart && (timeoutSeconds !== undefined || yes)) {
    throw new RuntimeClientError('invalid_argument', '--timeout and --yes apply only with --restart.')
  }
  const result = await ctx.client.call<{ ok: boolean; lines: string[]; moved: string[] }>(
    'accounts.migrateClaudeChats',
    {
      ...(typeof to === 'string' ? { to } : {}),
      ...(unpin ? { unpin: true } : {}),
      ...(chatIds ? { chatIds } : {}),
      ...(withWorkersOf ? { withWorkersOf } : {}),
      ...(typeof allOn === 'string' ? { allOn } : {}),
      ...(ctx.flags.get('dry-run') === true ? { dryRun: true } : {}),
      ...(restart ? { restart: true } : {}),
      ...(yes ? { yes: true } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {})
    },
    // Terminal restarts wait for idle agents (one shared budget) plus exit/start checks per pane.
    // Ctrl-C or a dropped connection cancels the server side at its next safe point.
    { timeoutMs: ((timeoutSeconds ?? DEFAULT_IDLE_WAIT_SECONDS) + MIGRATE_GRACE_SECONDS) * 1000 }
  )
  printResult(result, ctx.json, (value) => value.lines.join('\n'))
  if (!result.result.ok) {
    process.exitCode = 1
  }
}
