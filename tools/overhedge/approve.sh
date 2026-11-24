#!/usr/bin/env bash
# approve.sh [<deb>]   (DEPLOY_POLICY=confirm) approve the pending build for deployment.
# Without an argument approves the deb the pending markers name. The deploy timer then deploys it
# to every pending host at its next slot, as soon as no UI chat is busy on that host.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
deb=${1:-}
if [ -z "$deb" ]; then
  for m in "$OVH_STATE"/pending/*; do [ -f "$m" ] && deb=$(sed -n 's/^DEB=//p' "$m"); done
fi
[ -n "$deb" ] || { echo "nothing pending" >&2; exit 1; }
basename "$deb" > "$OVH_STATE/approved"
echo "approved $(basename "$deb"); pending hosts: $(ls "$OVH_STATE/pending" 2>/dev/null | tr '\n' ' ')"
