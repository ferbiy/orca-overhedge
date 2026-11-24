#!/usr/bin/env bash
# Disposable systemd container test of deploy.sh / deploy-pending.sh. Runs on orca-ide.
set -uo pipefail
B=~/overhedge-build; T=${OVH_TEST_DIR:-$(cd "$(dirname "$0")" && pwd)}; C=ovh-deploy-test
OK=orca-ide_1.4.273+overhedge.18.ge5c6fe334d_amd64.deb; OFF=orca-ide_1.4.273_amd64.deb
cd "$T" || exit 1
docker build -q -t ovh-deploy-test:1 . >/dev/null || exit 1
# broken deb: same package, higher version, binary that exits 1
if [ ! -f work/broken.deb ]; then
  rm -rf work/x; mkdir -p work/x
  dpkg-deb -R "$B/artifacts/$OK" work/x
  sed -i 's/^Version: .*/Version: 1.4.273+overhedge.99.gbroken0000/' work/x/DEBIAN/control
  printf '#!/bin/sh\necho broken build >&2\nexit 1\n' > work/x/opt/Orca/orca-ide; chmod 755 work/x/opt/Orca/orca-ide
  dpkg-deb -Zgzip -z1 -b work/x work/orca-ide_1.4.273+overhedge.99.gbroken0000_amd64.deb >/dev/null && rm -rf work/x
  touch work/broken.deb
fi
docker rm -f $C >/dev/null 2>&1
docker run -d --name $C --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --cpus 6 --memory 10g \
  -v "$B/artifacts/$OK":/seed/$OK:ro -v "$B/artifacts/$OFF":/seed/$OFF:ro \
  -v "$T/work/orca-ide_1.4.273+overhedge.99.gbroken0000_amd64.deb":/seed/broken.deb:ro \
  -v "$B/tooling-src":/src:ro -v "$T/busy-cli.sh":/usr/local/bin/busy-cli:ro ovh-deploy-test:1 >/dev/null
