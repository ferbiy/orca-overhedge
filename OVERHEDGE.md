# Overhedge fork: server build and rollout

Only the server (`orca-ide`, Ubuntu 24.04, headless `orca serve` from the `orca-ide` .deb) runs
patched code. The macOS desktop stays on the official build. Base: `overhedge/base-266` = upstream
tag `v1.4.266`; the patch is `overhedge/patch-266`. (The previous 1.4.251 port: `overhedge/base`,
`overhedge/patch`.)

## What the patch adds (server side)

- `/rc` and `/remote-control [on [name]|<name>|off|status]` in native Claude chats: Orca toggles
  Claude Code Remote Control on the chat's live Claude child (Agent SDK `enableRemoteControl`) and
  answers with a status row; nothing reaches Claude (a malformed form gets a usage row). While it is
  on, prompts typed in claude.ai or the Claude app show in the Orca chat as user rows, and their
  replies as normal turns (`claude-remote-control-user-turn.ts`).
- The slash menu of a Claude chat lists `/rc`, `/remote-control` (live child only),
  `/orca-account` and `/orca-migrate`, appended to the catalog the server already reports.
- Per-chat Claude account pins: `/orca-account [<account>|auto]` and
  `/orca-migrate <account>|auto [--with-workers]` in a Claude chat; `orca account migrate` on the
  CLI (with opt-in `--restart` for terminal Claude tabs). Workers inherit their coordinator's pin.
- `--account <id|email>` on `orca agent launch`, `orca worktree create --agent claude` and
  `orca orchestration worker-start`: the new Claude chat or terminal is pinned before it starts.
  This differs from upstream's `orca account select --agent claude --account ...` (new in 1.4.266),
  which changes the host-wide selection for every later launch.
- Cross-account Claude peers: every Claude chat or terminal on the host lists and messages every
  other one (ListAgents / SendMessage), whatever managed account or System default it runs under.
  See "Cross-account Claude peers" below.

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
  where the `sessions` step is, then re-run `pnpm check:main-sync-fs-ratchet --prune` and the
  blocking-helper ratchet with `--prune` (the change shrinks `claude-profile-history.ts`'s counts).
  v1.4.273 has the same `claude-profile-history.ts`; onto `overhedge/patch-273` the commits apply
  except that 273 deleted `claude-profile-history.test.ts` (resolve with `git rm` of that file).
  Drop this change if upstream starts sharing `sessions` itself.
- `~/relink-sessions.sh` on the server (a manual workaround that relinks one account's `sessions`) is no longer
  needed with this build; its `sessions.plain-*` / `sessions.bak-*` folders are left alone.

## Build a branch

Workflow: `.github/workflows/overhedge-server-deb.yml` (Actions tab: "Overhedge server deb").

```bash
# Any branch, tag or SHA of the fork; the workflow file itself is taken from --ref.
gh workflow run overhedge-server-deb.yml -R ferbiy/orca-overhedge --ref overhedge/ci -f ref=overhedge/patch-266
gh run list -R ferbiy/orca-overhedge --workflow overhedge-server-deb.yml -L 1
gh run watch <run-id> -R ferbiy/orca-overhedge --exit-status
```

- Branches that do not contain the workflow (e.g. `overhedge/remote-control`) build fine through
  `-f ref=...` while dispatching from `overhedge/ci`.
- It runs upstream's `qualified-orcad-template.yml` (the same server-template qualification
  release-cut uses, on GitHub-hosted runners), then builds and packages the deb only. That reusable
  workflow, `node-server-tests.yml` and `.github/actions` are taken from `overhedge/ci`, which is
  synced to v1.4.266; keep them in step with the base when it moves again.
- No secrets are needed. The build is unsigned and has telemetry compiled to null.
- Package version: `<package.json version>+overhedge.<run number>.g<sha10>`, e.g.
  `1.4.266+overhedge.12.g0123456789`. dpkg sorts it above `1.4.266`. The app's own version checks
  ignore the `+...` part (`src/shared/app-lifecycle/identity/app-version.ts`), so the app still
  counts as 1.4.266 (also for the chat store's old-journal retirement, which waits for a later
  version than the one that copied the profile).
- Pushing an edit of the workflow file to an `overhedge/**` branch starts a run that skips every
  job. It exists only so GitHub lists the workflow for dispatch: the file is not on the fork's
  default branch, which mirrors upstream `main`.

## Download the artifact

```bash
gh run download <run-id> -R ferbiy/orca-overhedge -D ~/orca-debs/
# -> ~/orca-debs/orca-ide_1.4.266+overhedge.N.g<sha>_amd64/orca-ide_..._amd64.deb (+ .sha256)
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

## What changes between 1.4.251 and 1.4.266 on the server

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
sudo apt-get install -y ~/overhedge-build/artifacts/orca-ide_1.4.266+overhedge.N.g<sha>_amd64.deb
sudo systemctl start orca-serve
dpkg-query -W orca-ide
journalctl -u orca-serve -n 100 --no-pager
```

## Rollback

- To the official 1.4.266 (same data format, nothing to undo):
  `sudo apt-get install -y --allow-downgrades ~/overhedge-build/artifacts/orca-ide_1.4.266_amd64.deb`
  between `systemctl stop` and `start`. Pins (`claude-profiles/`) are ignored by the official build.
- To the official 1.4.251 (what runs today): possible, with caveats. Stop serve gracefully first,
  and do not run anything newer than 1.4.266 before (it would delete the old chat journal).
  1.4.251 reads `agent-session-journal.db` as it was at the upgrade: chats and turns created under
  266 are not shown (they stay in `agent-session-domain.db` and come back on a later upgrade, a chat
  continued on both sides showing as two). Terminals started under 266 live in `daemon-v61`, which
  1.4.251 does not attach; stop it before starting 251. Restoring the pre-upgrade tarball is not
  needed, and would drop anything written since.
