// Overhedge: `/orca-account` and `/orca-migrate` for Claude running in an Orca terminal pane.
// Chat-UI chats get these commands from Orca itself (claude-chat-account-slash.ts); a terminal
// `claude` only knows Claude Code custom commands, so account setup (which runs on every Claude
// launch Orca routes) writes them as `<default home>/commands/orca-*.md`. The default home
// (`~/.claude`, or the user's CLAUDE_CONFIG_DIR) is what System default sessions read, and
// provisioning links its `commands` folder into every Orca-managed account folder, so every
// account on the host sees them. Claude Code completes the name and shows `argument-hint`; the
// command body has Claude run `orca account list` / `orca account migrate --chat terminal:<pane>`.
// A file without Orca's marker is the user's own and is never overwritten.
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import type { ClaudeProfileSurfaceOutcome } from '../claude-profile-report'

export const ORCA_CLAUDE_COMMANDS_DIR = 'commands'
export const ORCA_CLAUDE_COMMAND_MARKER = 'orca-managed-command: overhedge'

const CLI = '"${ORCA_CLI_COMMAND:-orca}"'
const PANE = '"terminal:$ORCA_PANE_KEY"'

// Claude Code matches these as literal command prefixes; anything else asks first.
const ALLOWED_TOOLS = [
  'Bash(orca account list:*)',
  'Bash(orca account migrate:*)',
  `Bash(${CLI} account list:*)`,
  `Bash(${CLI} account migrate:*)`,
  'Bash(printenv ORCA_PANE_KEY)'
].join(', ')

function frontmatter(description: string, argumentHint: string): string {
  return [
    '---',
    `description: ${JSON.stringify(description)}`,
    `argument-hint: ${JSON.stringify(argumentHint)}`,
    `allowed-tools: ${ALLOWED_TOOLS}`,
    'disable-model-invocation: true',
    '---',
    `<!-- ${ORCA_CLAUDE_COMMAND_MARKER}. Orca rewrites this file; put your own commands in other files. -->`
  ].join('\n')
}

const COMMON = [
  'Run the steps below with the Bash tool, one command at a time, exactly as written (keep the',
  'quotes). Do not do anything else, do not retry with other spellings, and do not edit files.',
  '',
  '1. Run `printenv ORCA_PANE_KEY`. If it prints nothing, answer only: "This command works in',
  'Claude running in an Orca terminal pane; in an Orca chat tab type it in the chat instead." and',
  'stop.'
]

const SHOW = [
  `- Run \`${CLI} account list --agent claude\` and then`,
  `  \`${CLI} account migrate --unpin --chat ${PANE} --dry-run\` (a dry run: it changes nothing).`,
  '- Answer with a short list of the Claude accounts (email and id). Say which one this pane is',
  '  pinned to: the dry run shows it as "(from <account>)"; without it the pane is not pinned and',
  '  its Claude runs the account it was started with (normally the global selection).',
  '- End with: "/orca-account <email or id> pins this pane, /orca-account auto unpins it,',
  '  /orca-migrate <account> --with-workers also moves the workers it dispatched."'
]

const AFTER_CHANGE = [
  "- Show Orca's output as it is (a code block). Then say, in one or two sentences, that the pin",
  '  decides the account of the next Claude started in this pane; this running Claude keeps its',
  '  account until it restarts. To switch now: when this reply is done, type /exit and run the',
  '  line Orca printed, or let Orca restart the pane from another terminal with the same',
  '  `account migrate` command plus `--restart` (with the pane id filled in, as Orca printed it).',
  '  If Orca printed an error, show it and stop.'
]

const ORCA_ACCOUNT = [
  frontmatter("Orca: show or pin this terminal pane's Claude account", '[<account>|auto]'),
  '',
  "Orca's `/orca-account` for this terminal pane. Arguments: `$ARGUMENTS`",
  '',
  ...COMMON,
  '',
  '2. Look at the arguments above:',
  '',
  '- None: show the accounts.',
  ...SHOW,
  '- Exactly `auto`: run',
  `  \`${CLI} account migrate --unpin --chat ${PANE}\`.`,
  '- One other word (an account email or id): run',
  `  \`${CLI} account migrate --to "<that word>" --chat ${PANE}\`.`,
  ...AFTER_CHANGE,
  '- Anything else: answer only "Usage: /orca-account [<account>|auto]" and the accounts (as for',
  '  no arguments).',
  ''
].join('\n')

const ORCA_MIGRATE = [
  frontmatter(
    'Orca: move this terminal pane (and its workers) to another Claude account',
    '<account>|auto [--with-workers]'
  ),
  '',
  "Orca's `/orca-migrate` for this terminal pane. Arguments: `$ARGUMENTS`",
  '',
  ...COMMON,
  '',
  '2. Look at the arguments above. The target is the first word: an account email or id, or',
  '   `auto` (remove the pin, follow the global selection). `--with-workers` may follow it.',
  '',
  '- No target: show the accounts.',
  ...SHOW,
  `- Target without \`--with-workers\`: run \`${CLI} account migrate <to> --chat ${PANE}\`, where`,
  '  `<to>` is `--to "<target>"`, or `--unpin` for `auto`.',
  `- Target with \`--with-workers\`: run \`${CLI} account migrate <to> --with-workers ${PANE}\``,
  '  (this pane and every worker it dispatched), with `<to>` as above.',
  ...AFTER_CHANGE,
  '- Anything else: answer only "Usage: /orca-migrate <account>|auto [--with-workers]" and the',
  '  accounts (as for no arguments).',
  ''
].join('\n')

export const ORCA_CLAUDE_COMMAND_FILES: Readonly<Record<string, string>> = {
  'orca-account.md': ORCA_ACCOUNT,
  'orca-migrate.md': ORCA_MIGRATE
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Write Orca's files into one commands folder; `changed` when any file was (re)written. */
async function writeCommands(folder: string): Promise<boolean> {
  let changed = false
  for (const [name, text] of Object.entries(ORCA_CLAUDE_COMMAND_FILES)) {
    const target = join(folder, name)
    const current = await readIfPresent(target)
    if (current === text || (current !== null && !current.includes(ORCA_CLAUDE_COMMAND_MARKER))) {
      continue
    }
    const staged = `${target}.${randomUUID()}.orca-tmp`
    try {
      await writeFile(staged, text, { mode: 0o644 })
      await rename(staged, target)
    } finally {
      await rm(staged, { force: true })
    }
    changed = true
  }
  return changed
}

/**
 * Install the commands into `<defaultHome>/commands` (created when missing), and into the
 * account folder's own `commands` when that is a real folder (provisioning links it otherwise).
 */
export async function installOrcaClaudeCommands(args: {
  defaultHome: string
  profileHome: string
}): Promise<ClaudeProfileSurfaceOutcome> {
  const shared = join(args.defaultHome, ORCA_CLAUDE_COMMANDS_DIR)
  await mkdir(shared, { recursive: true })
  let changed = await writeCommands(shared)
  const own = join(args.profileHome, ORCA_CLAUDE_COMMANDS_DIR)
  if (await isRealDirectory(own)) {
    changed = (await writeCommands(own)) || changed
  }
  return changed ? 'synced' : 'unchanged'
}
