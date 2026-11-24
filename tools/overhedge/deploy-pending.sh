#!/usr/bin/env bash
# deploy-pending.sh [--dry-run] [--host <name>]
#
# Run on orca-ide by overhedge-deploy.timer every 15 minutes (as ubuntu, outside orca-serve's
# process tree, so stopping orca-serve cannot kill it). For every host with a marker
# ~/overhedge-build/state/pending/<host> (written by run-update.sh after a verified build, one per
# host in hosts.conf) it applies DEPLOY_POLICY from update.conf, independently per host:
#   off         never deploys
#   confirm     deploys only after approval: state/approved holds the deb's file name
#               (approve.sh writes it); still waits for idle UI chats, any time of day
#   night-idle  deploys inside DEPLOY_WINDOW_START..DEPLOY_WINDOW_END (DEPLOY_TZ) when
#               `deploy.sh --check-only` ON THAT HOST reports no busy UI chat; otherwise retries
#               at the next slot and reports once per night when the window closes
#   always      deploys at the next slot even when a UI chat is busy (deploy.sh --force)
# Remote hosts: the deb (+ the deb the host runs now, for rollback, when we have it) is copied to
# the host's ~/overhedge-build/artifacts with scp, then the host's own deploy.sh runs there via
# `sudo systemd-run --wait` (so a dropped ssh connection cannot cut a deploy in half).
# One host failing, busy or unreachable never blocks or rolls back another.
# Each outcome goes to update-log.md (one entry per host) and the notifier.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
ovh_load_conf
dry=0; only=""
while [ $# -gt 0 ]; do
  case "$1" in --dry-run) dry=1 ;; --host) only=$2; shift ;; *) echo "unknown arg $1" >&2; exit 2 ;; esac
  shift
done
PD=$OVH_STATE/pending
compgen -G "$PD/*" >/dev/null || exit 0
mkdir -p "$OVH_LOGS"
export OVH_LOG_FILE=$OVH_LOGS/deploy-pending.log
exec 8> "$OVH_STATE/deploy-pending.lock"
flock -n 8 || exit 0