sleep 8
x() { docker exec $C bash -lc "$1"; }
u() { docker exec -u ubuntu -e HOME=/home/ubuntu -w /home/ubuntu $C bash -lc "$1"; }
echo "== setup: official 1.4.273 installed and running"
x "apt-get install -y -qq /seed/$OFF >/dev/null 2>&1; dpkg-query -W orca-ide; systemctl start orca-serve; systemctl is-active orca-serve"
u "bash /src/tools/overhedge/install.sh >/dev/null && mkdir -p ~/overhedge-build/artifacts && cp /seed/$OFF /seed/$OK ~/overhedge-build/artifacts/ && cp /seed/broken.deb ~/overhedge-build/artifacts/orca-ide_1.4.273+overhedge.99.gbroken0000_amd64.deb && cd ~/overhedge-build/artifacts && sha256sum ./*.deb | sed 's# \./# #' > SHA256SUMS && ls"
# a terminal that must survive the restart
sleep 40
u "orca-ide repo add --path ~ >/dev/null 2>&1; orca-ide terminal create --worktree path:/home/ubuntu --title t1 --command 'sleep 100000' --json | jq -c '.ok'; orca-ide terminal list --json | jq -c '[.result.terminals[]|.connected]'"
S=/home/ubuntu/overhedge-build/scripts
echo; echo "== T1 check-only on a healthy idle host (expect 0)"
u "$S/deploy.sh --check-only 2>&1 | tail -2; echo exit=\${PIPESTATUS[0]}"
echo; echo "== T2 check-only with a working chat (stub agent list; expect 3)"
u "OVH_ORCA_CLI=busy-cli $S/deploy.sh --check-only 2>&1 | tail -2; echo exit=\${PIPESTATUS[0]}"
echo; echo "== T3 deploy refused while busy (expect 3, nothing changed)"
u "OVH_ORCA_CLI=busy-cli $S/deploy.sh ~/overhedge-build/artifacts/$OK 2>&1 | tail -2; echo exit=\${PIPESTATUS[0]}; dpkg-query -W orca-ide"
echo; echo "== T4 dry-run (expect 0, nothing changed)"
u "$S/deploy.sh --dry-run ~/overhedge-build/artifacts/$OK 2>&1 | grep -c DRY-RUN; dpkg-query -W orca-ide; ls -d ~/overhedge-build/backup-* 2>/dev/null | wc -l"
echo; echo "== T5 real deploy official -> overhedge.18 (expect 0, RESULT=ok)"
u "$S/deploy.sh --health-timeout 240 --stable 30 ~/overhedge-build/artifacts/$OK > /tmp/t5.log 2>&1; echo exit=\$?; grep -E 'before:|after:|RESULT|ended|health' /tmp/t5.log; cat ~/overhedge-build/state/last-deploy.env | grep -E 'RESULT|TERMINALS|PREV_DEB'; dpkg-query -W orca-ide; ls -la ~/overhedge-build/backup-*/ | head -12"
echo; echo "== T6 broken build via deploy-pending.sh, policy always (expect rollback, exit 5 inside, marker dropped)"
u "mkdir -p ~/overhedge-build/state/pending && printf 'DEB=%s\nVERSION=1.4.273+overhedge.99.gbroken0000\n' ~/overhedge-build/artifacts/orca-ide_1.4.273+overhedge.99.gbroken0000_amd64.deb > ~/overhedge-build/state/pending/orca-ide && sed -i 's/^DEPLOY_POLICY=.*/DEPLOY_POLICY=always/' ~/overhedge-build/update.conf && $S/deploy-pending.sh; echo exit=\$?; ls ~/overhedge-build/state/pending/; grep -E 'RESULT|PREV_DEB' ~/overhedge-build/state/last-deploy.env; dpkg-query -W orca-ide; systemctl is-active orca-serve; grep -E 'ROLLBACK|rollback|health' ~/overhedge-build/logs/deploy-2*.log | tail -6"
echo; echo "== T7 update-log.md"
u "cat ~/overhedge-build/update-log.md"
echo; echo "== T8 night-idle outside the window does nothing"
u "printf 'DEB=%s\nVERSION=1.4.273\n' ~/overhedge-build/artifacts/$OFF > ~/overhedge-build/state/pending/orca-ide; sed -i 's/^DEPLOY_POLICY=.*/DEPLOY_POLICY=night-idle/; s/^DEPLOY_WINDOW_START=.*/DEPLOY_WINDOW_START=00:00/; s/^DEPLOY_WINDOW_END=.*/DEPLOY_WINDOW_END=00:01/' ~/overhedge-build/update.conf; $S/deploy-pending.sh; echo exit=\$?; ls ~/overhedge-build/state/pending/; dpkg-query -W orca-ide"
echo; echo "== T9 night-idle inside the window but busy, last slot -> deferred entry once"
u "sed -i 's/^DEPLOY_WINDOW_START=.*/DEPLOY_WINDOW_START=00:00/; s/^DEPLOY_WINDOW_END=.*/DEPLOY_WINDOW_END=23:59/; s/^DEPLOY_RETRY_MINUTES=.*/DEPLOY_RETRY_MINUTES=1440/' ~/overhedge-build/update.conf; OVH_ORCA_CLI=busy-cli $S/deploy-pending.sh; OVH_ORCA_CLI=busy-cli $S/deploy-pending.sh; grep -c 'deploy deferred' ~/overhedge-build/update-log.md; dpkg-query -W orca-ide"
echo; echo "== T10 terminal still alive across both restarts"
u "orca-ide terminal list --json | jq -c '[.result.terminals[]|{title,connected}]'; pgrep -fa 'sleep 100000' | head -2"
echo; echo "== T11 cleanup --dry-run"
u "$S/cleanup.sh --dry-run 2>&1 | head -20"
docker rm -f $C >/dev/null && echo "removed $C"
