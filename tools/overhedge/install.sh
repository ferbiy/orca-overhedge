#!/usr/bin/env bash
# install.sh [--with-units]   (run on orca-ide from a checkout of overhedge/ci)
#
# Copies tools/overhedge/* to ~/overhedge-build/scripts/, the runbook to
# ~/overhedge-build/UPDATE-RUNBOOK.md, creates update.conf / hosts.conf from the examples when they
# do not exist yet (never overwrites them), state/ and logs/ dirs, the fork clone's pre-push guard
# (when ~/overhedge-build/fork exists). With --with-units also installs the systemd units to
# /etc/systemd/system and reloads systemd (sudo); enabling the timers is a separate, explicit step:
#   sudo systemctl enable --now overhedge-update.timer overhedge-deploy.timer
# On a deploy-only host (e.g. team-server) run it without --with-units: only deploy.sh, lib.sh and
# the dirs are needed there.
set -euo pipefail
src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$src/../.." && pwd)
B=${OVH_HOME:-$HOME/overhedge-build}
mkdir -p "$B/scripts" "$B/state/pending" "$B/logs" "$B/artifacts"
chmod 700 "$B/state" "$B/logs"
for f in "$src"/*.sh "$src"/*.py "$src"/*.js "$src"/*.json "$src"/*.md "$src"/*.example; do
  install -m "$( [[ $f == *.sh ]] && echo 755 || echo 644)" "$f" "$B/scripts/"
done
[ -f "$repo/docs/overhedge/UPDATE-RUNBOOK.md" ] && install -m 644 "$repo/docs/overhedge/UPDATE-RUNBOOK.md" "$B/UPDATE-RUNBOOK.md"
[ -f "$B/update.conf" ] || install -m 644 "$src/update.conf.example" "$B/update.conf"
[ -f "$B/hosts.conf" ] || install -m 644 "$src/hosts.conf.example" "$B/hosts.conf"
if [ -d "$B/fork/.git" ]; then install -m 755 "$src/pre-push-guard.sh" "$B/fork/.git/hooks/pre-push"; fi
echo "installed scripts into $B/scripts (rev $(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo '?'))"
if [ "${1:-}" = --with-units ]; then
  sudo install -m 644 "$src"/systemd/overhedge-*.service "$src"/systemd/overhedge-*.timer /etc/systemd/system/
  sudo systemctl daemon-reload
  echo "units installed; enable with: sudo systemctl enable --now overhedge-update.timer overhedge-deploy.timer"
fi
