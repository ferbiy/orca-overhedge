# Overhedge fork: server and macOS builds, rollout

The server (`orca-ide`, Ubuntu 24.04, headless `orca serve` from the `orca-ide` .deb) runs patched
code; from 1.4.273 on the fork also builds an ad-hoc-signed macOS app from the same branch (see
"macOS app" below). Base: `overhedge/base-273` = upstream tag `v1.4.273`; the patch is
`overhedge/patch-273`. Earlier ports: `overhedge/base-266`/`overhedge/patch-266` (1.4.266) and
`overhedge/base`/`overhedge/patch` (1.4.251).

Port 266 -> 273 (2026-11-24): the squashed `base-266..patch-266` diff was re-applied onto v1.4.273
with a 3-way apply (no merge of the 266 release branch). Hand-resolved conflicts: worker-start
params/spec/handler/method (upstream added `--for` and chat lineage), the structured-session
account home (upstream dropped the bot flag), replay-turn resolution (upstream's answered-turn
identity), and process listing (upstream builds the chat host's deps in a factory). Upstream
dropped the Claude session test support in #46786; the two files are restored from 266 for our
Remote Control test. Then the `overhedge/peers` code commits were cherry-picked (`-x`).

## What the patch adds

- `/rc` and `/remote-control [on [name]|<name>|off|status]` in native Claude chats: Orca toggles
  Claude Code Remote Control on the chat's live Claude child (Agent SDK `enableRemoteControl`) and
  answers with a status row; nothing reaches Claude (a malformed form gets a usage row). While it is
  on, prompts typed in claude.ai or the Claude app show in the Orca chat as user rows, and their
  replies as normal turns (`claude-remote-control-user-turn.ts`).
- The slash menu of a Claude chat lists `/rc`, `/remote-control` (live child only),
  `/orca-account` and `/orca-migrate`, appended to the catalog the server already reports.
- Per-chat Claude account pins: `/orca-account [<account>|auto]` and
  `/orca-migrate <account>|auto [--with-workers]` in a Claude chat; `orca account migrate` on the
  CLI (with opt-in `--restart` for terminal Claude tabs: on a headless server, once the turn has
  ended, upstream's restart-in-place stops the tab's terminal and resumes the conversation in a new
  terminal in the same pane, which the pin routes to the account). Workers inherit their
  coordinator's pin.
- `--account <id|email>` on `orca agent launch`, `orca worktree create --agent claude` and
  `orca orchestration worker-start`: the new Claude chat or terminal is pinned before it starts.
  This differs from upstream's `orca account select --agent claude --account ...` (new in 1.4.266),
  which changes the host-wide selection for every later launch.
- The macOS build never updates itself to an official release: `releaseUpdatesEnabled()`
  (`src/main/updater/overhedge-release-updates.ts`) is false for a darwin build whose version
  carries `+overhedge.`, and the updater's checks, downloads, nudges and pinned/local-build picks
  go through it (`UpdaterScheduling.releaseUpdatesAllowed()`). Linux keeps upstream's behavior.
- Plugin chat send: `chat.list` / `chat.send` behind a new `chat:send` capability. See "Plugin
  chat send" below.
- Cross-account Claude peers: every Claude chat or terminal on the host lists and messages every
  other one (ListAgents / SendMessage), whatever managed account or System default it runs under.
  See "Cross-account Claude peers" below.
- Plugin task sources: a plugin's `taskSource.<id>.*` worker commands become its own tab on the
  Tasks page (used by our ClickUp plugin). See "Plugin task sources" below.
- Plugin status colours: a task source's status and options, and a components panel Badge, can
  carry a `#rgb`/`#rrggbb` colour that Orca draws like Linear's state pill. See "Plugin status
  colours" below.

## Overlap with upstream (checked against v1.4.273)

- Remote Control in native Claude chats (`/rc`, `/remote-control`, phone prompts shown in the
  chat): not in upstream. Upstream has no `enableRemoteControl` call; its `remoteControl` strings are
  Codex app-server status and runtime-environment diagnostics. Still needed.
- Slash-menu entries for our commands: still needed (upstream lists the provider's catalog only).
- Per-chat account pins and `--account` on launches: not in upstream. Upstream's account model is
  host-wide: `orca account select`, the status-bar switcher and Settings -> Claude ("add accounts
  only if you want quick switching without moving chat sessions"; all present since 1.4.266).
  1.4.273 adds usage/sign-in fixes (#47834, #46099, #46002, #42644) and auto-continue of
  usage-limited chats after an account switch or relaunch (#47079, #47221), not per-chat accounts.
  Still needed.
- Terminal restart on an account change: upstream restarts running terminal Claude tabs when the
  host-wide account switches (Settings "When you switch accounts while Claude is running in
  terminals": Ask / Always restart / Never restart; `claude-running-pane-account-move.ts`,
  `restart-agent-pane-in-place.ts`; #44057, #44431, #44931 in 1.4.266, #45674 and #44661 in 1.4.273).
  That covers the restart mechanism but not a per-chat move. So `orca account migrate --restart`
  now uses upstream's `restartAgentPaneInPlace` (stop the terminal, resume the conversation in a
  new terminal in the same pane, which our pane pin routes to the account) instead of our own
  `/exit`-typing sequence; the screen proof, exclusive input hold and our edit to
  `terminal-input-admission.ts` are gone. Partly covered -> adapted.
- Cross-session/peer messaging: upstream 1.4.273 adds paired-host peer questions
  (`peer_questions_out`, orchestration schema 50); it does not share Claude's `sessions` folder
  across accounts. Our peers change stays.
- Plugin task sources on the Tasks page: not in upstream. Upstream keeps `contributes.taskSources`
  reserved and empty; community PR #26282 (open) would add it. On every port check
  `git grep -n taskSources v<new> -- src` and whether #26282 or a similar change landed: if
  upstream ships plugin task sources, the founder decides whether our plugin moves to upstream's
  contract (our item/filter/detail shapes follow #26282, so that should be a small change).

## Plugin task sources

Merged into `overhedge/patch-273` from `overhedge/task-sources` (2026-11-25); a port carries it
like the rest of the patch.

A plugin can add its own tab to the Tasks page next to GitHub, GitLab, Linear and Jira (made for
our ClickUp plugin). Upstream keeps `contributes.taskSources` reserved and empty (community PR
#26282 is open, unreviewed); this is a small stand-in until upstream ships one.

Contract for a plugin (`execution: "trusted-worker"`, a `main` worker):

- Declare worker commands in `contributes.commands`: `taskSource.<id>.list` (required; its
  `title` is the tab's title), `taskSource.<id>.get` and `taskSource.<id>.action` (optional).
  `<id>` is letters/digits with `-`/`_`. The manifest stays valid on stock Orca, where these are
  just palette commands; on the fork they leave the palette and become the tab. The tab's icon is
  the plugin's first panel icon.
- Register them with `orca.commands.register(id, (args) => result)`:
  - `list({ query, filters, cursor? })` -> `{ items, nextCursor?, filters?, notice? }`
  - `get({ itemId })` -> `{ item, bodyMarkdown?, actions? }`
  - `action({ itemId, actionId, value? })` -> `{ message?, detail? }`
- `item`: `{ id, title, status?: { label, tone: open|active|blocked|review|done|closed, color? },
  priority?, owner?, labels?, updatedAt?, summary?, url? }` (http(s) only). Items, filters and
  details are the shapes of PR #26282; unknown fields are dropped, so a #26282 `start` recipe does
  no harm. `filters`: `[{ id (kebab), label, options: [{ value, label }], defaultValue? }]`; the
  selected values come back in `list` params.
- `actions`: `[{ id (kebab), label, options?, value?, primary? }]`. Without `options` it is a
  button; with them a menu (e.g. `set-status` with the list's statuses and the current `value`;
  `start` with projects from `project.list`, whose handler calls `workspace.create({ projectId,
  hostId, name, agent, prompt, open: true })`). Return `detail` to repaint at once.
- The renderer validates every answer (`src/shared/plugins/tasks/plugin-task-source-schema.ts`)
  and shows the plugin's error text. A demo source for tests:
  `src/shared/plugins/tasks/demo-plugin-task-source.fake.ts`.

The worker runs in the desktop's main process, like every plugin worker, so with a paired Orca
server the tracker is called from the desktop; `workspace.create` with a `runtime:` host creates
the workspace on the server. Upstream files touched: `TaskPage.tsx` (wrapped, 3 lines),
`SourceBar.tsx` (2), `plugin-list-projection.ts` (3), `plugin-list-entry.ts` (3), `en.json`
(one block at the top). Everything else is in `components/task-page/plugin-sources/` and
`src/shared/plugins/tasks/`.

## Plugin status colours (branch `overhedge/status-colors`)

Made for our ClickUp plugin (0.4.2), whose statuses have their own colours. A plugin colour is
untrusted, so it is accepted only as `#rgb` or `#rrggbb` (`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`:
no names, alpha, `var()`, functions, spaces or `;`) and only ever reaches a React `style` object,
through Linear's own pill helpers (`getLinearStatePillStyle`, `getLinearStateMarkerStyle`: tinted
background and border, text and dot mixed toward `--foreground`, so it reads in light and dark).
The renderer checks it again right before use (`plugin-status-color-style.ts`).

- Tasks page: optional `color` on an item's `status` and on action and filter `options`. An invalid
  value is dropped (`.catch(undefined)`); the rest of the answer still shows. With a colour the
  status pill drops its tone classes and gets the tinted pill plus a dot; status menu items, the
  menu button's current value and filter options get a dot. Without one, the tone pill as before.
  The page sends `features: ['status-color']` in every command's params (list, get, action), so a
  plugin can send plain labels plus `color` and keep its own fallback for older builds.
- Components panels: `Badge` takes an optional `color` beside `tone`. A valid one draws an outline
  badge in that colour with a dot; an invalid one is dropped with the usual "ignored invalid color"
  warning, and the tone badge shows. A plugin feature-detects it with `ui.has('Badge', 'color')`
  (the props table in `plugin-declarative-message-names.ts` that `ui.has` reads). The catalog
  version (`ui.catalog`, 4) is not bumped: upstream owns that number and may give 5 a different
  meaning. Stock Orca drops the prop with a warning, so plugins should check `ui.has` first.
- Component fixtures for both: `components/plugins/status-color/PluginStatusColor.fixture.tsx`
  (`pnpm fixtures:shot 'PluginStatusColor*' --theme both`).

Upstream files touched: `plugin-declarative-catalog.ts` (Badge schema, 3 lines),
`plugin-declarative-message-names.ts` (Badge props, 2), `PluginDeclarativeView.tsx` (Badge case
and import, 6), `orca-components.d.ts` (`BadgeProps`, 5), plus the regenerated
`orca-runtime.mjs`, `orca-testing.mjs`, `skill-guides/.../components.md` and
`bundled-skill-guides.ts` (rerun `pnpm generate:plugin-declarative-runtime` and
`pnpm generate:plugin-authoring-skill-references` after a port). Everything else is in new files
(`src/shared/plugins/tasks/plugin-status-color.ts`, `src/renderer/src/components/plugins/status-color/`)
or in our task-source files.

## Plugin chat send (branch `overhedge/chat-send`)

A plugin with the `chat:send` capability can list the open Orca chats (native chats, not terminal
agents) on this computer and on paired Orca servers, and send a message into one, as the person
would type it. Made for our ClickUp plugin's "Send to chat" (a short prepared text with the task
link, into a chat the person picks). Upstream has no plugin method that sends into an existing
chat: `agent.launch`/`workspace.create` start a new agent, `agent.resume` takes no prompt, and
`terminal.sendText` types into terminals (which native chats are not).

- `chat.list({ hostId? })` -> `{ chats: [{ chatId, hostId, hostLabel, agent, title, workspace,
  project, state, updatedAt }], unreachableHostIds, truncated }`. Rows come from the runtime's
  `agent.list` (what `orca agent list` reads), only `kind: chat`, with the chat session id taken from
  the pane key; the last reply is dropped. Paired servers are the runtime environments the desktop
  has saved (`listEnvironments`), minus ones the person disconnected in Orca; each is asked with
  `agent.list` and its rows (which it answers as `local`) are re-addressed to `runtime:<environmentId>`.
- `chat.send({ chatId, hostId, text })` -> `{ status: sent|queued }`. The chat must be in that
  host's listing now (never a closed chat, which a send would reopen, a terminal agent, or a new
  chat), and a remote host must be one the desktop has saved. It reads the chat's fence with
  `agentSession.history` and sends `agentSession.send` with `delivery: 'queue-if-active'` and a
  text-only user body, the same calls the chat composer makes (operation id in the host's
  `<ms>-<hex>` form). Text: at most 4000 characters, lines of plain text (no control, bidi or invisible characters), and not starting with `/` (a chat runs
  that as a command, ours included).
- Local calls run in process (`pluginRuntimeRpc`, the CLI's identity; the send through
  `pluginHostEffect`, so approval is re-checked right before it and the plugin is recorded as
  the caller). Paired-server calls use `callRuntimeEnvironment`, the transport the desktop window
  uses for that server's chats (`runtimeEnvironments:call`), and are refused for a server the person
  disconnected in Orca. Desktop only: headless serve has no paired transport.
- No confirmation dialog: the plugin's own preview is the confirmation. `services.confirm` is there
  if one is wanted later. Every send is in the plugin audit log (host, chat id, length).
- Fork-only methods at the current host API minor (10), so no upstream minor is claimed; the
  capability's `since` is 1.4.273. A plugin guards with `orca.host.has('chat.send')`. A manifest
  that asks for `chat:send` does not install on stock Orca (closed capability list).

Upstream files touched: `plugin-capabilities.ts` (kind, since, description: 4 lines),
`plugin-capability-reach.ts` (1), `plugin-host-api-worker-actions.ts` (2),
`plugin-host-method-bindings.ts` (2), `plugin-host-methods.ts` (audit summary, 2), plus the
regenerated plugin reference docs and typings. Everything else is in new files:
`src/shared/plugins/workers/plugin-host-api-chat.ts`,
`src/shared/plugins/capabilities/plugin-chat-send-capability.ts` and
`src/main/plugins/workers/host-api/plugin-{host-chat-bindings,chat-projection,chat-paired-runtime}.ts`.

## Cross-account Claude peers

Claude Code finds its peers in `<CLAUDE_CONFIG_DIR>/sessions/`: one `<pid>.json` per running
session (pid, session id, cwd, name, status, version, inbox socket path) and one
`<pid>.<sha256 of socket path>.key` (a per-session random peer token, mode 600). The inbox sockets
are already shared (`/tmp/cc-socks/<pid>.sock`). Upstream gives each managed account folder
(`~/.config/orca/claude-profiles/<id>/home`) a private `sessions` and, on every launch, removes a
link an earlier build made, so a chat sees only peers under the same account.

- What it touches: `src/main/claude-accounts/profiles/setup/claude-profile-shared-sessions.ts`
  (new) and one call in `claude-profile-history.ts` (`shareClaudeProfileHistory`), which replaces
  upstream's `unlinkSharedSessions`. Test: `claude-profile-shared-sessions.test.ts`; upstream's
  "keeps Claude's live sessions per folder" case is removed from `claude-profile-history.test.ts`.
- Effect: on every Claude launch (chat, terminal, worker, pinned chat, account switch or migrate),
  account setup links `<profile>/sessions` to `~/.claude/sessions` (or the user's own
  CLAUDE_CONFIG_DIR's), the folder System default sessions use, moving the records of running
  sessions there by hard link. Running Claude processes resolve the folder by path, so they follow
  the link without a restart.
- Shared: only that one folder, i.e. the session records and peer keys above. The login
  (`.credentials.json`), `.claude.json`, `daemon*`, `jobs`, `state`, settings and everything else
  stay per folder, as upstream has them.
- Re-apply after an Orca update: cherry-pick the `overhedge/peers` commits. If upstream changed
  `shareClaudeProfileHistory`, keep its other steps and put the `shareClaudeProfileSessions` call
  where the `sessions` step is. Unchanged in v1.4.273. Drop this change if upstream starts
  sharing `sessions` itself.
- `~/relink-sessions.sh` on the server (a manual workaround that relinks one account's `sessions`) is no longer
  needed with this build; its `sessions.plain-*` / `sessions.bak-*` folders are left alone.

## Build a branch

Workflow: `.github/workflows/overhedge-server-deb.yml` (Actions tab: "Overhedge server deb").

```bash
# Any branch, tag or SHA of the fork; the workflow file itself is taken from --ref.
gh workflow run overhedge-server-deb.yml -R ferbiy/orca-overhedge --ref overhedge/ci -f ref=overhedge/patch-273
gh run list -R ferbiy/orca-overhedge --workflow overhedge-server-deb.yml -L 1
gh run watch <run-id> -R ferbiy/orca-overhedge --exit-status
```

- Branches that do not contain the workflow (e.g. `overhedge/remote-control`) build fine through
  `-f ref=...` while dispatching from `overhedge/ci`.
- It runs upstream's `qualified-orcad-template.yml` (the same server-template qualification
  release-cut uses, on GitHub-hosted runners), then builds and packages the deb only. That reusable
  workflow, `node-server-tests.yml` and `.github/actions` are taken from `overhedge/ci`, which is
  synced to v1.4.273; keep them in step with the base when it moves again.
- No secrets are needed. The build is unsigned and has telemetry compiled to null.
- Package version: `<package.json version>+overhedge.<run number>.g<sha10>`, e.g.
  `1.4.273+overhedge.21.g0123456789`. dpkg sorts it above `1.4.273`. The app's own version checks
  ignore the `+...` part (`src/shared/app-lifecycle/identity/app-version.ts`), so the app still
  counts as 1.4.273 (also for the chat store's old-journal retirement, which waits for a later
  version than the one that copied the profile).
- Use a full 40-character SHA for `-f ref=<sha>`: actions/checkout cannot fetch a short one.
- Pushing an edit of the workflow file to an `overhedge/**` branch starts a run that skips every
  job. It exists only so GitHub lists the workflow for dispatch: the file is not on the fork's
  default branch, which mirrors upstream `main`.

## macOS app

Workflow: `.github/workflows/overhedge-mac-app.yml` on `overhedge/ci` ("Overhedge mac app").

```bash
gh workflow run overhedge-mac-app.yml -R ferbiy/orca-overhedge --ref overhedge/ci \
  -f ref=<full sha of overhedge/patch-273> -f arch=arm64
```

- Upstream builds the mac app in `release-mac-build.yml` (dispatched by `release-cut.yml`) with a
  Developer ID certificate (`MAC_CERTS`), notarization (`APPLE_ID`, app password, team
  6CX3WHS9HZ) and `ORCA_MAC_RELEASE=1` (hardened runtime, `sign-mac-app.mjs`). We have none of
  those secrets. The fork workflow runs the same build steps without `ORCA_MAC_RELEASE` and packages
  a zip with `electron-builder --mac zip --arm64 -c.mac.identity=-`, i.e. an **ad-hoc** signature
  (an unsigned arm64 app would be killed at launch). Not notarized, no hardened runtime.
- Same `appId` (`com.stablyai.orca`) and product name, so it uses the same data
  (`~/Library/Application Support/orca`, `~/.orca`) as the official app.
- Updates: upstream's updater (electron-updater, feed
  `https://github.com/stablyai/orca/releases/latest/download`, `latest-mac.yml`, Squirrel.Mac)
  starts only in a packaged app; the overhedge guard turns it off for this build (above). The
  workflow refuses a ref without the guard and checks that `app.asar`'s package.json carries the
  stamped `+overhedge` version the guard keys on.
- Keychain: Electron safeStorage keeps its key in the login keychain item "Orca Safe Storage",
  whose access list trusts the official app's designated requirement (Apple anchor + team
  6CX3WHS9HZ + `com.stablyai.orca`). An ad-hoc app does not match it, so macOS asks once for the
  login password; **Always Allow** keeps everything readable. Deny leaves Orca-encrypted secrets
  (saved API keys, connector tokens) unreadable for that run; nothing is re-encrypted. An ad-hoc
  signature changes with every build, so each new build asks again. Claude Code's own credentials
  are written and read by the `claude` CLI through `/usr/bin/security`, so they are unaffected.
  Privacy grants (Files and Folders, Accessibility, Screen Recording for computer use) are tied to
  the signature too and may need granting again. A stable self-signed certificate (one-time
  "Always Allow", then quiet across builds) would avoid the repeat prompts; not set up.
- Install (manual): quit Orca; keep the official app as `Orca-official-<version>.app`; unzip the
  artifact; `xattr -dr com.apple.quarantine Orca.app`; move it to `/Applications`. Rollback:
  quit, reinstall the official app from https://github.com/stablyai/orca/releases (or orca.dev).

## Download the artifact

```bash
gh run download <run-id> -R ferbiy/orca-overhedge -D ~/orca-debs/
# -> ~/orca-debs/orca-ide_1.4.273+overhedge.N.g<sha>_amd64/orca-ide_..._amd64.deb (+ .sha256)
scp ~/orca-debs/orca-ide_*overhedge*/orca-ide_*_amd64.deb orca-ide-ts:/tmp/
```

## Server facts (read-only inspection, 2026-11-19)

- The package installs to `/opt/Orca`; `/usr/bin/orca-ide` points to it. No apt repo is
  configured, so nothing updates it on its own. No official .deb is kept on the server.
- `orca-serve.service`: `ExecStart=/usr/bin/orca-ide serve --port 6768 --pairing-address
  100.121.247.8 --json` as `ubuntu`. Drop-in `keep-sessions.conf`: `KillMode=process`,
  `Restart=always`.
- Processes: the serve CLI (Electron as node, MainPID) starts **orcad**, a plain-Node runtime from
  `~/.config/orca/orcad-artifacts/linux-x64-glibc/<version>+<hash>/`. orcad starts the PTY
  daemon (`daemon-v55`). Agents (`claude …`) run in bash shells inside daemon PTYs. A
  1.4.218 daemon (`daemon-v37`, pid 2503) is still alive with its old shells.
- Data: `~/.config/orca` (2.3 GB): `agent-session-journal.db` (175 MB, plus -wal/-shm),
  `orchestration.db`, `orca-devices.json` (paired devices), `orca-e2ee-keypair.json`,
  `claude-profiles/`, `orcad-artifacts/`, `daemon/`. Also `~/.orca`.
- The server cannot update itself back to the official build. A deb install reports
  `manual-service-update-required`
  (`src/main/updater/lifecycle/updater-remote-status.ts:33-44`). The orcad runtime has no updater
  and throws `remote_update_manual_required` (`src/main/runtime/remote-server-updater.ts:14-35`).
  Headless serve downloads are refused too (`updater-install-support.ts` `deferHeadlessServeInstall`).

## What a restart does

- `systemctl restart orca-serve` stops the serve CLI. It forwards SIGTERM to orcad
  (`src/cli/runtime/serve-update-supervisor.ts`), and the new serve starts orcad from the new
  package's template. The new template gets a new slot, so **runtime, chat, agent-launch and
  account code take effect on restart**.
- The PTY daemons outlive orcad (`KillMode=process`; `orcad-daemon-retirement.ts`: "Daemons
  outlive orcad"). The new orcad re-adopts the running `daemon-v55`, so terminals and the agents
  in them keep running, **but on the old daemon code**. Daemon-side (PTY host) changes reach only
  a new daemon: after all its sessions end, or after the protocol version changes.
- Desktop and mobile clients drop the websocket for the few seconds of the restart and then
  reconnect. A structured-chat turn that is streaming during the restart may be interrupted
  (inferred, not tested).

## What changes between 1.4.266 and 1.4.273 (server and Mac)

- Daemon protocol 61 -> 62. New terminals start in a `daemon-v62`; running `daemon-v61` (and
  older) are kept as legacy adapters, so terminals stay. A rollback to 1.4.266 does not attach
  `daemon-v62`: terminals started under 273 are lost on rollback.
- `orchestration.db` schema 48 -> 51 (v49 indexes, v50 nullable columns + `peer_questions_out`,
  v51 `chat_lineage`). Additive; 1.4.266's migrate returns early on a newer `user_version`.
- Chat store `agent-session-domain.db`: schema version unchanged (2); new expression indexes
  (`journal-submission-window-indexes.ts`, "older builds never name these indexes"), stored rows
  gain optional fields that 1.4.266's zod schemas strip. 273 counts as later than the 266 copy, so
  it may retire the old `agent-session-journal.db`; that matters only for a rollback to 1.4.251.
- Session-search cache: a one-time reread (no schema bump); harmless on rollback.

## What changed between 1.4.251 and 1.4.266 on the server

- Daemon protocol 55 -> 61. The 266 runtime starts a `daemon-v61` for new terminals and keeps
  older daemons (the running `daemon-v55`, `daemon-v37`) as legacy adapters
  (`src/main/daemon/providers/routing/daemon-legacy-adapters.ts`), so running terminals stay.
- Native chats move to a SQLite store, `agent-session-domain.db` (#39256). The first 266 launch
  copies every chat from `agent-session-journal.db`, which 266 opens read-only and never writes.
  The old journal is deleted only by a version later than the one that copied it (1.4.266 and
  1.4.266+overhedge.N compare equal, so neither deletes it).
- `orchestration.db` schema 46 -> 48 (additive columns, indexes, triggers); 1.4.251 accepts a
  newer schema without refusing.
- Some JSON caches (last status, GitHub cache, model catalog, mobile notification dismissals) are
  converted to SQLite and their JSON removed.

## Rollout (run manually; nothing here has been executed)

The step-by-step plan, hashes and checks live in `decisions/rollout-and-test-plan.md` (outside
this repo). In short:

```bash
ssh orca-ide-ts
sudo systemctl stop orca-serve                      # graceful stop: dbs quiescent, layouts flushed
ts=$(date +%Y%m%d-%H%M%S)
tar -C ~/.config -czf ~/orca-debs/orca-config-$ts.tgz \
  --exclude='orca/orcad-artifacts' --exclude='orca/Cache' --exclude='orca/Code Cache' --exclude='*.sock' orca
tar -C ~ -czf ~/orca-debs/dot-orca-$ts.tgz .orca
sudo apt-get install -y ~/overhedge-build/artifacts/orca-ide_1.4.273+overhedge.N.g<sha>_amd64.deb
sudo systemctl start orca-serve
dpkg-query -W orca-ide
journalctl -u orca-serve -n 100 --no-pager
```

## Rollback

- To the official 1.4.273 (same data format, nothing to undo):
  `sudo apt-get install -y --allow-downgrades ~/overhedge-build/artifacts/orca-ide_1.4.273_amd64.deb`
  between `systemctl stop` and `start`. Pins (`claude-profiles/`) are ignored by the official build.
- To the previous install, `old/orca-ide_1.4.266+overhedge.14.g327df9075c_amd64.deb`, or the
  official `old/orca-ide_1.4.266_amd64.deb`: possible (see the 266 -> 273 notes: additive schemas;
  terminals started under 273 in `daemon-v62` are lost).
- To the official 1.4.251 (what runs today): possible, with caveats. Stop serve gracefully first,
  and do not run anything newer than 1.4.266 before (it would delete the old chat journal).
  1.4.251 reads `agent-session-journal.db` as it was at the upgrade: chats and turns created under
  266 are not shown (they stay in `agent-session-domain.db` and come back on a later upgrade, a chat
  continued on both sides showing as two). Terminals started under 266 live in `daemon-v61`, which
  1.4.251 does not attach; stop it before starting 251. Restoring the pre-upgrade tarball is not
  needed, and would drop anything written since.
