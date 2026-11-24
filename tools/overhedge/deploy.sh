#!/usr/bin/env bash
# deploy.sh [options] <deb>     install an orca-ide .deb on this host, with backup, health checks
#                               and automatic rollback to the currently installed build
# deploy.sh --check-only        preflight only: is it safe to restart orca-serve right now?
#
# Options:
#   --check-only          read-only preflight; exit 0 safe / 3 a UI chat is busy / 4 not safe
#   --dry-run             run the read-only preflight, then print every mutating command
#                         (stop, backup, apt-get, start, rollback) instead of running it
#   --force               deploy even when a UI chat is busy (that chat's turn is cut)
#   --health-timeout S    seconds to wait for the service to become healthy (default 240)
#   --stable S            seconds the service must then stay up without a restart (default 60)
#   --sample S            seconds over which chat CPU is sampled (default 10)
#
# Exit codes: 0 done (or safe) | 2 usage | 3 UI chat busy | 4 not safe / refused, nothing changed
#             5 new build unhealthy, rolled back, service healthy again
#             6 rollback failed too: service state needs a human NOW
#
# What counts as a busy UI chat: `orca-ide agent list` reports a chat in state working, blocked
# or waiting, OR a Claude chat process (`claude --output-format stream-json`, a descendant of the
# service) or its children used more than OVH_BUSY_TICKS CPU ticks during the sample.
# Terminals are not checked: their PTY daemon outlives the restart (KillMode=process).
#
# Never prints tokens or emails (output passes through a redactor); never reads
# ~/.config/orca/orca-runtime.json. Logs: ~/overhedge-build/logs/deploy-<ts>.log.
set -euo pipefail
umask 077
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
ovh_load_conf

ORCA_CLI=${OVH_ORCA_CLI:-orca-ide}
ORCA_CONFIG=${OVH_ORCA_CONFIG:-$HOME/.config/orca}
BUSY_TICKS=${OVH_BUSY_TICKS:-30}
MIN_DEPLOY_FREE_GB=${OVH_MIN_DEPLOY_FREE_GB:-10}

mode=deploy; dry=0; force=0; deb=""
health_timeout=240; stable=60; sample=10
while [ $# -gt 0 ]; do
  case "$1" in
    --check-only) mode=check ;;
    --dry-run) dry=1 ;;
    --force) force=1 ;;
    --health-timeout) health_timeout=$2; shift ;;
    --stable) stable=$2; shift ;;
    --sample) sample=$2; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) [ -z "$deb" ] || { echo "only one deb" >&2; exit 2; }; deb=$1 ;;
  esac
  shift
done
if [ "$mode" = deploy ] && [ -z "$deb" ]; then echo "usage: deploy.sh [--dry-run] [--force] <deb> | --check-only" >&2; exit 2; fi
[ -z "$deb" ] || deb=$(readlink -f "$deb")

mkdir -p "$OVH_LOGS" "$OVH_STATE"
TS=$(ovh_ts)
if [ "$mode" = check ]; then OVH_LOG_FILE=$OVH_LOGS/check-$TS.log; else OVH_LOG_FILE=$OVH_LOGS/deploy-$TS.log; fi
[ "$dry" = 1 ] && OVH_LOG_FILE=$OVH_LOGS/deploy-dryrun-$TS.log
export OVH_LOG_FILE

# run <cmd...>: mutating command. Printed in --dry-run, executed (and logged) otherwise.
run() {
  if [ "$dry" = 1 ]; then log "DRY-RUN: $*"; return 0; fi
  log "+ $*"
  "$@"
}
# Like run, but the command's own output goes to the log file only (apt-get is verbose).
run_quiet() {
  if [ "$dry" = 1 ]; then log "DRY-RUN: $*"; return 0; fi
  log "+ $*"
  "$@" >> "$OVH_LOG_FILE" 2>&1
}
# Shell pipelines are passed as one string.
run_sh() {
  if [ "$dry" = 1 ]; then log "DRY-RUN: $1"; return 0; fi
  log "+ $1"
  bash -c "$1"
}

