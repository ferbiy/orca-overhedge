# Overhedge fork: server build and rollout

Only the server (`orca-ide`, Ubuntu 24.04, headless `orca serve` from the `orca-ide` .deb) runs
patched code. The macOS desktop stays on the official build. Base: `overhedge/base` = upstream
tag `v1.4.251`.

## Build a branch

Workflow: `.github/workflows/overhedge-server-deb.yml` (Actions tab: "Overhedge server deb").

```bash
# Any branch, tag or SHA of the fork; the workflow file itself is taken from --ref.
gh workflow run overhedge-server-deb.yml -R ferbiy/orca-overhedge --ref overhedge/ci -f ref=overhedge/patch
gh run list -R ferbiy/orca-overhedge --workflow overhedge-server-deb.yml -L 1
gh run watch <run-id> -R ferbiy/orca-overhedge --exit-status
```

- Branches that do not contain the workflow (e.g. `overhedge/remote-control`) build fine through
  `-f ref=...` while dispatching from `overhedge/ci`.
- It runs upstream's `qualified-orcad-template.yml` (the same server-template qualification
  release-cut uses, on GitHub-hosted runners), then builds and packages the deb only.
- No secrets are needed. The build is unsigned and has telemetry compiled to null.
- Package version: `<package.json version>+overhedge.<run number>.g<sha10>`, e.g.
  `1.4.251+overhedge.7.g0123456789`. dpkg sorts it above `1.4.251`. The app's own version checks
  ignore the `+…` part (`src/shared/app-version.ts`), so the app still counts as 1.4.251.
- Pushing an edit of the workflow file to an `overhedge/**` branch starts a run that skips every
  job. It exists only so GitHub lists the workflow for dispatch: the file is not on the fork's
  default branch, which mirrors upstream `main`.

## Download the artifact

```bash
gh run download <run-id> -R ferbiy/orca-overhedge -D ~/orca-debs/
# -> ~/orca-debs/orca-ide_1.4.251+overhedge.N.g<sha>_amd64/orca-ide_..._amd64.deb (+ .sha256)
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

## Rollout (run manually; nothing here has been executed)

```bash
ssh orca-ide-ts
# 0. Keep the official package for rollback (no copy exists on the server today).
mkdir -p ~/orca-debs && cd ~/orca-debs
curl -fLO https://github.com/stablyai/orca/releases/download/v1.4.251/orca-ide_1.4.251_amd64.deb
# 1. Stop serve so the SQLite dbs are quiescent, then back up the data dir (dbs with their -wal/-shm).
sudo systemctl stop orca-serve
ts=$(date +%Y%m%d-%H%M%S)
tar -C ~/.config -czf ~/orca-debs/orca-config-$ts.tgz \
  --exclude='orca/orcad-artifacts' --exclude='orca/Cache' --exclude='orca/Code Cache' --exclude='*.sock' orca
tar -C ~ -czf ~/orca-debs/dot-orca-$ts.tgz .orca
# 2. Install the patched package and start serve again.
sudo apt-get install -y /tmp/orca-ide_1.4.251+overhedge.N.g<sha>_amd64.deb
sudo systemctl start orca-serve
# 3. Check.
dpkg-query -W orca-ide
journalctl -u orca-serve -n 100 --no-pager
ls ~/.config/orca/orcad-artifacts/linux-x64-glibc/     # a new <version>+<hash> slot
ps -o pid,ppid,etime,args -C node | cut -c1-160      # new orcad, old daemon-v55 adopted
```

`stop` then `start` (rather than `restart`) keeps the dbs closed while the backup runs. The
daemons and the shells in them are not stopped (`KillMode=process`).

## Rollback to the official 1.4.251

```bash
ssh orca-ide-ts
sudo systemctl stop orca-serve
sudo apt-get install -y --allow-downgrades ~/orca-debs/orca-ide_1.4.251_amd64.deb
# Only if the patched build migrated a db schema forward and the official build refuses it:
#   tar -C ~/.config -xzf ~/orca-debs/orca-config-<ts>.tgz    (this loses data written since the backup)
sudo systemctl start orca-serve
dpkg-query -W orca-ide   # 1.4.251
```
