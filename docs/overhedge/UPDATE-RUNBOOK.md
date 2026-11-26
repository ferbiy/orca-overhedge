# Overhedge Orca fork: automatic update runbook

This runbook is the source of truth for the scheduled update of the Overhedge fork of Orca. A
headless Claude session follows section 4 on every run; the shell scripts around it (sections 3
and 8) are deterministic. Canonical copy: `docs/overhedge/UPDATE-RUNBOOK.md` on the fork's
`overhedge/ci` branch; installed copy: `~/overhedge-build/UPDATE-RUNBOOK.md` on orca-ide.

## 1. What is where

| Thing | Where |
|---|---|
| Fork | `github.com/ferbiy/orca-overhedge` (public). Upstream: `github.com/stablyai/orca` |
| Branches | `main` = plain mirror of upstream main (never pushed by us); `overhedge/main` = the patched Orca now (default branch; builds and releases come from it); `overhedge/ci` = the CI workflows, this runbook and `tools/overhedge/`; `overhedge/port-<id>` = transient branch of a port in progress (deleted by `promote.sh`); `overhedge/rehearsal/*` = rehearsal scratch. Nothing else: no base or per-release patch branches (old ones are tags `archive/overhedge/<name>`). The permanent branch is `overhedge/main`, not `overhedge`: git cannot have a ref `overhedge` next to `overhedge/ci` |
| Tags | upstream `vX.Y.Z` = the base of a port (fetched from stablyai/orca, not pushed to the fork); `overhedge-port/vX.Y.Z` = head of the port onto that tag (linear history on it, what CI built); `vX.Y.Z-overhedge.<n>` = a GitHub Release (`<n>` = the deb's build number); `archive/overhedge/*` = former branches |
| Releases | `github.com/ferbiy/orca-overhedge/releases`: one per verified port (deb, mac zip, Linux AppImage when built, `SHA256SUMS`; never updater metadata), marked latest, created by `release.sh` |
| How `overhedge/main` moves | `promote.sh`: a merge commit with the old `overhedge/main` as first parent and the port head as second, whose tree is exactly the port head's tree. Append-only, no force push; `git log --first-parent overhedge/main` lists one "port to vX.Y.Z" per port plus fixes made between ports |
| Patch description | `OVERHEDGE.md` on `overhedge/main`: what the patch adds, overlap with upstream, how the last port went |
| CI | `overhedge-server-deb.yml` (server .deb), `overhedge-mac-app.yml` (ad-hoc signed macOS zip); both dispatched from `overhedge/ci` with `-f ref=<full sha>` |
| Build host | orca-ide (Ubuntu 24.04 x86_64, 16 CPUs). Work dir `~/overhedge-build/` |
| Scripts | `~/overhedge-build/scripts/` (installed from `tools/overhedge/` by `install.sh`) |
| Clone used by the automation | `~/overhedge-build/fork` (origin = fork, upstream = stablyai/orca, pre-push guard installed); port worktrees `~/overhedge-build/base-<id>` (detached at the upstream tag), `port-<id>` (branch `overhedge/port-<id>`), `ci` |
| Artifacts | `~/overhedge-build/artifacts/` (+ `SHA256SUMS`), `old/`, `rollback/`, `mac/`, `linux/` (desktop AppImage) |
| Config | `~/overhedge-build/update.conf` (policy, window, notifier, Claude login), `~/overhedge-build/hosts.conf` (deploy targets) |
| State | `~/overhedge-build/state/` (`pending/<host>`, `result-<id>.env`, `stopped-<id>`, `last-deploy.env`, `approved`) |
| Logs | `~/overhedge-build/logs/` (`run-*.log`, `claude-*.jsonl`, `report-*.md`, `deploy-*.log`, `deploy-pending.log`) |
| Human log | `~/overhedge-build/update-log.md`: one entry per run and per deploy attempt (the founder reads this) |
| Live service | `orca-serve.service` (`KillMode=process`, `Restart=always`), port 6768, package `orca-ide` in `/opt/Orca` |
| Manual install guide for other servers | `~/overhedge-build/OVERHEDGE-ORCA-INSTALL.md` |

## 2. Hard rules (every run, every step)

1. Never print, echo, log or copy tokens, passwords, emails, account or organisation names. Never
   run `gh auth token`, `gh auth status --show-token`, `env`/`printenv`. Never read
   `~/.config/orca/orca-runtime.json`, anything else under `~/.config/orca/`, `~/.claude*`,
   `~/.config/gh/`, `~/.ssh/` or `~/.*-token` (the one exception: this session's own saved tool
   outputs under `<CLAUDE_CONFIG_DIR>/projects/*/tool-results/`, which Claude Code itself points to).
2. Heavy work only in Docker under `~/overhedge-build/` with `--cpus 6` (the scripts do this):
   no `pnpm`/`npm`/`node`/`npx` on the host, no builds or tests outside containers.
3. Git: work only in `~/overhedge-build/fork` and its worktrees. No force-push, no branch deletion
   (except this run's `overhedge/rehearsal/*` branches, and `overhedge/port-<id>` which `promote.sh`
   deletes once its port tag exists), never push to `main`, never create branches outside the
   layout (section 1), never move or delete a tag, move `overhedge/main` only through `promote.sh`.
   The pre-push guard enforces this; do not bypass it (`--no-verify` is forbidden). GitHub Releases
   only through `release.sh`; never `gh release delete`.
4. The live service is not yours: no `systemctl stop/start/restart`, no `apt`/`dpkg -i`, no `sudo`,
   nothing under `/opt/Orca`. Allowed read-only: `systemctl status/show`, `journalctl -u orca-serve`,
   `ps`, `orca-ide status|terminal list|agent list`, `deploy.sh --check-only|--dry-run`. Deploys happen
   only through `overhedge-deploy.timer` (section 8).
5. Never read or touch the content of chats or terminals (`orca-ide agent read`, `terminal read`,
   `terminal send` are forbidden), never close, start or message agents.
6. Do not edit `update.conf`, `hosts.conf`, `~/overhedge-build/scripts/`, `state/pending/`,
   `state/approved`. `README.md` and `docs/overhedge/*.svg` are carried over from the previous
   patched Orca unchanged (on a conflict take its file as a whole:
   `git -C <port-tree> show <from-sha>:README.md > README.md`); never rewrite them.
7. When a stop condition (section 6) holds, stop: write `RESULT=stopped` and the report. Do not
   "make it work" by weakening tests, deleting failing tests, skipping checks, or dropping parts of
   the patch.

## 3. Run flow (deterministic wrapper)

`overhedge-update.timer` -> `overhedge-update.service` -> `scripts/run-update.sh`:

1. Lock; free disk >= `MIN_FREE_GB` (default 60 GB) under `~/overhedge-build`, else a "STOPPED: low
   disk" entry and exit.
2. `latest-upstream.sh` (newest stable `vX.Y.Z` release of stablyai/orca; drafts, prereleases and
   `android-v*` tags skipped). Statuses that end the run without starting Claude, each with one
   entry in `update-log.md` and a notification:
   `up-to-date` (installed build already on the newest release), `deploy-pending` (a verified build
   waits for the deploy timer), `wait-for-asset` (the release has no official `.deb` yet),
   `failed-before` (an earlier run stopped for a human: `state/stopped-<id>`; `run-update.sh --retry`
   after looking).
3. Otherwise (`needs-port` / `needs-build`): `claude -p` with `automation-prompt.md`, model and
   login from `update.conf`, permissions from `claude-settings.json` (`dontAsk`: anything not on the
   allowlist is denied, see section 11), at most `CLAUDE_MAX_HOURS` (10 h).
4. After Claude: reads `state/result-<id>.env`. For `RESULT=ready` it re-validates the deb (in
   `artifacts/SHA256SUMS`, package `orca-ide`, version `<ver>+overhedge.*`, above the installed one)
   and writes `state/pending/<host>` for every host in `hosts.conf`. Appends the agent's report plus
   the outcome to `update-log.md` and notifies.

## 4. The port (what the Claude session does)

Write paths literally (`~/overhedge-build/...`) and call scripts with their full path
(`~/overhedge-build/scripts/<name>.sh`): the permission allowlist matches that form, and the
permission check denies commands that contain `$(...)`, `$?` or shell variables it cannot resolve.
Run the inner command first and paste its literal output (e.g. the full sha) into the next one.
`<id>` is the release id (`1.4.274` -> `274`), `<prev>` the upstream version of the previous port
(`PREV_VERSION`, tag `overhedge-port/v<prev>`), `<from-sha>` the `overhedge/main` commit the port
starts from (`FROM_SHA` from `port-prep.sh`, also in `port-<id>/.chk/from.sha`).
`<prefix>` is `overhedge`, or `overhedge/rehearsal` in a rehearsal (section 4.9).

If an earlier run of the same release crashed half-way (worktrees or local branches already exist),
continue from where it is rather than starting over; never delete pushed work.

### 4.1 Understand the drift (before touching code)

1. Read `OVERHEDGE.md` on `origin/overhedge/main` (what the patch adds, the overlap section, last port notes).
2. List every stable release between the previous base and the target:
   `gh release list -R stablyai/orca -L 40` and read each one's notes (`gh release view v1.4.N -R stablyai/orca`).
3. Files our patch touches: `git -C ~/overhedge-build/fork diff --stat v<prev> origin/overhedge/main`.
   Upstream changes in exactly those files:
   `git -C ~/overhedge-build/fork diff --stat v<prev> v<new> -- <those files>`.
4. Overlap check (stop condition 1). Look for upstream shipping any of our features natively:
   - Remote Control in native Claude chats: `git grep -n enableRemoteControl v<new> -- src`.
   - Per-chat Claude account pins / `--account` on launches (upstream's model is host-wide
     `account select`): `git grep -nE "chat-account-pin|pinnedAccount|--account" v<new> -- src/cli src/main/claude-accounts`.
   - Shared Claude `sessions` folder across accounts: upstream's `shareClaudeProfileHistory`
     (`src/main/claude-accounts/profiles/setup/claude-profile-history.ts`) still unlinking `sessions`?
   - macOS updater guard: anything upstream added around `releaseUpdatesEnabled`/release channels.
   - Slash-menu entries for `/rc`, `/remote-control`, `/orca-account`, `/orca-migrate`.
   - Plugin task sources on the Tasks page (`taskSource.<id>.*` worker commands, merged into
     the patch on 2026-11-25): `git grep -n taskSources v<new> -- src`; upstream filling
     `contributes.taskSources` (community PR #26282 or similar) is a collision to report.
   Partial coverage that our code can simply reuse (as `account migrate --restart` reused upstream's
   `restartAgentPaneInPlace` in 273) is fine; write it down. Upstream doing the same thing
   differently, so that we would have to choose, is a stop.
5. Security-relevant upstream changes in areas we patch (stop condition 4 if they conflict with our
   code): authentication/authorization of RPC or pairing, credentials or keychain/safeStorage,
   account profile setup (`src/main/claude-accounts/**`), the updater (`src/main/updater/**`),
   process spawning of agents with injected env (`CLAUDE_CONFIG_DIR`, tokens), e2ee.
   Release notes mentioning "security", "CVE", "auth", "token", "credential" in these areas count.

### 4.2 Branches and the 3-way apply

```bash
~/overhedge-build/scripts/port-prep.sh v<new> --prefix <prefix>
```

It fetches, adds the worktree `~/overhedge-build/base-<id>` detached at the upstream tag (no base
branch) and `~/overhedge-build/port-<id>` on a new branch `<prefix>/port-<id>` at the tag
(rehearsal: `rehearsal-base-<id>`, `rehearsal-port-<id>`), and 3-way applies the squashed diff
`v<prev>..<from-sha>` (`<from-sha>` = `origin/overhedge/main`; for a re-port of a release that already
has a port tag, the previous port tag). Exit 0 = applied and committed; exit 3 =
conflicts listed in `CONFLICTS=`.

### 4.3 Resolve conflicts

For each conflicted file:
1. Read upstream's change: `git -C ~/overhedge-build/fork log --oneline v<prev>..v<new> -- <file>` and
   the commits' diffs. Understand why upstream changed it.
2. Re-express our change on top of upstream's new code. Keep upstream's behavior everywhere our
   patch does not deliberately change it. Prefer reusing an upstream mechanism over keeping a
   parallel one of ours (and note it in OVERHEDGE.md).
3. Deleted/renamed upstream files: follow the move; if upstream dropped test support we rely on,
   restore it only inside our own test files (as 273 did for the Claude session test support).
4. Not confident about a resolution (you cannot explain upstream's intent, or two readings are
   plausible and they behave differently for users) -> stop condition 3. More than 40 conflicting
   files -> stop condition 3 as well (too much drift for an unattended port).

Then `git add` and commit: `overhedge: re-apply the patch onto v<new>` with a body listing the
hand-resolved files and one line each on how. Generated files: never hand-merge them; the `gen`
step in 4.4 regenerates (`pnpm generate:rpc-params-catalog`, inside Docker); commit the result.
Formatting: the `fmt` step checks the changed `.ts/.tsx`; to fix, run
`docker run --rm --cpus 6 -v /home/ubuntu/overhedge-build/port-<id>:/w -w /w node:24 bash -lc 'corepack enable && xargs pnpm exec oxfmt --write < .chk/changed-ts.txt'`
after an `install`.

Update `OVERHEDGE.md` on the port branch: versions in the header and the build/rollback examples,
a "Port <prev> -> <id>" paragraph (what conflicted and how it was resolved), and re-check every
bullet of "Overlap with upstream" against the new tag. Commit separately.

### 4.4 Checks and acceptance

```bash
# baseline: pristine upstream at the target tag (same container, same suite)
~/overhedge-build/scripts/checks.sh base-<id> v<new> install tc wide
# the port
~/overhedge-build/scripts/checks.sh port-<id> v<new>         # install gen fmt tc lint ours mobile wide
~/overhedge-build/scripts/compare-wide.sh base-<id> port-<id>
```

The two `checks.sh` calls can run in parallel (each container is limited to 6 CPUs). Each takes
roughly 30-60 minutes. Results: `<tree>/.chk/summary.txt`, logs `<tree>/.chk/*.log`.

Acceptance criteria (all must hold):
- `install=0 gen=0 fmt=0 tc=0 lint=0` (lint runs upstream's changed-code gate against the tag).
- `ours=0` and `mobile=0|skipped`: every test file the patch adds or changes passes.
- `compare-wide.sh` exit 0: no failing test in the patch that does not also fail in the base,
  after one re-run of the affected files in both trees (flakes are listed, not counted).
- The patch's wide suite has at least as many tests as the base's (our tests add to it). Fewer is
  only acceptable for upstream tests our patch deliberately removes (today: one case in
  `claude-profile-history.test.ts`, "keeps Claude's live sessions per folder"); anything else is a
  regression.
- The base's own failures are environment/flake noise (11 in 1.4.273's wide run); if the base fails
  `tc` or has hundreds of failures, the environment is broken: stop condition 6.

Failing criteria: fix and re-run the failing step only (`checks.sh port-<id> v<new> tc`, ...).
After 3 fix iterations without meeting the criteria, stop (condition 2).

### 4.5 Push and build in CI

```bash
git -C ~/overhedge-build/port-<id> push origin <prefix>/port-<id>
~/overhedge-build/scripts/sync-ci.sh v<new> --commit     # upstream CI files on overhedge/ci -> v<new>
git -C ~/overhedge-build/ci push origin overhedge/ci                    # skip in a rehearsal of the deployed release when nothing changed
git -C ~/overhedge-build/port-<id> rev-parse HEAD             # -> <full sha>
~/overhedge-build/scripts/ci-build.sh <full sha>
```

`sync-ci.sh` also reports whether upstream's `release-mac-build.yml` or `release-cut.yml` changed
since the previous base: if so, compare their build steps with `overhedge-mac-app.yml` /
`overhedge-server-deb.yml` and port the relevant step changes (same commit style:
`ci(overhedge): ...`). `ci-build.sh` dispatches both workflows, waits (often 40-90 minutes), and
prints `DEB_RUN DEB_RESULT DEB_ARTIFACT MAC_RUN MAC_RESULT MAC_ARTIFACT`.

A failed CI run: read the failing job's log (`gh run view <id> -R ferbiy/orca-overhedge --log-failed | tail -200`).
Infrastructure flakes (runner lost, download timeouts, the packaged node-pty floor smoke) -> re-run
once (`gh run rerun <id> --failed`). A real build failure caused by the patch -> fix, push a new
commit, rebuild; at most 2 such rounds, then stop (condition 2). A mac-only failure does not block
the server deb: report it.

### 4.6 Verify the artifacts

```bash
~/overhedge-build/scripts/fetch-and-verify.sh <DEB_RUN> <version> --mac-run <MAC_RUN>
~/overhedge-build/scripts/static-compare.sh ~/overhedge-build/artifacts/<deb> <version>
~/overhedge-build/scripts/smoke.sh <id> <deb file name> --control orca-ide_<version>_amd64.deb
```

- `fetch-and-verify.sh`: official deb sha512 = the release's `latest-linux.yml`; CI deb sha256 =
  its `.sha256`; package/arch; version `<ver>+overhedge.N.g<sha10>` sorts above `<ver>`; mac zip
  sha256; the Linux desktop AppImage (artifact `linux-appimage-*` of the deb run, into
  `artifacts/linux/`) sha256 and name `Orca-<ver>_overhedge.N.g<sha10>-linux-x86_64.AppImage`. Any
  FAIL -> stop (condition 5). `WARN no linux-appimage-* artifact` is not a stop: the workflow builds
  the AppImage continue-on-error; report it (and the failing step from the run log).
- `static-compare.sh`: exit 0 = same top-level paths, identical maintainer scripts, no non-chunk file
  missing. Expected differences: Version/Installed-Size, renamed bundle chunks, `app.asar`,
  `orcad-template`, a few dozen changed bundles. Exit 1 -> read the output; new maintainer-script
  differences or missing files -> stop (condition 5).
- `smoke.sh`: isolated container, both the patched and the official deb start `orca-ide serve`, stay
  up 2+ minutes, and our CLI surface (`account migrate`, `--account`) answers in the patched one
  (the control answers `Unknown command`). Errors that appear in both logs (no browser provider in
  the container) are expected. Patched serve not staying up -> stop (condition 5).

### 4.7 Go / no-go

Go (`RESULT=ready`) only when 4.4 acceptance holds, the deb CI run succeeded, and 4.6 passed. Then:
- not a rehearsal, promote: `~/overhedge-build/scripts/promote.sh v<new> <port sha> <from-sha>`
  (`--dry-run` first). It tags `overhedge-port/v<new>` at the port head, moves `overhedge/main` to a
  merge commit (first parent the old `overhedge/main`, second the port head, tree = the port head's)
  in one atomic push, deletes `overhedge/port-<id>` and keeps the default branch on `overhedge/main`.
  If it reports that `overhedge/main` moved during the port, cherry-pick the listed commits onto the
  port branch, push, rebuild and verify again (4.5, 4.6), then promote with the new main head as
  `<from-sha>`.
- not a rehearsal, publish: write the user-facing notes (5-15 lines, Markdown, no headings above
  `##`: what changed for users since the previous release: the upstream versions pulled in with
  their notable changes, and what our patch added, changed or dropped, from the port paragraph of
  OVERHEDGE.md) to `~/overhedge-build/logs/release-notes-<id>.md`, then
  `~/overhedge-build/scripts/release.sh --deb <deb> --mac <mac zip> --appimage <AppImage> --notes ~/overhedge-build/logs/release-notes-<id>.md --dry-run`
  (leave out `--mac`/`--appimage` when that build is missing), check the output, and run it again
  without `--dry-run`. It refuses files whose checksums do not match `SHA256SUMS`, a commit that is
  not in `overhedge/main`, and any updater metadata. Put the printed `RELEASE_URL` in the result
  file and the report. A failed release (GitHub outage) does not block the deploy: report it; the
  command is idempotent and can be re-run by hand.
- rehearsal: no promote, no release; run `release.sh ... --dry-run` only.
- run `~/overhedge-build/scripts/deploy.sh --dry-run <deb>` once and put its last lines in the
  report (it shows whether the host could deploy right now and which rollback deb it would use).
- `~/overhedge-build/scripts/cleanup.sh --dry-run`, then `cleanup.sh` (keeps the installed, pending and
  rollback debs, the newest `KEEP_BUILDS`, the newest port worktrees).

### 4.8 Result file and report

`state/result-<id>.env` (path given in the prompt), plain `KEY=value`, no quotes needed:

```
RESULT=ready|stopped|failed
REASON=<one line: why stopped/failed; empty for ready>
DEB=/home/ubuntu/overhedge-build/artifacts/orca-ide_<ver>+overhedge.N.g<sha10>_amd64.deb
APPIMAGE=/home/ubuntu/overhedge-build/artifacts/linux/<name>.AppImage   # empty when there is none
MAC_ZIP=/home/ubuntu/overhedge-build/artifacts/mac/<name>.zip
PORT_TAG=overhedge-port/v<new>
PORT_SHA=<full sha of the port head = the built commit>
MAIN_SHA=<overhedge/main after promote.sh>
RELEASE_URL=<printed by release.sh; empty in a rehearsal or when the release failed>
```

`failed` = something broke that is not a judgement call (tooling, GitHub outage); the next run
retries. `stopped` = a stop condition; nothing runs again for this release until a human looks.

Report (`logs/report-<id>-<ts>.md`, path given in the prompt): written for the founder, who reads
only `update-log.md`. Plain language, at most ~25 lines:
- one-line outcome (ready / stopped: why / failed: why) and the release range (e.g. 273 -> 278,
  5 upstream releases);
- upstream changes that matter to us (from the release notes), overlap check result;
- conflicts: count and the notable resolutions; whether the patch changed in behavior;
- checks: tc/lint/ours, wide suite counts base vs patch, new failures (none / list), flakes;
- CI run links, deb name and sha256 prefix, smoke/static verdicts;
- for `stopped`: the decision needed, the options you see, and what you would recommend;
- Mac: the zip's path on orca-ide and the install line from OVERHEDGE.md "macOS app".
- Linux desktop: the AppImage's path (or that it is missing and why); the deb is the desktop app too.
No tokens, emails, account or org names; no chat or terminal content.

### 4.9 Rehearsal mode

`run-update.sh --rehearsal v<tag>` (prefix `overhedge/rehearsal`, nothing deployed, no stop marker):
same steps on the branch `overhedge/rehearsal/port-<id>`, worktrees `rehearsal-base-<id>` /
`rehearsal-port-<id>`. No `promote.sh`, no release (only `release.sh --dry-run`), no default-branch
change. Push the rehearsal branch only if the CI build is part of the rehearsal; at the end delete it
(`git -C ~/overhedge-build/fork push origin :overhedge/rehearsal/port-<id>`) and remove the rehearsal worktrees
(`git -C ~/overhedge-build/fork worktree remove --force <dir>`) and local branches. `run-update.sh` deletes the rehearsal deb (and mac zip) after the run, so it never takes a
keep slot or sorts above a real build. Build the mac app in a rehearsal only from a ref that has the
updater guard (the mac workflow refuses others, e.g. a re-port of 266). A rehearsal of the release that
is already deployed re-ports it from the previous port tag (e.g. `overhedge-port/v1.4.273` -> 278;
`port-prep.sh` picks it because `overhedge-port/v<new>` exists), so it meets the same conflicts as the
real port did; compare the result with the real port
(`git diff overhedge-port/v<new> <rehearsal port head> --stat`) and describe the differences in the report. Keep `overhedge/ci` unchanged in a rehearsal
unless `sync-ci.sh` shows a real difference (then stop and report it instead).

## 5. Deploy policy (one switch)

A restart of `orca-serve` cuts any UI chat that is mid-turn (Claude chat processes are children of
orcad and stop; they resume on the next message, but the running turn is lost). Terminals and the
agents in them survive (`KillMode=process`; the PTY daemon outlives orcad).

`DEPLOY_POLICY` in `~/overhedge-build/update.conf`:

| Value | Behavior | Trade-off |
|---|---|---|
| `confirm` | build + verify automatically; deploy only after `~/overhedge-build/scripts/approve.sh`, then at the next 15-minute slot when no UI chat is busy | safest; needs the founder every time, so the server lags until he acts |
| `night-idle` (**recommended, active**) | deploy automatically between `DEPLOY_WINDOW_START` and `DEPLOY_WINDOW_END` (02:00-06:00 Europe/Berlin), retrying every 15 min, only when `deploy.sh --check-only` reports no busy UI chat; if the window closes without a safe moment, report once and retry the next night | an overnight agent turn can postpone a deploy; never cuts a running turn |
| `always` | deploy at the next slot even if a UI chat is mid-turn (`--force`) | cuts turns; only for urgent fixes |
| `off` | never deploy | builds pile up as pending |

Why `night-idle`: every deploy is already gated by the stop conditions, the acceptance criteria and
automatic rollback; the only remaining user-visible cost of a restart is a cut turn, which the idle
check plus the night window avoid. `confirm` would leave the server several releases behind
whenever the founder is busy.

Busy = `orca-ide agent list` shows a chat in `working`, `blocked` or `waiting` (a pending question or
permission prompt counts as busy), or a Claude chat process under the service used >= 30 CPU ticks
(0.3 s) in a 10 s sample. Exit codes of `deploy.sh --check-only`: `0` safe, `3` busy, `4` not safe
(service not healthy, `agent list` failing, sudo/pigz missing, apt running, < 10 GB free).

## 6. Stop conditions (no deploy, `RESULT=stopped`, report the decision needed)

1. Upstream shipped one of our features natively, or something that collides with it in behavior
   (4.1.4): the founder decides whether to drop, adapt or keep our version.
2. Tests regress versus the pristine-base baseline after 3 fix iterations, or the CI build fails
   for patch reasons after 2 rounds.
3. A conflict you cannot resolve with confidence, or > 40 conflicting files.
4. Security-relevant upstream changes inside code we patch (4.1.5) that conflict with our change.
5. Artifact verification fails (checksums, version, static compare structure, smoke serve not
   staying up).
6. Environment problems you cannot fix inside `~/overhedge-build` (Docker down, the base itself
   fails `tc`, GitHub permissions) — use `failed` instead when it is clearly transient.
7. Disk: less than 40 GB free during the run (`df -h ~`), even after `cleanup.sh`.
8. A major/minor version bump (e.g. 1.4.x -> 1.5.0): release ids and drift assumptions change.
9. Anything that would need a hard rule broken (section 2).

## 7. Post-deploy verification and rollback (done by deploy.sh)

`deploy.sh <deb>` (run by `deploy-pending.sh` under `overhedge-deploy.service`, never from a chat):
1. Preflight as in `--check-only`, plus: the deb is in `SHA256SUMS` and matches, package `orca-ide`,
   amd64; a rollback deb for the installed version exists in `artifacts/`, `old/` or `rollback/`
   (if not, it fetches the official one from GitHub, or `dpkg-repack`s an overhedge build; refuses
   if neither works).
2. Snapshot into `~/overhedge-build/backup-<ts>/` (mode 700): version, service props, terminal handles
   + connected flags, agent process list (pid, elapsed, name only), `sessions` link targets of the
   managed Claude profiles.
3. `sudo systemctl stop orca-serve`; backup `tar -I pigz` of `~/.config/orca` (without
   orcad-artifacts, caches, codex sessions, sockets) and `~/.orca`, each tested with `pigz -t`
   (backup failure -> start the old build again, refuse).
4. `apt-get install -y <deb>`; start; health within 240 s: active, HTTP 200 on 127.0.0.1:6768,
   `orca-ide status` runtime `ready`; then 60 s without a restart (same MainPID and NRestarts).
5. **Rollback criteria** (automatic `apt-get install --allow-downgrades <previous deb>`, start, same
   health check): install fails, installed version differs, health timeout, a restart in the
   stability window. Exit 5 = rolled back and healthy; exit 6 = rollback failed too (update-log and
   notification say "needs a human now").
6. Reported but not rolled back (`RESULT=degraded`): fewer connected terminals than before, journal
   error lines since the start (listed in the backup dir), agent processes that ended.

Manual rollback (human): `sudo systemctl stop orca-serve; sudo apt-get install -y --allow-downgrades
~/overhedge-build/artifacts/<previous deb>; sudo systemctl start orca-serve`. Data notes per version
are in OVERHEDGE.md ("Rollback"): schemas are additive; terminals started in a newer daemon protocol
are lost on a downgrade.

## 8. Hosts (N servers)

Build, port and verify happen once, on orca-ide. Each host in `~/overhedge-build/hosts.conf` gets its
own pending marker and is deployed independently by `deploy-pending.sh` with the same policy; the
idle check runs on that host; one host busy, unreachable or failing never blocks or rolls back
another; `update-log.md` has one entry per host per attempt (`[orca-ide] ...`, `[team-server] ...`).

```
# name        ssh target             transfer  [key=<identity file on orca-ide>]
orca-ide      local                  local
team-server   admin@159.195.209.86   scp       key=~/.ssh/team-server-admin
```

A remote host is skipped with a `[<name>] not ready: orca-serve.service missing` (or `deploy.sh
missing`, or `not reachable`) line in `logs/deploy-pending.log` until it is ready; its marker stays
and is replaced by the next build. Only the build host's marker (`pending/orca-ide`) makes
`latest-upstream.sh` report `deploy-pending`; a remote host that lags never holds up new ports.

For a remote host, `deploy-pending.sh` copies the deb (and the deb the host runs now, if orca-ide has
it) to the host's `~/overhedge-build/artifacts/`, rewrites `SHA256SUMS` there, compares checksums,
runs `deploy.sh --check-only` on the host, then the host's own `deploy.sh <deb>` inside
`sudo systemd-run --wait` (a dropped ssh connection cannot cut the deploy in half).

### Adding a host

Prerequisites (set up by a human, once):
1. ssh from orca-ide (user `ubuntu`) to the host with a key, non-interactively
   (`ssh -i <key> -o BatchMode=yes <target> true` works), host key already in `~/.ssh/known_hosts`.
   The key path goes into `hosts.conf` as `key=...`; the key itself never leaves `~/.ssh`.
2. On the host: passwordless `sudo` for that user, at least for `systemctl`, `apt-get`,
   `systemd-run` (`sudo -n true` works); `pigz`, `jq`, `curl` installed; `orca-serve.service` set up
   as on orca-ide (`KillMode=process`, `Restart=always`), port 6768.
3. Our package installed by hand the first time (OVERHEDGE-ORCA-INSTALL.md), and its deb kept in
   the host's `~/overhedge-build/artifacts/` (or official, which `deploy.sh` can re-download), so a
   rollback target exists.
4. The tooling on the host: `~/overhedge-build/scripts/deploy.sh` and `lib.sh` (copy them from
   orca-ide with scp; timers run on orca-ide only). After every change of `deploy.sh`, copy it to the
   hosts again.
   Then `~/overhedge-build/scripts/deploy.sh --check-only` on the host must print `SAFE` or `BUSY`.
5. Add the line to `hosts.conf` on orca-ide. Test from orca-ide:
   `~/overhedge-build/scripts/deploy-pending.sh --dry-run --host <name>` (needs a pending marker; or
   `ssh <target> '~/overhedge-build/scripts/deploy.sh --check-only'`).

## 9. macOS app

The mac workflow builds an ad-hoc-signed, not notarized `Orca.app` zip (arm64). It cannot be
installed automatically: Gatekeeper quarantine, and each new ad-hoc signature makes macOS ask once
for the login password for the "Orca Safe Storage" keychain item. The automation only builds and
verifies it (`artifacts/mac/` on orca-ide, sha256 checked) and names it in the report. Install by
hand per the macOS install guide (`docs/overhedge/install/macos.md` on `overhedge/main`; OVERHEDGE.md
"macOS app" has the background): download it from the GitHub Release
(`github.com/ferbiy/orca-overhedge/releases/latest`), or copy it from orca-ide with
`scp orca-ide-ts:overhedge-build/artifacts/mac/<zip> .`.

## 9a. Linux desktop app

The server deb is also the Linux desktop app (same package; see OVERHEDGE.md "Linux desktop app";
install guides for people: `docs/overhedge/install/` on `overhedge/main`).
The deb workflow additionally packages an x64 AppImage of the same app tree (artifact
`linux-appimage-Orca-<ver>_overhedge.N.g<sha10>-linux-x86_64`), after the deb upload and
continue-on-error, so it never blocks the server. It refuses a ref whose updater guard does not
cover Linux. `fetch-and-verify.sh` puts it in `artifacts/linux/` (sha256 checked, `SHA256SUMS`);
`cleanup.sh` keeps the newest `KEEP_BUILDS`; a rehearsal deletes it. Nothing installs it. Developer
install guide: `~/overhedge-build/LINUX-DESKTOP-INSTALL.md` on orca-ide.

## 10. Scheduling and operations

Installed on orca-ide (system units, run as `ubuntu`; user units would need lingering):

| Unit | What |
|---|---|
| `overhedge-update.timer` | `OnCalendar=*-*-01,06,11,16,21,26 21:00 Europe/Berlin`, `Persistent=true` -> `overhedge-update.service` -> `run-update.sh` |
| `overhedge-deploy.timer` | every 15 min -> `overhedge-deploy.service` -> `deploy-pending.sh` (no-op without a pending marker) |

```bash
systemctl list-timers 'overhedge-*'                       # next runs
sudo systemctl start overhedge-update.service             # run the update now (blocks until done; add --no-block)
~/overhedge-build/scripts/run-update.sh --rehearsal v1.4.273   # rehearsal, never deploys
~/overhedge-build/scripts/run-update.sh --print-prompt    # what Claude would get
~/overhedge-build/scripts/approve.sh                      # DEPLOY_POLICY=confirm: approve the pending build
~/overhedge-build/scripts/deploy.sh --check-only          # safe to restart now? (0/3/4)
sudo systemctl disable --now overhedge-update.timer overhedge-deploy.timer   # turn everything off
sudo systemctl disable --now overhedge-deploy.timer       # keep building, never deploy (or DEPLOY_POLICY=off)
journalctl -u overhedge-update.service -u overhedge-deploy.service -n 50
```

Alternative scheduler (not installed): an Orca automation on orca-ide,
`orca-ide automations create --name "Overhedge update" --trigger "0 21 */5 * *" --provider claude
--workspace <worktree selector> --precheck "~/overhedge-build/scripts/latest-upstream.sh --needs-work"
--prompt "<automation prompt>"`. Drawbacks: it runs as an Orca chat/terminal, so it is itself a
child of the service it may restart (deploy therefore must stay in `overhedge-deploy.timer` anyway);
it uses the host-wide Claude account selection (our patch has no `--account` on `automations
create`), and its permission settings follow Orca's agent settings rather than a dedicated file.

## 11. Headless Claude: login and permissions

- Login: `CLAUDE_CONFIG_DIR_FOR_UPDATES` in `update.conf` (default `~/.claude-team`, a logged-in
  Claude subscription login on orca-ide, reused in place; no credentials are copied). The default
  `~/.claude` is not logged in. Check: `CLAUDE_CONFIG_DIR=~/.claude-team claude auth status --json | jq .loggedIn`.
- Flags: `claude -p --model opus --settings scripts/claude-settings.json --setting-sources project
  --permission-mode dontAsk --strict-mcp-config --add-dir ~/overhedge-build --output-format stream-json --verbose`.
  `--setting-sources project` keeps that login's personal settings/hooks out; `--strict-mcp-config`
  loads no MCP servers.
- `claude-settings.json`: allowlist (git, gh, docker, the overhedge scripts by full path,
  `deploy.sh --check-only|--dry-run`, read-only shell tools, Edit/Write under `~/overhedge-build`
  and `/tmp`) and denylist (sudo, apt, systemctl start/stop/restart, pnpm/npm/node on the host,
  force push/delete, `gh auth token`, reading `~/.config/orca`, `~/.claude*`, `~/.config/gh`,
  `~/.ssh`, token files; editing config, scripts, pending markers). This is a guard against
  mistakes, not a sandbox: `docker run -v` or `find -exec` could escape it. The pre-push guard and
  the deterministic deploy path are the real backstops.
- `gh`: the `ubuntu` user's existing gh login (scopes repo, workflow) is used by both the agent and
  the scripts; git pushes over HTTPS through `gh auth git-credential`.

## 12. Cadence

Upstream ships about one release a day, so a 5-day cadence ports ~5 releases at once. Conflicts grow
with the number of upstream commits touching the ~100 files our patch changes, not with the number of releases: the
two manual ports so far (251 -> 266: 15 releases; 266 -> 273: 7 releases) had 7-30 conflicting files,
and most of the cost of a run is fixed (two wide test suites, two CI builds, smoke: 3-4 hours of
machine time and one long agent session). Daily runs would multiply that fixed cost by five while
saving little resolution effort, and would restart the server up to daily. 5 days is a reasonable
default; 3 days is the cheaper choice only if the conflict count starts exceeding ~25 files per
run (then smaller steps are easier to resolve confidently and fewer runs hit stop condition 3).