svc_prop() { systemctl show -p "$1" --value "$OVH_SERVICE" 2>/dev/null || true; }
http_code() { local c; c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$OVH_PORT/" 2>/dev/null || true); echo "${c:-000}"; }
runtime_state() { timeout 30 "$ORCA_CLI" status --json 2>/dev/null | jq -r '.result.runtime.state // "unknown"' 2>/dev/null || echo unknown; }

descendants() {
  local p=$1 c
  echo "$p"
  for c in $(pgrep -P "$p" 2>/dev/null || true); do descendants "$c"; done
}
ancestors() {
  local p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    echo "$p"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' || true)
  done
}
cpu_ticks() {
  local t=0 p st
  for p in "$@"; do
    if read -r -a st < "/proc/$p/stat" 2>/dev/null; then t=$((t + st[13] + st[14])); fi
  done
  echo "$t"
}
# Claude UI-chat processes: comm "claude" with --output-format stream-json, under the service.
chat_pids() {
  local root=${OVH_CHAT_ROOT_PID:-$(svc_prop MainPID)} p
  [ -n "$root" ] && [ "$root" != 0 ] || return 0
  for p in $(descendants "$root"); do
    [ "$(cat "/proc/$p/comm" 2>/dev/null)" = claude ] || continue
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--output-format stream-json' && echo "$p"
  done
  return 0
}

busy_reasons=()
check_chats() {
  busy_reasons=()
  local list n
  if ! list=$(timeout 30 "$ORCA_CLI" agent list --json 2>/dev/null) || ! jq -e '.ok == true' >/dev/null 2>&1 <<<"$list"; then
    return 2
  fi
  n=$(jq '[.result.agents[] | select(.kind=="chat") | select(.state=="working" or .state=="blocked" or .state=="waiting")] | length' <<<"$list")
  if [ "$n" -gt 0 ]; then
    busy_reasons+=("agent list: $n chat(s) $(jq -r '[.result.agents[] | select(.kind=="chat") | select(.state=="working" or .state=="blocked" or .state=="waiting") | "\(.agent):\(.state):\(.orcaSessionId // "?")"] | join(", ")' <<<"$list")")
  fi
  local pids p a b all
  mapfile -t pids < <(chat_pids)
  if [ "${#pids[@]}" -gt 0 ]; then
    declare -A before=()
    for p in "${pids[@]}"; do mapfile -t all < <(descendants "$p"); before[$p]=$(cpu_ticks "${all[@]}"); done
    sleep "$sample"
    for p in "${pids[@]}"; do
      [ -d "/proc/$p" ] || continue
      mapfile -t all < <(descendants "$p"); a=${before[$p]}; b=$(cpu_ticks "${all[@]}")
      if [ $((b - a)) -ge "$BUSY_TICKS" ]; then busy_reasons+=("claude chat pid $p used $((b - a)) CPU ticks in ${sample}s"); fi
    done
  fi
  log "chat processes sampled: ${#pids[@]}; busy signals: ${#busy_reasons[@]}"
  [ "${#busy_reasons[@]}" -eq 0 ]
}

not_safe=()
preflight() {
  not_safe=()
  local st code rs free
  st=$(systemctl is-active "$OVH_SERVICE" 2>/dev/null || true)
  [ "$st" = active ] || not_safe+=("$OVH_SERVICE is '$st', not active")
  code=$(http_code); [ "$code" = 200 ] || not_safe+=("HTTP $code on 127.0.0.1:$OVH_PORT")
  rs=$(runtime_state); [ "$rs" = ready ] || not_safe+=("runtime state '$rs'")
  sudo -n true 2>/dev/null || not_safe+=("sudo -n does not work")
  command -v pigz >/dev/null || not_safe+=("pigz missing")
  # The host's dpkg lock is held (apt, dpkg, an unattended-upgrade run). Checked on the lock files,
  # not by process name: apt-get inside Docker containers is visible to pgrep but irrelevant, and
  # the idle unattended-upgrade-shutdown helper never holds the lock.
  if command -v fuser >/dev/null && sudo -n true 2>/dev/null; then
    if sudo -n fuser -s /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock 2>/dev/null; then not_safe+=("the dpkg lock is held (apt/dpkg running)"); fi
  else
    not_safe+=("cannot check the dpkg lock (needs fuser and sudo -n)")
  fi
  free=$(ovh_free_gb "$HOME"); [ "$free" -ge "$MIN_DEPLOY_FREE_GB" ] || not_safe+=("only ${free}G free in \$HOME")
  # A deploy launched from inside a UI chat would kill its own caller on stop.
  local p
  for p in $(ancestors); do
    if [ "$(cat "/proc/$p/comm" 2>/dev/null)" = claude ] && tr '\0' ' ' < "/proc/$p/cmdline" | grep -q -- '--output-format stream-json' \
       && chat_pids | grep -qx "$p"; then
      [ "$mode" = deploy ] && [ "$dry" = 0 ] && not_safe+=("running inside an Orca UI chat (pid $p): stopping the service would kill this deploy; use overhedge-deploy.service or a terminal")
    fi
  done
  log "service=$st http=$code runtime=$rs free=${free}G installed=$(ovh_installed_version)"
}

sha_ok() {
  local f=$1 dir sum want=""
  dir=$(dirname "$f")
  sum=$(sha256sum "$f" | awk '{print $1}')
  [ -f "$f.sha256" ] && want=$(awk '{print $1}' "$f.sha256")
  [ -z "$want" ] && [ -f "$dir/SHA256SUMS" ] && want=$(awk -v n="$(basename "$f")" '$2==n || $2=="*"n {print $1}' "$dir/SHA256SUMS")
  [ -n "$want" ] && [ "$want" = "$sum" ]
}

find_rollback_deb() {
  local v=$1 d
  for d in "$OVH_ARTIFACTS" "$OVH_ARTIFACTS/old" "$OVH_ARTIFACTS/rollback"; do
    [ -f "$d/orca-ide_${v}_amd64.deb" ] && { echo "$d/orca-ide_${v}_amd64.deb"; return 0; }
  done
  return 1
}

wait_inactive() {
  :
  for _ in $(seq 1 60); do
    [ "$(systemctl is-active "$OVH_SERVICE" 2>/dev/null || true)" != active ] && [ "$(systemctl is-active "$OVH_SERVICE" 2>/dev/null || true)" != deactivating ] && return 0
    sleep 1
  done
  return 1
}

# healthy: active + HTTP 200 + runtime ready within health_timeout, then no restart for $stable s.
healthy() {
  local deadline pid0 nr0 st code rs
  deadline=$(( $(date +%s) + health_timeout ))
  while :; do
    st=$(systemctl is-active "$OVH_SERVICE" 2>/dev/null || true)
    code=$(http_code)
    if [ "$st" = active ] && [ "$code" = 200 ]; then
      rs=$(runtime_state)
      [ "$rs" = ready ] && break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then log "health: timeout (service=$st http=$code runtime=${rs:-?})"; return 1; fi
    sleep 5
  done
  pid0=$(svc_prop MainPID); nr0=$(svc_prop NRestarts)
  log "health: up (pid $pid0, NRestarts $nr0); watching ${stable}s for restarts"
  sleep "$stable"
  if [ "$(systemctl is-active "$OVH_SERVICE" 2>/dev/null || true)" != active ] || [ "$(svc_prop MainPID)" != "$pid0" ] || [ "$(svc_prop NRestarts)" != "$nr0" ]; then
    log "health: service restarted or stopped during the stability window"
    return 1
  fi
  [ "$(http_code)" = 200 ] || { log "health: HTTP no longer 200"; return 1; }
  return 0
}

terminals_json() { timeout 30 "$ORCA_CLI" terminal list --json 2>/dev/null | jq -c '[.result.terminals[] | {handle, connected, orphaned}]' 2>/dev/null || echo '[]'; }
agent_procs() {
  local root p
  root=$(svc_prop MainPID)
  { [ -n "$root" ] && [ "$root" != 0 ] && descendants "$root"; pgrep -f 'daemon-v[0-9]+' || true; } 2>/dev/null | sort -un | while read -r p; do
    ps -o pid=,etime=,comm= -p "$p" 2>/dev/null || true
  done
}
sessions_links() {
  local l
  for l in "$ORCA_CONFIG"/claude-profiles/*/home/sessions; do
    [ -e "$l" ] || [ -L "$l" ] || continue
    echo "$(basename "$(dirname "$(dirname "$l")")") -> $(readlink "$l" || echo '<dir>')"
  done
}

write_state() { # key=value lines on stdin
  local f=$OVH_STATE/last-deploy.env
  if [ "$dry" = 1 ] || [ "$mode" = check ]; then return 0; fi
  { echo "TS=$TS"; echo "LOG=$OVH_LOG_FILE"; cat; } > "$f"
}

# ---------------------------------------------------------------- preflight
log "deploy.sh mode=$mode dry=$dry force=$force deb=${deb:-<none>}"
exec 9> "$OVH_STATE/deploy.run.lock"
flock -n 9 || { log "NOT SAFE: another deploy.sh is running"; exit 4; }

preflight
installed=$(ovh_installed_version)
prev_deb=""
if [ -n "$deb" ]; then
  if [ ! -f "$deb" ]; then not_safe+=("deb not found: $deb")
  else
    [ "$(dpkg-deb -f "$deb" Package 2>/dev/null)" = "$OVH_PKG" ] || not_safe+=("deb is not package $OVH_PKG")
    [ "$(dpkg-deb -f "$deb" Architecture 2>/dev/null)" = amd64 ] || not_safe+=("deb is not amd64")
    sha_ok "$deb" || not_safe+=("deb sha256 missing from SHA256SUMS/.sha256 or does not match")
    newv=$(dpkg-deb -f "$deb" Version 2>/dev/null || true)
    if [ "$newv" = "$installed" ]; then log "already installed: $installed"; [ "$mode" = deploy ] && exit 0; fi
  fi
  if [ -n "$installed" ]; then
    if prev_deb=$(find_rollback_deb "$installed"); then
      sha_ok "$prev_deb" || not_safe+=("rollback deb $prev_deb fails its checksum")
    elif [ "$mode" = deploy ]; then
      prev_deb=$OVH_ARTIFACTS/rollback/orca-ide_${installed}_amd64.deb
      log "rollback deb for $installed not in artifacts; will save it to $prev_deb first"
    fi
  fi
fi

busy=0; chats_unknown=0
if check_chats; then :; else rc=$?; if [ "$rc" = 2 ]; then chats_unknown=1; not_safe+=("cannot list chats (agent list failed)"); else busy=1; fi; fi

if [ "${#not_safe[@]}" -gt 0 ]; then
  for r in "${not_safe[@]}"; do log "NOT SAFE: $r"; done
  echo "NOT SAFE: ${not_safe[*]}" | ovh_redact
  [ "$mode" = deploy ] && [ "$dry" = 0 ] && printf 'RESULT=refused\nREASON=%s\nDEB=%s\n' "${not_safe[*]}" "$deb" | write_state
  exit 4
fi
if [ "$busy" = 1 ]; then
  for r in "${busy_reasons[@]}"; do log "BUSY: $r"; done
  if [ "$mode" = check ] || [ "$force" = 0 ]; then
    echo "BUSY: ${busy_reasons[*]}" | ovh_redact
    [ "$mode" = deploy ] && [ "$dry" = 0 ] && printf 'RESULT=refused-busy\nDEB=%s\n' "$deb" | write_state
    exit 3
  fi
  log "--force: deploying although a UI chat is busy (its turn will be cut)"
fi
if [ "$mode" = check ]; then
  [ "$chats_unknown" = 0 ] && echo "SAFE: service healthy, no UI chat busy"
  exit 0
fi

# ---------------------------------------------------------------- save rollback deb if needed
if [ ! -f "$prev_deb" ] && [ -n "$installed" ]; then
  run mkdir -p "$OVH_ARTIFACTS/rollback"
  case "$installed" in
    *+*)
      if command -v dpkg-repack >/dev/null; then
        run_sh "cd '$OVH_ARTIFACTS/rollback' && fakeroot -u dpkg-repack $OVH_PKG && sha256sum orca-ide_*.deb > SHA256SUMS"
      else
        log "NOT SAFE: installed $installed is not in artifacts and dpkg-repack is not available"; exit 4
      fi ;;
    *)
      run gh release download "v$installed" -R "$OVH_UPSTREAM_REPO" -p "orca-ide_${installed}_amd64.deb" -D "$OVH_ARTIFACTS/rollback" --clobber
      run_sh "cd '$OVH_ARTIFACTS/rollback' && sha256sum orca-ide_*.deb > SHA256SUMS" ;;
  esac
  if [ "$dry" = 0 ] && { [ ! -f "$prev_deb" ] || [ "$(dpkg-deb -f "$prev_deb" Version)" != "$installed" ]; }; then
    log "NOT SAFE: could not save a rollback deb for $installed"; exit 4
  fi
fi

# ---------------------------------------------------------------- snapshot
BK=$OVH_HOME/backup-$TS
run mkdir -p "$BK"
run chmod 700 "$BK"
if [ "$dry" = 0 ]; then
  echo "$installed" > "$BK/before-version.txt"
  systemctl show "$OVH_SERVICE" -p MainPID -p NRestarts -p ActiveEnterTimestamp > "$BK/before-status.txt" || true
  terminals_json > "$BK/before-terminals.json"
  agent_procs > "$BK/before-agents.txt"
  sessions_links > "$BK/before-sessions-links.txt"
  echo "$BK" > "$OVH_HOME/last-backup-path"
else
  log "DRY-RUN: would snapshot version/status/terminals/agent processes/sessions links into $BK"
  log "snapshot preview: terminals=$(terminals_json | jq length) agent-procs=$(agent_procs | wc -l) sessions-links=$(sessions_links | wc -l)"
fi
before_terms=$( [ "$dry" = 0 ] && jq length "$BK/before-terminals.json" || terminals_json | jq length )
log "before: version=$installed terminals=$before_terms"

# ---------------------------------------------------------------- stop, backup, install
start_epoch=$(date +%s)
run sudo -n systemctl stop "$OVH_SERVICE"
if [ "$dry" = 0 ] && ! wait_inactive; then log "service did not stop within 60s"; fi

backup_ok=1
run_sh "tar -C '$(dirname "$ORCA_CONFIG")' -I pigz -cf '$BK/orca-config.tgz' --exclude=orca/orcad-artifacts --exclude='orca/Cache' --exclude='orca/Code Cache' --exclude=orca/codex-runtime-home/home/sessions --exclude='*.sock' '$(basename "$ORCA_CONFIG")'" || backup_ok=0
run pigz -t "$BK/orca-config.tgz" || backup_ok=0
if [ -d "$HOME/.orca" ]; then run_sh "tar -C '$HOME' -I pigz -cf '$BK/dot-orca.tgz' .orca && pigz -t '$BK/dot-orca.tgz'" || backup_ok=0; fi
run chmod -R go-rwx "$BK"
if [ "$backup_ok" = 0 ]; then
  log "backup failed: starting the unchanged build again"
  run sudo -n systemctl start "$OVH_SERVICE"
  healthy || true
  printf 'RESULT=refused\nREASON=backup failed\nDEB=%s\nBACKUP=%s\n' "$deb" "$BK" | write_state
  exit 4
fi

rollback() {
  log "ROLLBACK to $installed ($prev_deb)"
  run sudo -n systemctl stop "$OVH_SERVICE" || true
  [ "$dry" = 1 ] || wait_inactive || true
  if run_quiet sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$prev_deb" \
     && run sudo -n systemctl start "$OVH_SERVICE" && { [ "$dry" = 1 ] || healthy; }; then
    log "rollback OK: $(ovh_installed_version) healthy"
    printf 'RESULT=rolled-back\nDEB=%s\nPREV_DEB=%s\nBACKUP=%s\n' "$deb" "$prev_deb" "$BK" | write_state
    exit 5
  fi
  log "ROLLBACK FAILED: service state needs a human. Backup: $BK"
  printf 'RESULT=rollback-failed\nDEB=%s\nPREV_DEB=%s\nBACKUP=%s\n' "$deb" "$prev_deb" "$BK" | write_state
  exit 6
}

if ! run_quiet sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y "$deb"; then
  log "apt-get install failed"; rollback
fi
newv=$(dpkg-deb -f "$deb" Version)
if [ "$dry" = 0 ] && [ "$(ovh_installed_version)" != "$newv" ]; then log "installed version is $(ovh_installed_version), expected $newv"; rollback; fi
run sudo -n systemctl start "$OVH_SERVICE"

# ---------------------------------------------------------------- verify
if [ "$dry" = 1 ]; then
  log "DRY-RUN: would wait up to ${health_timeout}s for active + HTTP 200 + runtime ready, then ${stable}s without restart; on failure roll back to ${prev_deb:-<none>}"
  log "DRY-RUN: would then compare terminals (before=$before_terms, all connected), agent processes, journal errors"
  exit 0
fi
if ! healthy; then rollback; fi

after_terms=$(terminals_json)
n_after=$(jq length <<<"$after_terms"); n_conn=$(jq '[.[] | select(.connected == true)] | length' <<<"$after_terms")
for _ in $(seq 1 12); do
  [ "$n_conn" -ge "$before_terms" ] && break
  sleep 5; after_terms=$(terminals_json)
  n_after=$(jq length <<<"$after_terms"); n_conn=$(jq '[.[] | select(.connected == true)] | length' <<<"$after_terms")
done
agent_procs > "$BK/after-agents.txt"
gone=$(awk '{print $1" "$3}' "$BK/before-agents.txt" | while read -r p c; do [ -d "/proc/$p" ] || echo "$p($c)"; done | tr '\n' ' ')
errs=$(journalctl -u "$OVH_SERVICE" --since "@$start_epoch" -p err --no-pager -q 2>/dev/null | wc -l || echo '?')
journalctl -u "$OVH_SERVICE" --since "@$start_epoch" -p err --no-pager -q 2>/dev/null | cut -c1-240 | ovh_redact | tail -20 > "$BK/after-journal-errors.txt" || true
result=ok; notes=()
if [ "$n_conn" -lt "$before_terms" ]; then result=degraded; notes+=("terminals connected $n_conn of $before_terms before"); fi
[ "$errs" = 0 ] || notes+=("$errs journal error line(s) since start (see $BK/after-journal-errors.txt)")
log "after: version=$(ovh_installed_version) terminals=$n_after connected=$n_conn (before $before_terms) NRestarts=$(svc_prop NRestarts)"
log "agent processes ended across the restart: ${gone:-none}"
log "RESULT=$result ${notes[*]:-}"
printf 'RESULT=%s\nDEB=%s\nVERSION=%s\nPREV_DEB=%s\nBACKUP=%s\nTERMINALS_BEFORE=%s\nTERMINALS_CONNECTED=%s\nENDED_PROCS=%s\nNOTES=%s\n' \
  "$result" "$deb" "$newv" "$prev_deb" "$BK" "$before_terms" "$n_conn" "${gone:-none}" "${notes[*]:-}" | write_state
exit 0
