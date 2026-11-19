import { LOCAL_COMMAND_FLAGS, type CommandSpec } from '../args'

// Terminal login lets headless hosts manage accounts without the desktop login UI.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed agent account by signing in on this Orca host',
    usage:
      'orca account add [--agent claude|codex|opencode|devin] [--label <name>] [--integration <id>] [--method <id>] [--answer <key=value>]... [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'label', 'integration', 'method', 'answer'],
    repeatableFlags: ['answer'],
    notes: [
      'Runs the agent login (`claude login` / `codex login`) in this terminal, then registers the account with the local Orca runtime.',
      'Codex uses device authorization so the browser can complete sign-in from a different machine.',
      'OpenCode 2 uses `opencode auth login --standalone` in private XDG directories. Devin uses `devin auth login --force-manual-token-flow`.',
      'Use --integration <id> to skip the OpenCode integration picker; --label names the saved OpenCode or Devin profile.',
      'Use --method <id> and repeated --answer <key=value> to pass OpenCode its login method and form answers, so sign-in can finish without an interactive terminal.',
      'OpenCode and Devin profiles apply to new explicit host agent launches. Direct SSH relay and Windows-hosted WSL selection are not supported; run the command on a headless Orca runtime on that host.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the Orca runtime to be running on this machine.'
    ],
    examples: [
      'orca account add',
      'orca account add --agent codex',
      'orca account add --agent opencode --integration github-copilot --method <id> --answer <key=value>'
    ]
  },
  {
    path: ['account', 'list'],
    summary: 'List managed agent accounts on this Orca host',
    usage: 'orca account list [--agent opencode|devin] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent'],
    notes: [
      'Lists the accounts on this machine. `--environment` / `--pairing-code` are rejected rather than ignored; run it on the host whose accounts you want to see.'
    ],
    examples: ['orca account list']
  },
  {
    path: ['account', 'select'],
    summary: 'Select an OpenCode or Devin profile for new agent launches',
    usage: 'orca account select --agent opencode|devin --account <id|system> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'account']
  },
  {
    // Overhedge: per-chat Claude account pins.
    path: ['account', 'migrate'],
    summary: 'Pin Claude chats to a managed Claude account on this Orca host, or unpin them',
    usage:
      'orca account migrate (--to <id|email> | --unpin) (--chat <orca-session-id|terminal:<pane>>... | --with-workers <coordinator-id>... | --all-on <id|email>) [--now] [--timeout <seconds>] [--pin-only] [--dry-run] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      'to',
      'unpin',
      'chat',
      'with-workers',
      'all-on',
      'dry-run',
      'now',
      'timeout',
      'pin-only'
    ],
    repeatableFlags: ['chat', 'with-workers'],
    notes: [
      'Accounts are named exactly: the account id or its full email, case-insensitive. An unknown or ambiguous name changes nothing and lists the valid names.',
      'Pins each chat-UI Claude chat to the target account. The chat keeps its tab, session id and orchestration identity, and switches at its next message once its current turn has ended. A pin survives /clear.',
      'With --with-workers, the coordinator chat and every chat it dispatched are pinned; workers without a pin of their own otherwise inherit their coordinator\'s pin.',
      '--unpin removes the pins, so those chats follow the global account selection again.',
      'Terminal Claude tabs (chat ids terminal:<pane>) are pinned and restarted in place: Orca waits until the agent is idle (default 180 s for the whole migration, --timeout <seconds>), types /exit, checks that Claude left the foreground, then runs `claude --resume <session>` under the target account in the same shell. --now does not wait and interrupts a running turn. A pane that is not provably running an idle Claude (or whose terminal host cannot report its foreground process) is left untouched and keeps only the pin; the command then prints the line to run by hand. --pin-only skips restarts.',
      '--dry-run lists, per chat, whether it would be restarted in place, only pinned (and why), or skipped.',
      'In a Claude chat, /orca-account shows the chat\'s account, /orca-account <account|auto> pins or unpins it, and /orca-migrate <account|auto> [--with-workers] does the same with its workers.'
    ],
    examples: [
      'orca account migrate --to team@example.com --chat 0f3c... --dry-run',
      'orca account migrate --to me@example.com --with-workers 0f3c...',
      'orca account migrate --to me@example.com --all-on team@example.com',
      'orca account migrate --unpin --chat 0f3c...',
      'orca account migrate --to me@example.com --chat terminal:<tab-id>:<leaf-id> --timeout 300'
    ]
  },
  {
    path: ['account', 'rm'],
    aliases: [['account', 'remove']],
    destructive: true,
    summary: 'Remove a managed OpenCode or Devin profile and its private data',
    usage: 'orca account rm --agent opencode|devin --account <id> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'account'],
    notes: [
      'Deletes credentials and conversation data in the managed profile. Stop its running agents first. System credentials are never removed.'
    ]
  }
]
