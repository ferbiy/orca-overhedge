// Overhedge: grammar of the `/orca-account` and `/orca-migrate` chat commands.
import type { AgentSessionSlashCommand } from '../../../shared/agent-session/agent-session-wire'

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

/** The slash-menu rows released clients show for a Claude chat's reported catalog. */
export const ORCA_ACCOUNT_SLASH_COMMANDS: readonly AgentSessionSlashCommand[] = [
  {
    name: 'orca-account',
    kind: 'command',
    description: "Orca: show or pin this chat's Claude account",
    argumentHint: '[<account>|auto]'
  },
  {
    name: 'orca-migrate',
    kind: 'command',
    description: 'Orca: move this chat (and its workers) to another Claude account',
    argumentHint: '<account>|auto [--with-workers]'
  }
]

// Subscribers compare catalogs by identity, so one reported catalog keeps one extended copy.
const extended = new WeakMap<readonly AgentSessionSlashCommand[], AgentSessionSlashCommand[]>()

/** A Claude chat's known catalog gains the account commands, which Orca answers itself whenever
 *  this host routes Claude accounts. An unknown catalog stays unknown, so clients keep their own. */
export function withOrcaAccountCommands(
  provider: string | undefined,
  commands: AgentSessionSlashCommand[] | undefined,
  routesAccounts: boolean
): AgentSessionSlashCommand[] | undefined {
  if (commands === undefined || provider !== 'claude' || !routesAccounts) {
    return commands
  }
  const known = extended.get(commands)
  if (known) {
    return known
  }
  const names = new Set(commands.map((command) => command.name))
  const added = ORCA_ACCOUNT_SLASH_COMMANDS.filter((command) => !names.has(command.name))
  const result = added.length === 0 ? commands : [...commands, ...added]
  extended.set(commands, result)
  return result
}
