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
      'orca account migrate (--to <id|email> | --unpin) (--chat <orca-session-id|terminal:<pane>>... | --with-workers <coordinator-id>... | --all-on <id|email>) [--restart [--timeout <seconds>] [--yes]] [--dry-run] [--json]',
    allowedFlags: [
      ...LOCAL_COMMAND_FLAGS,
      'to',
      'unpin',
      'chat',
      'with-workers',
      'all-on',
      'dry-run',
      'restart',
      'timeout',
      'yes',
      'pin-only'
    ],
    repeatableFlags: ['chat', 'with-workers'],
    notes: [
      'Accounts are named exactly: the account id or its full email, case-insensitive. An unknown or ambiguous name changes nothing and lists the valid names.',
      'Pins each chat-UI Claude chat to the target account. The chat keeps its tab, session id and orchestration identity, and switches at its next message once its current turn has ended. A pin survives /clear.',
      'With --with-workers, the coordinator chat and every chat it dispatched are pinned; workers without a pin of their own otherwise inherit their coordinator\'s pin.',
      '--unpin removes the pins, so those chats follow the global account selection again.',
      'Terminal Claude tabs (chat ids terminal:<pane>) are pinned, and the command prints for each one the line to run by hand in that terminal after typing /exit (--pin-only is accepted and means the same).',
      'With --restart (opt-in), Orca restarts each terminal tab in place instead, one at a time: it waits for the turn to end, then holds the pane\'s input (your keys, CLI `terminal send` and orchestration deliveries to that pane are refused meanwhile), checks the screen shows Claude\'s empty prompt with no dialog, picker, question or background work, and that the shell is bash, zsh, sh, dash or ksh, types /exit, proves Claude left, runs `claude --resume <session>` under the target account, and proves Claude runs again under the same session. Any failed check before /exit types nothing and prints the manual line; a failure after /exit is reported as FAILED with the manual line (exit code 1). A running turn is never interrupted.',
      '--timeout <seconds> (with --restart; default 180) is ONE idle-wait budget shared by all selected terminal panes, not per pane: once it is spent, later busy panes are skipped with the manual line.',
      '--restart with --all-on or --with-workers changes nothing unless --yes is given: without it the command only lists the panes and what it would do. Try --restart first on one disposable pane with --chat terminal:<pane>.',
      '--all-on selects a terminal tab by its pin (or its coordinator\'s); an unpinned terminal tab is skipped and listed, since Orca cannot tell which account its running Claude uses. Select it with --chat instead.',
      '--dry-run changes nothing and types nothing; with --restart it runs the same checks as the real run (locks, screen, shell, foreground) and says per pane whether it would restart or why not.',
      'In a Claude chat, /orca-account shows the chat\'s account, /orca-account <account|auto> pins or unpins it, and /orca-migrate <account|auto> [--with-workers] does the same with its workers.'
    ],
    examples: [
      'orca account migrate --to team@example.com --chat 0f3c... --dry-run',
      'orca account migrate --to me@example.com --with-workers 0f3c...',
      'orca account migrate --to me@example.com --all-on team@example.com',
      'orca account migrate --unpin --chat 0f3c...',
      'orca account migrate --to me@example.com --chat terminal:<tab-id>:<leaf-id> --restart --dry-run',
      'orca account migrate --to me@example.com --chat terminal:<tab-id>:<leaf-id> --restart --timeout 300'
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
