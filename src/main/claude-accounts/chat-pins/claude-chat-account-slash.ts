// Overhedge: grammar of the `/orca-account` and `/orca-migrate` chat commands.

export const ORCA_ACCOUNT_USAGE = [
  'Usage:',
  "  /orca-account                show this chat's Claude account",
  '  /orca-account <account>      pin this chat to an account (id or full email)',
  '  /orca-account auto           remove the pin; follow the global selection again',
  '  /orca-migrate <account|auto> [--with-workers]   same, for this chat and every worker it dispatched'
].join('\n')

export type AccountSlashCommand =
  | { kind: 'show' }
  | { kind: 'move'; to: string; withWorkers: boolean }
  | { kind: 'unpin'; withWorkers: boolean }
  | { kind: 'usage' }

const UNPIN_WORD = 'auto'

/** `/orca-account [<account>|auto]` and `/orca-migrate <account>|auto [--with-workers]` as the
 *  whole message. Null for any other message; `usage` for those commands with bad arguments. */
export function parseAccountSlashCommand(text: string): AccountSlashCommand | null {
  const trimmed = text.trim()
  const match = /^\/(orca-account|orca-migrate)(?=$|\s)([\s\S]*)$/u.exec(trimmed)
  if (!match) {
    return null
  }
  const [, verb, rest] = match
  if (/[\r\n]/u.test(rest)) {
    return { kind: 'usage' }
  }
  const words = rest.split(/\s+/u).filter(Boolean)
  const withWorkers = verb === 'orca-migrate' && words.at(-1) === '--with-workers'
  const args = withWorkers ? words.slice(0, -1) : words
  if (args.some((word) => word.startsWith('--'))) {
    return { kind: 'usage' }
  }
  if (args.length === 0) {
    return verb === 'orca-account' ? { kind: 'show' } : { kind: 'usage' }
  }
  if (args.length > 1) {
    return { kind: 'usage' }
  }
  return args[0].toLowerCase() === UNPIN_WORD
    ? { kind: 'unpin', withWorkers }
    : { kind: 'move', to: args[0], withWorkers }
}
