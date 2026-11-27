// Overhedge: grammar of the `/orca-account` and `/orca-migrate` chat commands.
import type { AgentSessionSlashCommand } from '../../../shared/agent-session/agent-session-wire'
import type {
  OrcaSlashArgumentChoice,
  WithOrcaSlashArguments
} from '../../../shared/native-chat/input/composer/overhedge-slash-arguments'

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

const WITH_WORKERS: OrcaSlashArgumentChoice = {
  value: '--with-workers',
  description: 'Also move every worker this chat dispatched'
}

/** The rows with their argument values (the composer completes them); none without accounts. */
function accountRows(
  choices: readonly OrcaSlashArgumentChoice[]
): (AgentSessionSlashCommand & WithOrcaSlashArguments)[] {
  if (choices.length === 0) {
    return [...ORCA_ACCOUNT_SLASH_COMMANDS]
  }
  const [account, migrate] = ORCA_ACCOUNT_SLASH_COMMANDS
  return [
    { ...account, orcaArguments: { positions: [[...choices]] } },
    { ...migrate, orcaArguments: { positions: [[...choices], [WITH_WORKERS]], required: true } }
  ]
}

// Subscribers compare catalogs by identity, so one reported catalog keeps one extended copy per
// set of account choices (pins and accounts change rarely; a few copies per catalog at most).
const extended = new WeakMap<
  readonly AgentSessionSlashCommand[],
  Map<string, AgentSessionSlashCommand[]>
>()
const MAX_COPIES_PER_CATALOG = 8

/** A Claude chat's known catalog gains the account commands, which Orca answers itself whenever
 *  this host routes Claude accounts. An unknown catalog stays unknown, so clients keep their own.
 *  `choices` (read only when the catalog is extended) are the values `/orca-account ` offers. */
export function withOrcaAccountCommands(
  provider: string | undefined,
  commands: AgentSessionSlashCommand[] | undefined,
  routesAccounts: boolean,
  choices: () => readonly OrcaSlashArgumentChoice[] = () => []
): AgentSessionSlashCommand[] | undefined {
  if (commands === undefined || provider !== 'claude' || !routesAccounts) {
    return commands
  }
  const names = new Set(commands.map((command) => command.name))
  if (ORCA_ACCOUNT_SLASH_COMMANDS.every((command) => names.has(command.name))) {
    // Already extended (or the provider has commands of these names): keep it as it is.
    return commands
  }
  const rows = accountRows(choices())
  const key = JSON.stringify(rows)
  let copies = extended.get(commands)
  const known = copies?.get(key)
  if (known) {
    return known
  }
  if (!copies || copies.size >= MAX_COPIES_PER_CATALOG) {
    copies = new Map()
    extended.set(commands, copies)
  }
  const result = [...commands, ...rows.filter((command) => !names.has(command.name))]
  copies.set(key, result)
  return result
}
