import { LOCAL_COMMAND_FLAGS } from '../arguments/args'
import type { CommandSpec } from '../discovery/command-spec'

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
      'Antigravity accounts are saved from the current `agy` login in Orca Settings > AI Provider Accounts.',
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
    usage: 'orca account list [--agent claude|codex|opencode|devin|antigravity] [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent'],
    notes: [
      "Lists the accounts on this machine with the ids `orca account select` and `orca account rm` accept. `system` is the provider's own sign-in outside Orca.",
      '`--environment` / `--pairing-code` are rejected rather than ignored; run it on the host whose accounts you want to see.'
    ],
    examples: ['orca account list', 'orca account list --agent claude']
  },
  {
    path: ['account', 'select'],
    summary: 'Select the account new agent launches use on this Orca host',
    usage:
      'orca account select --agent claude|codex|opencode|devin|antigravity --account <id|email|label|system> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'account'],
    notes: [
      "--account takes an id, email or label from `orca account list`, or `system` for the provider's own sign-in. An email shared by several accounts is refused; pass the id.",
      'The selection applies to agents launched on this host after it, like the status-bar account switcher. Antigravity has no `system` default.'
    ],
    examples: [
      'orca account select --agent claude --account me@work.example',
      'orca account select --agent codex --account system',
      'orca account select --agent antigravity --account me@gmail.example'
    ]
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
      "With --with-workers, the coordinator chat and every chat it dispatched are pinned; workers without a pin of their own otherwise inherit their coordinator's pin.",
      '--unpin removes the pins, so those chats follow the global account selection again.',
      'Terminal Claude tabs (chat ids terminal:<pane>) are pinned, and the command prints for each one the line to run by hand in that terminal after typing /exit (--pin-only is accepted and means the same).',
      "With --restart (opt-in), Orca restarts each terminal tab instead, one at a time (workers first), on a headless Orca server only: it waits for the turn to end, then uses Orca's own restart-in-place (the same one the host account switch uses): the tab's terminal is stopped and a new terminal in the same pane resumes the conversation (`claude --resume <session>`), with the pin setting the target account. A new shell replaces the old one, so shell state in that pane (history, variables, background jobs) is not kept. Anything refused before the stop (a desktop host, a question or permission prompt, a viewer that cannot follow, no resume command) stops nothing and prints the manual line; a failure after the stop is reported as FAILED (exit code 1). A running turn is never interrupted.",
      '--timeout <seconds> (with --restart; default 180) is ONE idle-wait budget shared by all selected terminal panes, not per pane: once it is spent, later busy panes are skipped with the manual line.',
      '--restart with --all-on or --with-workers changes nothing unless --yes is given: without it the command only lists the panes and what it would do. Try --restart first on one disposable pane with --chat terminal:<pane>.',
      "--all-on selects a terminal tab by its pin (or its coordinator's); an unpinned terminal tab is skipped and listed, since Orca cannot tell which account its running Claude uses. Select it with --chat instead.",
      '--dry-run changes nothing and stops nothing; with --restart it runs the checks of the real run (headless host, live terminal, Claude running, idle or busy, question) and says per pane whether it would restart or why not.',
      "In a Claude chat, /orca-account shows the chat's account, /orca-account <account|auto> pins or unpins it, and /orca-migrate <account|auto> [--with-workers] does the same with its workers."
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
    summary: 'Remove a managed agent account and its private data',
    usage:
      'orca account rm --agent claude|codex|opencode|devin|antigravity --account <id|email|label> [--json]',
    allowedFlags: [...LOCAL_COMMAND_FLAGS, 'agent', 'account'],
    notes: [
      'Deletes the credentials Orca saved for that account (and, for OpenCode and Devin, the conversation data in its profile). Stop its running agents first. System credentials are never removed.',
      'The Antigravity account agy is signed in to cannot be removed. Removing the selected account clears the selection, so agy launches with its own login.'
    ]
  }
]