now_min() { local t; t=$(TZ=$DEPLOY_TZ date +%H:%M); echo $((10#${t%:*} * 60 + 10#${t#*:})); }
to_min() { echo $((10#${1%:*} * 60 + 10#${1#*:})); }
in_window() {
  local n s e
  n=$(now_min); s=$(to_min "$DEPLOY_WINDOW_START"); e=$(to_min "$DEPLOY_WINDOW_END")
  if [ "$s" -le "$e" ]; then [ "$n" -ge "$s" ] && [ "$n" -lt "$e" ]; else [ "$n" -ge "$s" ] || [ "$n" -lt "$e" ]; fi
}
last_slot() { local n e; n=$(now_min); e=$(to_min "$DEPLOY_WINDOW_END"); [ $(( (e - n + 1440) % 1440 )) -le "$DEPLOY_RETRY_MINUTES" ]; }

# Remote paths below keep a literal ~ on purpose: the remote shell expands it.
# shellcheck disable=SC2088
SSH_BASE=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30)
SSH_OPTS=("${SSH_BASE[@]}")   # per host: + -i <key> from hosts.conf
# remote <target> <command string>: runs on the host in a login-less bash.
remote() { ssh "${SSH_OPTS[@]}" "$1" "bash -lc $(printf '%q' "$2")"; }

# shellcheck disable=SC2088
deploy_host() { # <name> <target> <marker>
  local name=$1 target=$2 m=$3 DEB VERSION force=() check crc drc env title body rdeb rinst rprev
  DEB=$(sed -n 's/^DEB=//p' "$m"); VERSION=$(sed -n 's/^VERSION=//p' "$m")
  [ -f "$DEB" ] || { log "[$name] pending deb $DEB is gone; dropping the marker"; [ "$dry" = 1 ] || rm -f "$m"; return 0; }
  case "$DEPLOY_POLICY" in
    off) return 0 ;;
    confirm) [ -f "$OVH_STATE/approved" ] && [ "$(cat "$OVH_STATE/approved")" = "$(basename "$DEB")" ] || return 0 ;;
    night-idle) in_window || return 0 ;;
    always) force=(--force) ;;
    *) log "unknown DEPLOY_POLICY=$DEPLOY_POLICY; not deploying"; return 0 ;;
  esac

  if [ "$target" = local ]; then
    set +e; check=$("$here/deploy.sh" --check-only 2>>"$OVH_LOG_FILE"); crc=$?; set -e
  else
    # A host that is still being set up has the package but no service yet: skip it quietly.
    set +e; remote "$target" "systemctl cat $OVH_SERVICE.service >/dev/null 2>&1"; local svc=$?; set -e
    if [ "$svc" = 255 ]; then log "[$name] not reachable over ssh ($target); retry next slot"; return 0; fi
    if [ "$svc" != 0 ]; then log "[$name] not ready: $OVH_SERVICE.service missing; skipping"; return 0; fi
    set +e; remote "$target" 'test -x ~/overhedge-build/scripts/deploy.sh'; local hasdeploy=$?; set -e
    if [ "$hasdeploy" != 0 ]; then log "[$name] not ready: ~/overhedge-build/scripts/deploy.sh missing on the host; skipping"; return 0; fi
    set +e; check=$(remote "$target" '~/overhedge-build/scripts/deploy.sh --check-only 2>/dev/null'); crc=$?; set -e
    [ "$crc" = 255 ] && check="ssh to $target failed"
  fi
  log "[$name] check-only rc=$crc: $check"
  if [ "$crc" != 0 ] && { [ ${#force[@]} -eq 0 ] || [ "$crc" != 3 ]; }; then
    local tonight; tonight=$(TZ=$DEPLOY_TZ date +%F)
    if { [ "$DEPLOY_POLICY" != night-idle ] || last_slot; } && [ "$(cat "$OVH_STATE/deferred-$name" 2>/dev/null)" != "$tonight" ]; then
      [ "$dry" = 1 ] || echo "$tonight" > "$OVH_STATE/deferred-$name"
      body="Deploy of $VERSION to $name deferred: no safe moment ($check). Retrying at the next window."
      { echo "### $(ovh_now) [$name] deploy deferred"; echo; echo "$body"; } | ovh_update_log
      echo "$body" | ovh_notify "Orca update [$name]: deploy deferred"
    fi
    return 0
  fi

  if [ "$target" = local ]; then
    if [ "$dry" = 1 ]; then "$here/deploy.sh" --dry-run "${force[@]}" "$DEB"; return 0; fi
    set +e; "$here/deploy.sh" "${force[@]}" "$DEB" >>"$OVH_LOG_FILE" 2>&1; drc=$?; set -e
    env=$(cat "$OVH_STATE/last-deploy.env" 2>/dev/null || true)
  else
    rdeb="~/overhedge-build/artifacts/$(basename "$DEB")"
    rinst=$(remote "$target" "dpkg-query -W -f='\${Version}' orca-ide" 2>/dev/null || true)
    rprev=$OVH_ARTIFACTS/orca-ide_${rinst}_amd64.deb
    [ -f "$rprev" ] || rprev=$OVH_ARTIFACTS/old/orca-ide_${rinst}_amd64.deb
    if [ "$dry" = 1 ]; then
      log "[$name] DRY-RUN: scp $DEB${rinst:+ and $(basename "$rprev")} to $target:~/overhedge-build/artifacts/, update SHA256SUMS there"
      remote "$target" "~/overhedge-build/scripts/deploy.sh --dry-run ${force[*]} $rdeb" || true
      return 0
    fi
    set +e
    remote "$target" 'mkdir -p ~/overhedge-build/artifacts ~/overhedge-build/logs ~/overhedge-build/state' \
      && scp -q "${SSH_OPTS[@]}" "$DEB" "$target:overhedge-build/artifacts/" \
      && { [ ! -f "$rprev" ] || remote "$target" "test -f ~/overhedge-build/artifacts/$(basename "$rprev")" || scp -q "${SSH_OPTS[@]}" "$rprev" "$target:overhedge-build/artifacts/"; } \
      && remote "$target" 'cd ~/overhedge-build/artifacts && sha256sum ./*.deb | sed "s# \./# #" > SHA256SUMS'
    local copied=$?
    set -e
    if [ "$copied" != 0 ]; then
      log "[$name] copying the deb to $target failed; retry next slot"; return 0
    fi
    # Local and remote checksums must agree before installing.
    if [ "$(sha256sum "$DEB" | awk '{print $1}')" != "$(remote "$target" "sha256sum $rdeb" | awk '{print $1}')" ]; then
      log "[$name] checksum mismatch after copy; retry next slot"; return 0
    fi
    set +e
    remote "$target" "sudo -n systemd-run --quiet --wait --collect --unit overhedge-deploy-\$(date +%s) --uid \$(id -u) --gid \$(id -g) --setenv=HOME=\$HOME --setenv=PATH=/usr/local/bin:/usr/bin:/bin --working-directory=\$HOME \$HOME/overhedge-build/scripts/deploy.sh ${force[*]} \$HOME/overhedge-build/artifacts/$(basename "$DEB")" >>"$OVH_LOG_FILE" 2>&1
    drc=$?
    set -e
    env=$(remote "$target" 'cat ~/overhedge-build/state/last-deploy.env' 2>/dev/null || true)
    # systemd-run --wait returns the unit's exit status; 255 = ssh itself failed.
    if [ "$drc" = 255 ]; then log "[$name] ssh dropped during deploy; the deploy continues on the host as a transient unit; result on the next slot"; return 0; fi
  fi
  local RESULT REASON TERMINALS_CONNECTED TERMINALS_BEFORE ENDED_PROCS NOTES BACKUP PREV_DEB LOG
  RESULT=$(sed -n 's/^RESULT=//p' <<<"$env"); REASON=$(sed -n 's/^REASON=//p' <<<"$env")
  TERMINALS_CONNECTED=$(sed -n 's/^TERMINALS_CONNECTED=//p' <<<"$env"); TERMINALS_BEFORE=$(sed -n 's/^TERMINALS_BEFORE=//p' <<<"$env")
  ENDED_PROCS=$(sed -n 's/^ENDED_PROCS=//p' <<<"$env"); NOTES=$(sed -n 's/^NOTES=//p' <<<"$env")
  BACKUP=$(sed -n 's/^BACKUP=//p' <<<"$env"); PREV_DEB=$(sed -n 's/^PREV_DEB=//p' <<<"$env"); LOG=$(sed -n 's/^LOG=//p' <<<"$env")
  case "$drc" in
    0) title="deployed $VERSION (${RESULT:-ok})"; rm -f "$m" ;;
    3) log "[$name] chat became busy between check and deploy; retry next slot"; return 0 ;;
    4) title="deploy of $VERSION refused, needs a human: ${REASON:-not safe}"; rm -f "$m" ;;
    5) title="DEPLOY FAILED for $VERSION: unhealthy, rolled back to the previous build"; rm -f "$m"; touch "$OVH_STATE/failed-deploy-$name-$VERSION" ;;
    *) title="DEPLOY AND ROLLBACK FAILED for $VERSION (exit $drc): orca-serve needs a human now"; rm -f "$m" ;;
  esac
  body=$(cat <<EOF
### $(ovh_now) [$name] $title

- package: \`$(basename "$DEB")\`
- result: ${RESULT:-?}; terminals connected ${TERMINALS_CONNECTED:-?} of ${TERMINALS_BEFORE:-?}; agent processes that ended: ${ENDED_PROCS:-?}
- notes: ${NOTES:-none}
- on $name: backup \`${BACKUP:-?}\`, rollback deb \`$(basename "${PREV_DEB:-?}")\`, log \`${LOG:-?}\`
EOF
)
  printf '%s\n' "$body" | ovh_update_log
  printf '%s\n' "$body" | ovh_notify "Orca update [$name]: $title"
}

any=0
while read -r name target _transfer key _rest; do
  [ -n "$name" ] || continue
  [ -z "$only" ] || [ "$only" = "$name" ] || continue
  m=$PD/$name
  [ -f "$m" ] || continue
  any=1
  # A failure on one host must not stop the loop.
  SSH_OPTS=("${SSH_BASE[@]}")
  case "${key:-}" in key=?*) k=${key#key=}; SSH_OPTS+=(-i "${k/#\~/$HOME}" -o IdentitiesOnly=yes) ;; esac
  deploy_host "$name" "$target" "$m" || log "[$name] deploy_host returned $?"
done < <(ovh_hosts)
# Approval is per build, used up once no host still waits for that deb.
if [ "$any" = 1 ] && [ "$dry" = 0 ] && ! compgen -G "$PD/*" >/dev/null; then rm -f "$OVH_STATE/approved"; fi
exit 0
