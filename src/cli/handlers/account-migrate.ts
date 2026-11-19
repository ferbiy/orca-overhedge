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
  const result = await ctx.client.call<{ ok: boolean; lines: string[]; moved: string[] }>(
    'accounts.migrateClaudeChats',
    {
      ...(typeof to === 'string' ? { to } : {}),
      ...(unpin ? { unpin: true } : {}),
      ...(chatIds ? { chatIds } : {}),
      ...(withWorkersOf ? { withWorkersOf } : {}),
      ...(typeof allOn === 'string' ? { allOn } : {}),
      ...(ctx.flags.get('dry-run') === true ? { dryRun: true } : {})
    }
  )
  printResult(result, ctx.json, (value) => value.lines.join('\n'))
  if (!result.result.ok) {
    process.exitCode = 1
  }
}
