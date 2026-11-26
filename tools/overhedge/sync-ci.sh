#!/usr/bin/env bash
# sync-ci.sh <new-tag> [--commit]
#
# Brings the upstream files that the fork's CI resolves from overhedge/ci up to <new-tag>:
# .github/workflows/qualified-orcad-template.yml, .github/workflows/node-server-tests.yml and
# .github/actions/ (whole tree, deletions included). Works in the worktree ~/overhedge-build/ci
# (branch overhedge/ci, fast-forwarded to origin first). Never pushes.
# Also prints whether upstream changed release-mac-build.yml / release-cut.yml between the
# previous base and <new-tag> (then overhedge-mac-app.yml / overhedge-server-deb.yml need a look).
# --commit: commit the sync ("ci(overhedge): build <ver>-based refs").
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
tag=${1:-}; commit=0; [ "${2:-}" = --commit ] && commit=1
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '2,11p' "$0"; exit 2; }
F=$OVH_HOME/fork; C=$OVH_HOME/ci
[ -d "$F/.git" ] || { echo "run port-prep.sh first (no $F)" >&2; exit 1; }
git -C "$F" fetch -q origin
git -C "$F" fetch -q upstream "refs/tags/$tag:refs/tags/$tag"
if [ ! -e "$C" ]; then git -C "$F" worktree add -q "$C" "$OVH_CI_BRANCH" 2>/dev/null || git -C "$F" worktree add -q -B "$OVH_CI_BRANCH" "$C" "origin/$OVH_CI_BRANCH"; fi
[ -z "$(git -C "$C" status --porcelain)" ] || { echo "$C has local changes; not syncing" >&2; exit 1; }
git -C "$C" merge -q --ff-only "origin/$OVH_CI_BRANCH"
git -C "$C" rm -r -q --ignore-unmatch .github/actions
git -C "$C" checkout "$tag" -- .github/actions .github/workflows/qualified-orcad-template.yml .github/workflows/node-server-tests.yml
git -C "$C" add -A .github
git -C "$C" diff --cached --stat | tail -20
# Reusable workflows/actions the overhedge workflows reference must exist at the tag.
for ref in $(grep -ho 'uses: \./\.github/[^ ]*' "$C"/.github/workflows/overhedge-*.yml "$C"/.github/workflows/qualified-orcad-template.yml | sed 's/uses: \.\///' | sort -u); do
  [ -e "$C/$ref" ] || echo "WARNING: $ref is referenced but missing after the sync"
done
# Previous base = the upstream tag of the newest port below <new-tag> (overhedge-port/v<x> -> v<x>).
ovh_fetch_port_tags "$F"
prev_ver=$(ovh_port_versions "$F" | while read -r x; do
  [ "$x" != "${tag#v}" ] && [ "$(printf '%s\n%s\n' "$x" "${tag#v}" | sort -V | head -1)" = "$x" ] && echo "$x"; done | tail -1 || true)
if [ -n "$prev_ver" ]; then
  prev_base=v$prev_ver
  git -C "$F" fetch -q upstream "refs/tags/$prev_base:refs/tags/$prev_base"
  for wf in release-mac-build.yml release-cut.yml; do
    if git -C "$F" diff --quiet "$prev_base" "$tag" -- ".github/workflows/$wf"; then echo "$wf unchanged since $prev_base"; else echo "$wf CHANGED since $prev_base: compare with the overhedge workflow"; fi
  done
else
  echo "no earlier ${OVH_PORT_TAG_PREFIX}* tag: compare release-mac-build.yml / release-cut.yml by hand"
fi
if [ "$commit" = 1 ] && ! git -C "$C" diff --cached --quiet; then
  git -C "$C" commit -q -m "ci(overhedge): build ${tag#v}-based refs

Sync qualified-orcad-template.yml, node-server-tests.yml and .github/actions
to upstream $tag (the overhedge workflows resolve them from this branch)."
  git -C "$C" log --oneline -1
fi
