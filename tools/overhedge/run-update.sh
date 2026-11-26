#!/usr/bin/env bash
# run-update.sh [--rehearsal <vX.Y.Z>] [--no-deploy] [--print-prompt] [--retry]
#
# Entry point of the scheduled update (overhedge-update.service, every 5 days). Deterministic
# around one headless Claude run:
#  1. lock, disk check, latest-upstream.sh
#  2. nothing to do (up to date / deploy already pending / official deb not published yet /
#     an earlier run stopped for a human) -> one summary entry, notify, exit; Claude is not started
#  3. otherwise starts `claude -p` (model from update.conf, settings claude-settings.json,
#     permission mode dontAsk) with automation-prompt.md; the runbook is its source of truth
#  4. reads the agent's result file state/result-<id>.env; for RESULT=ready validates the deb
#     (checksum, package, version above the installed one) and writes state/pending/<host>
#     for every host in hosts.conf; overhedge-deploy.timer acts on them per DEPLOY_POLICY
#  5. appends the agent's report and the outcome to update-log.md and notifies
# --rehearsal vX.Y.Z  full pipeline for that release on overhedge/rehearsal-* branches, never deploys
# --no-deploy         run normally but never write the pending markers
# --print-prompt      print the prompt that would be sent and exit
# --retry             ignore an earlier stop marker for this release (after a human looked)
set -euo pipefail
umask 077
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
ovh_load_conf

rehearsal=""; nodeploy=0; print=0; retry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --rehearsal) rehearsal=$2; shift ;;
    --no-deploy) nodeploy=1 ;;
    --print-prompt) print=1 ;;
    --retry) retry=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$rehearsal" ] || nodeploy=1

mkdir -p "$OVH_LOGS" "$OVH_STATE"
RUN_TS=$(ovh_ts)
export OVH_LOG_FILE=$OVH_LOGS/run-$RUN_TS.log
exec 7> "$OVH_STATE/run.lock"
flock -n 7 || { log "another run-update.sh is running"; exit 0; }

summary() { # <title> ; body on stdin
  local title=$1 body
  body=$(cat)
  { echo "## $(ovh_now) $title"; echo; printf '%s\n' "$body"; } | ovh_update_log
  printf '%s\n' "$body" | ovh_notify "Orca update: $title"
  log "summary: $title"
}

free=$(ovh_free_gb)
if [ "$free" -lt "$MIN_FREE_GB" ]; then
  summary "STOPPED: low disk" <<EOF
