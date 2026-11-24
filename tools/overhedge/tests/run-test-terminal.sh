#!/usr/bin/env bash
set -uo pipefail
B=~/overhedge-build; T=$B/deploy-test; C=ovh-deploy-test2
OK=orca-ide_1.4.273+overhedge.18.ge5c6fe334d_amd64.deb; OFF=orca-ide_1.4.273_amd64.deb
docker rm -f $C >/dev/null 2>&1
docker run -d --name $C --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --cpus 6 --memory 10g \
  -v "$B/artifacts/$OK":/seed/$OK:ro -v "$B/artifacts/$OFF":/seed/$OFF:ro -v "$B/tooling-src":/src:ro ovh-deploy-test:1 >/dev/null
sleep 8
x() { docker exec $C bash -lc "$1"; }
u() { docker exec -u ubuntu -e HOME=/home/ubuntu -w /home/ubuntu $C bash -lc "$1"; }
x "apt-get install -y -qq /seed/$OFF >/dev/null 2>&1; systemctl start orca-serve"
u "bash /src/tools/overhedge/install.sh >/dev/null && cp /seed/$OFF /seed/$OK ~/overhedge-build/artifacts/ && cd ~/overhedge-build/artifacts && sha256sum ./*.deb | sed \"s# \./# #\" > SHA256SUMS"
sleep 40
u "mkdir -p ~/proj && cd ~/proj && git init -q -b main . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init; orca-ide repo add --path ~/proj 2>&1 | tail -1; orca-ide terminal create --worktree path:/home/ubuntu/proj --title t1 --command \"sleep 100000\" --json 2>&1 | jq -c \"{ok,err:.error}\"; sleep 5; orca-ide terminal list --json | jq -c \"[.result.terminals[]|{title,connected}]\"; pgrep -fa \"sleep 100000\" | grep -v pgrep | head -2"
echo "== deploy official -> overhedge.18 with a live terminal"
u "~/overhedge-build/scripts/deploy.sh --stable 20 ~/overhedge-build/artifacts/$OK > /tmp/d.log 2>&1; echo exit=\$?; grep -E \"before:|after:|RESULT\" /tmp/d.log; orca-ide terminal list --json | jq -c \"[.result.terminals[]|{title,connected}]\"; pgrep -fa \"sleep 100000\" | grep -v pgrep | head -2"
docker rm -f $C >/dev/null && echo removed
