#!/usr/bin/env bash
# smoke.sh <label> <deb-file-name-in-artifacts> [--control <official-deb-file-name>]
#
# Isolated smoke test: a throwaway ubuntu:24.04 container (3 CPUs, 8 GB, bridge network, no
# published ports, artifacts mounted read-only) installs the deb, starts `orca-ide serve
# --no-pairing` as a throwaway user, runs cli-matrix.sh (our CLI surface with fake ids) and
# rpc-probe.js (our RPC), waits 2 minutes and checks the serve pid did not change.
# With --control, the same runs for the official deb, for comparison.
# Output: ~/overhedge-build/smoke/<label>[-control]/. Exit 0 when every smoke run kept serve up
# and the patched run's CLI matrix shows our `account migrate` command routed.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
[ $# -ge 2 ] || { sed -n '2,12p' "$0"; exit 2; }
L=$1; DEB=$2; CTRL=""; shift 2
while [ $# -gt 0 ]; do case "$1" in --control) CTRL=$2; shift ;; *) echo "unknown arg $1" >&2; exit 2 ;; esac; shift; done

one() { # <label> <deb>
  local l=$1 d=$2 out=$OVH_HOME/smoke/$1 c=ovh-smoke-$1
  rm -rf "$out"; mkdir -p "$out"; docker rm -f "$c" >/dev/null 2>&1
  docker run -d --name "$c" --cpus "${CPUS:-3}" --memory 8g --network bridge \
    -v "$OVH_ARTIFACTS":/artifacts:ro -v "$here":/scripts:ro ubuntu:24.04 sleep infinity >/dev/null
  docker exec "$c" bash -lc "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq /artifacts/$d procps git iproute2 >/dev/null 2>&1; useradd -m tester; dpkg-query -W orca-ide" > "$out/install.txt" 2>&1
  u() { docker exec -u tester -e HOME=/home/tester -e LIBGL_ALWAYS_SOFTWARE=1 -w /home/tester "$c" bash -lc "$1"; }
  u "nohup orca-ide serve --port 6768 --no-pairing --json > serve.log 2>&1 &"; sleep 45
  u "pgrep -f 'cli/index.js serve'" > "$out/pids-start.txt"
  u "bash /scripts/cli-matrix.sh" > "$out/cli.txt" 2>&1
  u "ELECTRON_RUN_AS_NODE=1 /opt/Orca/orca-ide /scripts/rpc-probe.js" > "$out/rpc-probe.txt" 2>&1
  sleep 120
  u "pgrep -f 'cli/index.js serve'" > "$out/pids-end.txt"
  if [ -s "$out/pids-start.txt" ] && diff -q "$out/pids-start.txt" "$out/pids-end.txt" >/dev/null; then echo "serve pid stable: $(cat "$out/pids-end.txt")" > "$out/uptime.txt"; else echo "serve pid CHANGED or gone" > "$out/uptime.txt"; fi
  u "ps -o pid,etime,args -u tester | cut -c1-110" >> "$out/uptime.txt"
  u "cat serve.log" 2>&1 | ovh_redact > "$out/serve.log"
  u "cd ~/.config/orca/logs 2>/dev/null && for f in *; do echo \"== \$f\"; cat \"\$f\"; done" 2>&1 | ovh_redact > "$out/logs.txt"
  docker rm -f "$c" >/dev/null && echo "removed $c" >> "$out/uptime.txt"
  echo "== $l: $(cat "$out/install.txt" | tail -1) | $(head -1 "$out/uptime.txt") | crash-ish lines: $(grep -ciE 'crash|fatal|uncaught' "$out/serve.log")"
}
rc=0
one "$L" "$DEB"
grep -q 'serve pid stable' "$OVH_HOME/smoke/$L/uptime.txt" || rc=1
grep -q 'Unknown command' <(sed -n '/account migrate --help/,/exit=/p' "$OVH_HOME/smoke/$L/cli.txt") && { echo "patched build does not route account migrate"; rc=1; }
if [ -n "$CTRL" ]; then
  one "$L-control" "$CTRL"
  grep -q 'serve pid stable' "$OVH_HOME/smoke/$L-control/uptime.txt" || echo "note: control run also unstable"
  echo "== diff of CLI matrix (control vs patched), first 60 lines"
  diff "$OVH_HOME/smoke/$L-control/cli.txt" "$OVH_HOME/smoke/$L/cli.txt" | head -60
fi
exit $rc