Only ${free}G free under $OVH_HOME (minimum $MIN_FREE_GB G). Nothing was started. Free space (e.g. \`$OVH_SCRIPTS/cleanup.sh --dry-run\`, legacy clones under $OVH_HOME) and the next run retries.
EOF
  exit 0
fi

set +e
if [ -n "$rehearsal" ]; then info=$("$here/latest-upstream.sh" --tag "$rehearsal"); else info=$("$here/latest-upstream.sh"); fi
lrc=$?
set -e
[ "$lrc" != 1 ] && [ "$lrc" != 2 ] || { summary "FAILED: cannot read upstream releases" <<<"latest-upstream.sh exited $lrc; see $OVH_LOG_FILE"; exit 1; }
printf '%s\n' "$info" >> "$OVH_LOG_FILE"
get() { sed -n "s/^$1=//p" <<<"$info"; }
TAG=$(get LATEST_TAG); VER=$(get LATEST_VERSION); RID=$(get RELEASE_ID); STATUS=$(get STATUS)
[ "$retry" = 1 ] && [ "$STATUS" = failed-before ] && { rm -f "$OVH_STATE/stopped-$RID"; STATUS=$([ "$(get PATCH_BRANCH_EXISTS)" = yes ] && echo needs-build || echo needs-port); }

if [ -z "$rehearsal" ]; then
  case "$STATUS" in
    up-to-date) summary "nothing to do ($TAG)" <<<"Newest upstream release is $TAG; this host already runs $(get INSTALLED_VERSION)."; exit 0 ;;
    deploy-pending) summary "nothing new; deploy of $TAG still pending" <<<"A verified build ($(basename "$(get PENDING_DEPLOY)")) waits for the deploy window (policy $DEPLOY_POLICY)."; exit 0 ;;
    wait-for-asset) summary "waiting: $TAG has no official .deb yet" <<<"Upstream published $TAG at $(get PUBLISHED_AT) without orca-ide_${VER}_amd64.deb; the next run retries."; exit 0 ;;
    failed-before) summary "STOPPED earlier for $TAG, waiting for a human" <<<"$(cat "$OVH_STATE/stopped-$RID" 2>/dev/null) — after looking, run \`$OVH_SCRIPTS/run-update.sh --retry\` or delete $OVH_STATE/stopped-$RID."; exit 0 ;;
  esac
fi

PREFIX=overhedge; [ -n "$rehearsal" ] && PREFIX=overhedge/rehearsal
RESULT_FILE=$OVH_STATE/result-$RID${rehearsal:+-rehearsal}.env
REPORT_FILE=$OVH_LOGS/report-$RID-$RUN_TS.md
rm -f "$RESULT_FILE"
prompt=$(sed -e "s|@RUN_TS@|$RUN_TS|g" -e "s|@TAG@|$TAG|g" -e "s|@VERSION@|$VER|g" -e "s|@RID@|$RID|g" \
  -e "s|@STATUS@|$STATUS|g" -e "s|@PREFIX@|$PREFIX|g" -e "s|@REHEARSAL@|${rehearsal:+yes}|g" \
  -e "s|@NODEPLOY@|$nodeploy|g" -e "s|@POLICY@|$DEPLOY_POLICY|g" -e "s|@RESULT_FILE@|$RESULT_FILE|g" \
  -e "s|@REPORT_FILE@|$REPORT_FILE|g" -e "s|@HOME_DIR@|$OVH_HOME|g" "$here/automation-prompt.md")
prompt+=$'\n\nlatest-upstream.sh output for this run:\n'"$info"
if [ "$print" = 1 ]; then printf '%s\n' "$prompt"; exit 0; fi

log "starting claude for $TAG (status $STATUS, prefix $PREFIX, policy $DEPLOY_POLICY, no-deploy $nodeploy)"
J=$OVH_LOGS/claude-$RUN_TS.jsonl
set +e
( cd "$OVH_HOME" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
    CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR_FOR_UPDATES" OVH_HOME="$OVH_HOME" \
    timeout --kill-after=5m "${CLAUDE_MAX_HOURS}h" claude -p "$prompt" \
      --model "$CLAUDE_MODEL" --settings "$here/claude-settings.json" --setting-sources project \
      --permission-mode dontAsk --strict-mcp-config --add-dir "$OVH_HOME" \
      --output-format stream-json --verbose ) > "$J" 2> "$OVH_LOGS/claude-$RUN_TS.err" < /dev/null
crc=$?
set -e
log "claude exited $crc"
denied=$(jq -r 'select(.type=="result") | .permission_denials // [] | length' "$J" 2>/dev/null | tail -1)

RESULT=""; REASON=""; DEB=""; APPIMAGE=""; MAC_ZIP=""; PATCH_BRANCH=""; PATCH_SHA=""
# shellcheck disable=SC1090
[ -f "$RESULT_FILE" ] && . "$RESULT_FILE"
report=$( [ -f "$REPORT_FILE" ] && cat "$REPORT_FILE" || echo "(the agent wrote no report; transcript: $J)")
[ -z "$APPIMAGE" ] || report+=$'\n\n'"Linux desktop AppImage (not installed anywhere): \`$APPIMAGE\` on orca-ide; the deb above is the Linux desktop app too."
[ -z "$MAC_ZIP" ] || report+=$'\n\n'"Mac app (not installed automatically): \`$MAC_ZIP\` on orca-ide."
tail_note="Transcript: \`$J\` (claude exit $crc, permission denials ${denied:-?}). Run log: \`$OVH_LOG_FILE\`."

case "$RESULT" in
  ready)
    why=""
    if [ ! -f "$DEB" ]; then why="deb $DEB missing"
    elif [ "$(dpkg-deb -f "$DEB" Package)" != orca-ide ]; then why="not an orca-ide package"
    elif ! (cd "$(dirname "$DEB")" && grep -F " $(basename "$DEB")" SHA256SUMS | sha256sum -c --status); then why="checksum does not match SHA256SUMS"
    else
      dv=$(dpkg-deb -f "$DEB" Version)
      case "$dv" in "$VER"+overhedge.*) ;; *) why="version $dv is not $VER+overhedge.*" ;; esac
      inst=$(ovh_installed_version)
      [ -z "$why" ] && [ -n "$inst" ] && ! dpkg --compare-versions "$dv" gt "$inst" && why="$dv does not sort above installed $inst"
    fi
    if [ -n "$why" ]; then
      summary "FAILED validation for $TAG: $why" <<<"$report"$'\n\n'"$tail_note"
      exit 1
    fi
    if [ -n "$rehearsal" ]; then
      # Rehearsal builds never stay around: they would take a keep slot and sort above real builds.
      rm -f "$DEB" "$DEB.sha256"
      (cd "$OVH_ARTIFACTS" && if ls ./*.deb >/dev/null 2>&1; then sha256sum ./*.deb | sed 's# \./# #' > SHA256SUMS; fi)
      [ -z "$MAC_ZIP" ] || rm -f "$MAC_ZIP" "$MAC_ZIP.sha256"
      if [ -n "$APPIMAGE" ]; then
        rm -f "$APPIMAGE" "$APPIMAGE.sha256"
        (cd "$OVH_ARTIFACTS/linux" && if ls ./*.AppImage >/dev/null 2>&1; then sha256sum ./*.AppImage | sed 's# \./# #' > SHA256SUMS; else rm -f SHA256SUMS; fi)
      fi
      for d in "$OVH_HOME/rehearsal-base-$RID" "$OVH_HOME/rehearsal-patch-$RID"; do
        if [ -d "$d" ] && [ ! -e "$d/.git" ]; then rm -rf "$d"; fi
      done
      git -C "$OVH_HOME/fork" worktree prune 2>/dev/null || true
      tail_note+=" Rehearsal deb $(basename "$DEB") deleted after verification."
      summary "REHEARSAL build of $TAG verified, not deployed" <<<"$report"$'\n\n'"$tail_note"
    elif [ "$nodeploy" = 1 ]; then
      summary "build of $TAG verified, not deployed (no-deploy run)" <<<"$report"$'\n\n'"$tail_note"
    else
      mkdir -p "$OVH_STATE/pending"
      hosts=""
      while read -r hname _rest; do
        [ -n "$hname" ] || continue
        printf 'DEB=%s\nVERSION=%s\nCREATED=%s\nPATCH_BRANCH=%s\nPATCH_SHA=%s\n' "$DEB" "$dv" "$RUN_TS" "$PATCH_BRANCH" "$PATCH_SHA" > "$OVH_STATE/pending/$hname"
        hosts+="$hname "
      done < <(ovh_hosts)
      case "$DEPLOY_POLICY" in
        confirm) when="after approval: \`$OVH_SCRIPTS/approve.sh\`" ;;
        night-idle) when="automatically between $DEPLOY_WINDOW_START and $DEPLOY_WINDOW_END ($DEPLOY_TZ) once no UI chat is busy" ;;
        always) when="at the next 15-minute slot, even if a UI chat is busy" ;;
        *) when="never automatically (policy $DEPLOY_POLICY)" ;;
      esac
      summary "build of $TAG verified; deploy to ${hosts% } $when" <<<"$report"$'\n\n'"$tail_note"
    fi
    ;;
  stopped)
    [ -n "$rehearsal" ] || printf '%s: %s\n' "$RUN_TS" "${REASON:-see report}" > "$OVH_STATE/stopped-$RID"
    summary "STOPPED for $TAG, needs a human: ${REASON:-see report}" <<<"$report"$'\n\n'"$tail_note"
    ;;
  *)
    summary "FAILED for $TAG (${RESULT:-no result file}${REASON:+: $REASON})" <<<"$report"$'\n\n'"$tail_note"
    exit 1
    ;;
esac
