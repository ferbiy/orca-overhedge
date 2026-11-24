#!/usr/bin/env bash
# latest-upstream.sh [--json] [--needs-work] [--tag vX.Y.Z]
#
# Finds the newest stable upstream Orca desktop release (skips drafts, prereleases and
# non-desktop tags such as android-v*), and reports how far the fork and this host are.
# Read-only: GitHub API via gh, git ls-remote, dpkg-query, files under ~/overhedge-build.
#
# Output: KEY=value lines (or one JSON object with --json):
#   LATEST_TAG LATEST_VERSION RELEASE_ID PUBLISHED_AT OFFICIAL_DEB_ASSET(yes|no)
#   BASE_BRANCH_EXISTS PATCH_BRANCH_EXISTS PREV_PATCH_BRANCH PREV_VERSION RELEASES_BEHIND
#   BUILT_DEB INSTALLED_VERSION DEPLOYED PENDING_DEPLOY FAILED_BEFORE STATUS
# STATUS / exit code:
#   up-to-date      10  installed build is already based on the newest release
#   deploy-pending  11  a verified build for it waits for the deploy timer
#   wait-for-asset  12  release exists but its official .deb is not published yet
#   failed-before   13  an earlier run for this release stopped or failed; needs a human
#   needs-build     0   patch branch exists but no verified deb here
#   needs-port      0   nothing exists for this release yet
#   (1 = error)
# --needs-work: print nothing, only the exit code (0 = an agent run is needed).
# --tag: evaluate a given tag instead of the newest (rehearsals).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
ovh_load_conf

json=0; quiet=0; tag=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) json=1 ;;
    --needs-work) quiet=1 ;;
    --tag) tag=$2; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done

releases=$(gh api "repos/$OVH_UPSTREAM_REPO/releases?per_page=60" \
  --jq '[.[] | select(.draft|not) | select(.prerelease|not) | select(.tag_name|test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) | {tag: .tag_name, published: .published_at, assets: [.assets[].name]}]')
[ -n "$releases" ] || { echo "no releases from GitHub" >&2; exit 1; }
if [ -z "$tag" ]; then
  tag=$(jq -r 'map(.tag) | sort_by(ltrimstr("v") | split(".") | map(tonumber)) | last' <<<"$releases")
fi
ver=${tag#v}
rid=$(ovh_release_id "$ver")
rel=$(jq -c --arg t "$tag" 'map(select(.tag==$t)) | first // empty' <<<"$releases")
[ -n "$rel" ] || { echo "tag $tag is not a stable desktop release" >&2; exit 1; }
published=$(jq -r .published <<<"$rel")
asset=no
jq -e --arg n "orca-ide_${ver}_amd64.deb" '.assets | index($n)' <<<"$rel" >/dev/null && asset=yes

heads=$(git ls-remote --heads "https://github.com/$OVH_FORK_REPO.git" 'overhedge/*' | awk '{sub("refs/heads/","",$2); print $2}')
has_branch() { grep -qx "$1" <<<"$heads"; }
base_exists=no; patch_exists=no
has_branch "overhedge/base-$rid" && base_exists=yes
has_branch "overhedge/patch-$rid" && patch_exists=yes

# Previous port: highest overhedge/patch-<n> other than this one (numeric ids only).
prev=$(grep -E '^overhedge/patch-[0-9]+$' <<<"$heads" | sed 's#overhedge/patch-##' | sort -n | awk -v r="$rid" '$1 != r' | tail -1 || true)
prev_branch=""; prev_version=""
if [ -n "$prev" ]; then prev_branch="overhedge/patch-$prev"; prev_version="1.4.$prev"; fi

behind=0
installed=$(ovh_installed_version)
inst_base=$(ovh_base_version "$installed")
if [ -n "$inst_base" ]; then
  behind=$(jq -r --arg v "$inst_base" '
    def key: ltrimstr("v") | split(".") | map(tonumber);
    ($v | split(".") | map(tonumber)) as $cur
    | [ .[] | select((.tag|key) > $cur) ] | length' <<<"$releases")
fi

built=""
shopt -s nullglob
for f in "$OVH_ARTIFACTS"/orca-ide_"$ver"+overhedge.*_amd64.deb; do built=$f; done
shopt -u nullglob

deployed=no
case "$installed" in "$ver"+overhedge.*) deployed=yes ;; esac

pending=""
# The build host (first "local" entry of hosts.conf) still waiting for a build of this release.
# Remote hosts' markers do not hold up new ports: a newer build replaces them.
local_host=$(ovh_hosts | awk '$2 == "local" {print $1; exit}')
for m in "$OVH_STATE/pending/${local_host:-orca-ide}"; do
  [ -f "$m" ] || continue
  d=$(sed -n 's/^DEB=//p' "$m")
  [[ "$(basename "$d")" == orca-ide_"$ver"+overhedge.* ]] && pending="$d ($(basename "$m"))"
done
failed=no
[ -f "$OVH_STATE/stopped-$rid" ] && failed=yes

if [ -n "$pending" ]; then status="deploy-pending"; code=11
elif [ "$deployed" = yes ]; then status="up-to-date"; code=10
elif [ "$failed" = yes ]; then status="failed-before"; code=13
elif [ "$asset" = no ]; then status="wait-for-asset"; code=12
elif [ "$patch_exists" = yes ]; then status="needs-build"; code=0
else status="needs-port"; code=0
fi

if [ "$quiet" = 1 ]; then exit "$code"; fi
kv() {
  cat <<EOF
LATEST_TAG=$tag
LATEST_VERSION=$ver
RELEASE_ID=$rid
PUBLISHED_AT=$published
OFFICIAL_DEB_ASSET=$asset
BASE_BRANCH_EXISTS=$base_exists
PATCH_BRANCH_EXISTS=$patch_exists
PREV_PATCH_BRANCH=$prev_branch
PREV_VERSION=$prev_version
RELEASES_BEHIND=$behind
BUILT_DEB=$built
INSTALLED_VERSION=$installed
DEPLOYED=$deployed
PENDING_DEPLOY=$pending
FAILED_BEFORE=$failed
STATUS=$status
EOF
}
if [ "$json" = 1 ]; then
  kv | jq -R 'split("=") | {(.[0]): (.[1:] | join("="))}' | jq -s add
else
  kv
fi
exit "$code"
