#!/usr/bin/env bash
# fetch-and-verify.sh <deb-run-id> <official-version> [--mac-run <run-id>]
#   e.g. fetch-and-verify.sh 45449261790 1.4.273 --mac-run 45449300000
#
# 1. Downloads (if missing) the official orca-ide_<ver>_amd64.deb and the release's latest-linux.yml
#    into ~/overhedge-build/artifacts and checks the deb's sha512 against latest-linux.yml.
# 2. Downloads the CI deb artifact of <deb-run-id> and checks it against its .sha256; checks
#    Package/Architecture and that its Version sorts above <official-version>.
# 3. With --mac-run: downloads the mac zip into artifacts/mac/ and checks its .sha256.
# 4. Rewrites artifacts/SHA256SUMS (and artifacts/mac/SHA256SUMS).
# Prints DEB=<path> (and MAC_ZIP=<path>) as the last lines. Exit non-zero on any mismatch.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
RUN=${1:-}; OFFV=${2:-}; shift 2 || { sed -n '2,13p' "$0"; exit 2; }
MAC_RUN=""
while [ $# -gt 0 ]; do case "$1" in --mac-run) MAC_RUN=$2; shift ;; *) echo "unknown arg $1" >&2; exit 2 ;; esac; shift; done
A=$OVH_ARTIFACTS; DL=$OVH_HOME/dl; mkdir -p "$A" "$DL"

OFF=orca-ide_${OFFV}_amd64.deb; YML=$A/latest-linux-$OFFV.yml
if [ ! -f "$A/$OFF" ] || [ ! -f "$YML" ]; then
  rm -rf "$DL/off"; mkdir -p "$DL/off"
  gh release download "v$OFFV" -R "$OVH_UPSTREAM_REPO" -p "$OFF" -p latest-linux.yml -D "$DL/off" --clobber
  mv "$DL/off/$OFF" "$A/"; mv "$DL/off/latest-linux.yml" "$YML"
fi
want=$(grep -A1 "url: $OFF" "$YML" | sed -n "s/.*sha512: //p")
got=$(openssl dgst -sha512 -binary "$A/$OFF" | base64 -w0)
if [ -n "$want" ] && [ "$want" = "$got" ]; then echo "OK official $OFF sha512 matches the release's latest-linux.yml"; else echo "FAIL official sha512"; exit 1; fi

NAME=$(gh api "repos/$OVH_FORK_REPO/actions/runs/$RUN/artifacts" --jq '[.artifacts[].name | select(startswith("orca-ide_"))] | first // empty')
[ -n "$NAME" ] || { echo "FAIL no orca-ide_* artifact in run $RUN"; exit 1; }
if [ ! -f "$A/$NAME.deb" ]; then
  rm -rf "$DL/ci"; gh run download "$RUN" -R "$OVH_FORK_REPO" -n "$NAME" -D "$DL/ci"
  mv "$DL/ci/$NAME.deb" "$DL/ci/$NAME.deb.sha256" "$A/"
fi
want=$(awk '{print $1}' "$A/$NAME.deb.sha256"); got=$(sha256sum "$A/$NAME.deb" | awk '{print $1}')
if [ "$want" = "$got" ]; then echo "OK CI deb sha256 matches its .sha256"; else echo "FAIL CI sha256"; exit 1; fi
[ "$(dpkg-deb -f "$A/$NAME.deb" Package)" = orca-ide ] || { echo "FAIL package name"; exit 1; }
[ "$(dpkg-deb -f "$A/$NAME.deb" Architecture)" = amd64 ] || { echo "FAIL architecture"; exit 1; }
v=$(dpkg-deb -f "$A/$NAME.deb" Version)
case "$v" in "$OFFV"+overhedge.*) ;; *) echo "FAIL version $v is not $OFFV+overhedge.*"; exit 1 ;; esac
dpkg --compare-versions "$v" gt "$OFFV" && echo "OK $v > $OFFV" || { echo "FAIL $v does not sort above $OFFV"; exit 1; }
(cd "$A" && sha256sum ./*.deb | sed 's# \./# #' > SHA256SUMS)
echo "installed on host: $(ovh_installed_version)"

if [ -n "$MAC_RUN" ]; then
  M=$A/mac; mkdir -p "$M"
  MNAME=$(gh api "repos/$OVH_FORK_REPO/actions/runs/$MAC_RUN/artifacts" --jq '[.artifacts[].name] | first // empty')
  [ -n "$MNAME" ] || { echo "FAIL no artifact in mac run $MAC_RUN"; exit 1; }
  rm -rf "$DL/mac"; gh run download "$MAC_RUN" -R "$OVH_FORK_REPO" -n "$MNAME" -D "$DL/mac"
  zip=$(find "$DL/mac" -name '*.zip' | head -1); [ -n "$zip" ] || { echo "FAIL no zip in mac artifact"; exit 1; }
  mv "$zip" "$zip.sha256" "$M/"
  zip=$M/$(basename "$zip")
  (cd "$M" && sha256sum -c "$(basename "$zip").sha256" >/dev/null) && echo "OK mac zip sha256" || { echo "FAIL mac zip sha256"; exit 1; }
  (cd "$M" && sha256sum ./*.zip | sed 's# \./# #' > SHA256SUMS)
fi
echo "DEB=$A/$NAME.deb"
[ -z "$MAC_RUN" ] || echo "MAC_ZIP=$zip"
