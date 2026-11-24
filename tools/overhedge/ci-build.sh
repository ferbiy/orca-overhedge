#!/usr/bin/env bash
# ci-build.sh <full-40-char-sha> [--no-mac] [--mac-arch arm64|x64] [--no-wait]
#
# Dispatches the fork's CI from overhedge/ci for one commit: "Overhedge server deb"
# (overhedge-server-deb.yml) and "Overhedge mac app" (overhedge-mac-app.yml), finds the run ids,
# waits for both, and prints KEY=value lines:
#   DEB_RUN DEB_RESULT DEB_ARTIFACT MAC_RUN MAC_RESULT MAC_ARTIFACT
# Also writes them to ~/overhedge-build/state/ci-<sha10>.env.
# Exit 0 when the deb run succeeded (the mac run's result is reported, not gating), 1 otherwise.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
sha=${1:-}; shift || true
mac=1; arch=arm64; wait=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-mac) mac=0 ;;
    --mac-arch) arch=$2; shift ;;
    --no-wait) wait=0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: ci-build.sh <full 40-char sha> [--no-mac] [--mac-arch arm64|x64] [--no-wait]" >&2; exit 2; }
R=$OVH_FORK_REPO
mkdir -p "$OVH_STATE"

dispatch() { # <workflow> <extra -f args...> ; prints run id
  local wf=$1 since id
  shift
  since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run "$wf" -R "$R" --ref overhedge/ci -f ref="$sha" "$@" >&2
  for _ in $(seq 1 30); do
    sleep 5
    id=$(gh run list -R "$R" --workflow "$wf" --event workflow_dispatch -L 10 --json databaseId,createdAt \
      --jq "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | first | .databaseId // empty")
    [ -n "$id" ] && { echo "$id"; return 0; }
  done
  echo "could not find the dispatched $wf run" >&2; return 1
}
# The product artifact only (the runs also upload orcad-* build intermediates).
artifact_of() { gh api "repos/$R/actions/runs/$1/artifacts" --jq '[.artifacts[].name | select(startswith("orca-ide_") or startswith("Orca-"))] | join(",")'; }

deb_run=$(dispatch overhedge-server-deb.yml)
log "deb run $deb_run: https://github.com/$R/actions/runs/$deb_run"
mac_run=""
if [ "$mac" = 1 ]; then
  mac_run=$(dispatch overhedge-mac-app.yml -f arch="$arch")
  log "mac run $mac_run: https://github.com/$R/actions/runs/$mac_run"
fi
[ "$wait" = 1 ] || { printf 'DEB_RUN=%s\nMAC_RUN=%s\n' "$deb_run" "$mac_run"; exit 0; }

result() { gh run view "$1" -R "$R" --json conclusion --jq .conclusion; }
gh run watch "$deb_run" -R "$R" --interval 60 --exit-status > /dev/null 2>&1 || true
deb_result=$(result "$deb_run"); deb_art=$(artifact_of "$deb_run")
mac_result=""; mac_art=""
if [ -n "$mac_run" ]; then
  gh run watch "$mac_run" -R "$R" --interval 60 --exit-status > /dev/null 2>&1 || true
  mac_result=$(result "$mac_run"); mac_art=$(artifact_of "$mac_run")
fi
out=$(printf 'SHA=%s\nDEB_RUN=%s\nDEB_RESULT=%s\nDEB_ARTIFACT=%s\nMAC_RUN=%s\nMAC_RESULT=%s\nMAC_ARTIFACT=%s\n' \
  "$sha" "$deb_run" "$deb_result" "$deb_art" "$mac_run" "$mac_result" "$mac_art")
echo "$out" | tee "$OVH_STATE/ci-${sha:0:10}.env"
[ "$deb_result" = success ]
