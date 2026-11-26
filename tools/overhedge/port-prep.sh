#!/usr/bin/env bash
# port-prep.sh <new-tag> [--from <ref>] [--prev <vX.Y.Z>] [--prefix overhedge|overhedge/rehearsal]
#
# Mechanical start of a port (no push). No base branches: the upstream tag is the base.
#  - keeps a clone at ~/overhedge-build/fork (origin = the fork, upstream = stablyai/orca)
#  - worktree ~/overhedge-build/base-<id>, detached at the upstream tag (baseline checks)
#  - worktree ~/overhedge-build/port-<id> on a new branch <prefix>/port-<id> at the tag, with the
#    squashed diff <prev tag>..<from> 3-way applied, where
#      <from> = origin/overhedge/main (the patched Orca now), or for a re-port of a release that
#               already has a port tag (rehearsal of the deployed release): the previous port tag
#      <prev> = the upstream tag <from> sits on = newest overhedge-port/v* tag below <new-tag>
#  - commits it when it applies cleanly; otherwise leaves the conflicts in the index
#  - writes the <from> sha to port-<id>/.chk/from.sha (promote.sh refuses to move overhedge/main
#    if it has moved since, because those commits would not be in the port)
# Rehearsal (prefix overhedge/rehearsal): rehearsal-base-<id> / rehearsal-port-<id>.
# Prints KEY=value: BASE_DIR PORT_DIR PORT_BRANCH BASE_SHA PREV_TAG FROM FROM_SHA CONFLICTS
# Exit 0 clean apply (committed) | 3 conflicts to resolve | 1 error.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
tag=${1:-}; shift || true
prefix=overhedge; from=""; prev=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from=$2; shift ;;
    --prev) prev=$2; shift ;;
    --prefix) prefix=$2; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '2,19p' "$0"; exit 2; }
case "$prefix" in overhedge|overhedge/rehearsal) ;; *) echo "prefix must be overhedge or overhedge/rehearsal" >&2; exit 2 ;; esac
ver=${tag#v}; rid=$(ovh_release_id "$ver")
F=$OVH_HOME/fork
if [ ! -d "$F/.git" ]; then
  git clone -q "https://github.com/$OVH_FORK_REPO.git" "$F"
fi
git -C "$F" remote get-url upstream >/dev/null 2>&1 || git -C "$F" remote add upstream "https://github.com/$OVH_UPSTREAM_REPO.git"
git -C "$F" config remote.upstream.tagOpt --no-tags
git -C "$F" fetch -q --prune origin
ovh_fetch_port_tags "$F"
git -C "$F" fetch -q upstream "refs/tags/$tag:refs/tags/$tag"

if [ -z "$prev" ]; then
  p=$(ovh_port_versions "$F" | awk -v v="$ver" '$0 != v' | while read -r x; do
        [ "$(printf '%s\n%s\n' "$x" "$ver" | sort -V | head -1)" = "$x" ] && echo "$x"; done | tail -1)
  [ -n "$p" ] || { echo "no ${OVH_PORT_TAG_PREFIX}* tag below $ver on origin; pass --prev and --from" >&2; exit 1; }
  prev=v$p
fi
[[ "$prev" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--prev must be an upstream tag vX.Y.Z" >&2; exit 1; }
git -C "$F" fetch -q upstream "refs/tags/$prev:refs/tags/$prev"
if [ -z "$from" ]; then
  if git -C "$F" rev-parse -q --verify "refs/tags/$(ovh_port_tag "$ver")" >/dev/null; then
    from=$(ovh_port_tag "${prev#v}")   # re-port of an already ported release (rehearsal)
  else
    from=origin/$OVH_MAIN_BRANCH
  fi
fi
from_sha=$(git -C "$F" rev-parse -q --verify "$from^{commit}") || { echo "no $from" >&2; exit 1; }
git -C "$F" merge-base --is-ancestor "$prev" "$from_sha" || { echo "$from does not contain upstream $prev; wrong --prev?" >&2; exit 1; }

port_br=$prefix/port-$rid
dirp=""; [ "$prefix" = overhedge/rehearsal ] && dirp=rehearsal-
bdir=$OVH_HOME/${dirp}base-$rid; pdir=$OVH_HOME/${dirp}port-$rid
for d in "$bdir" "$pdir"; do [ ! -e "$d" ] || { echo "$d already exists; remove it or reuse it by hand" >&2; exit 1; }; done
if git -C "$F" rev-parse -q --verify "refs/remotes/origin/$port_br" >/dev/null; then
  echo "$port_br already exists on origin; check it out by hand instead" >&2; exit 1
fi
base_sha=$(git -C "$F" rev-parse "$tag^{commit}")
git -C "$F" worktree add -q --detach "$bdir" "$base_sha"
git -C "$F" worktree add -q -b "$port_br" "$pdir" "$base_sha"
mkdir -p "$pdir/.chk"
echo "$from_sha" > "$pdir/.chk/from.sha"
git -C "$F" diff --binary "$prev" "$from_sha" > "$pdir/.chk/prev.patch"
conf=""
if git -C "$pdir" apply -3 --index "$pdir/.chk/prev.patch" > "$pdir/.chk/apply.log" 2>&1; then
  git -C "$pdir" commit -q -m "overhedge: re-apply the patch onto $tag

Squashed diff $prev..${from_sha:0:10} ($from) applied with a 3-way apply."
  rc=0
else
  conf=$(git -C "$pdir" diff --name-only --diff-filter=U | tr '\n' ' ')
  rc=3
  [ -n "$conf" ] || { echo "apply failed without conflict markers; see $pdir/.chk/apply.log" >&2; rc=1; }
fi
cat <<KV
BASE_DIR=$bdir
PORT_DIR=$pdir
PORT_BRANCH=$port_br
BASE_SHA=$base_sha
PREV_TAG=$prev
FROM=$from
FROM_SHA=$from_sha
CONFLICTS=$conf
KV
exit $rc
