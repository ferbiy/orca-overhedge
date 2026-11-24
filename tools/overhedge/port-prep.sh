#!/usr/bin/env bash
# port-prep.sh <new-tag> [--prev <patch-branch>] [--prefix overhedge|overhedge/rehearsal]
#
# Mechanical start of a port (no push):
#  - keeps a clone at ~/overhedge-build/fork (origin = the fork, upstream = stablyai/orca)
#  - creates <prefix>/base-<id> at the upstream tag and a worktree for it
#  - creates <prefix>/patch-<id> from that base in another worktree and 3-way applies the
#    squashed diff <prev-base>..<prev-patch> (e.g. overhedge/base-273..overhedge/patch-273)
#  - commits it when it applies cleanly; otherwise leaves the conflicts in the index
# Worktrees: ~/overhedge-build/base-<id> and patch-<id> (prefix overhedge), or
#            ~/overhedge-build/rehearsal-base-<id> / rehearsal-patch-<id> (prefix overhedge/rehearsal).
# Prints KEY=value: BASE_DIR PATCH_DIR BASE_BRANCH PATCH_BRANCH BASE_SHA PREV_BASE PREV_PATCH CONFLICTS
# Exit 0 clean apply (committed) | 3 conflicts to resolve | 1 error.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
tag=${1:-}; shift || true
prefix=overhedge; prev=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prev) prev=$2; shift ;;
    --prefix) prefix=$2; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '2,15p' "$0"; exit 2; }
case "$prefix" in overhedge|overhedge/rehearsal) ;; *) echo "prefix must be overhedge or overhedge/rehearsal" >&2; exit 2 ;; esac
ver=${tag#v}; rid=$(ovh_release_id "$ver")
F=$OVH_HOME/fork
if [ ! -d "$F/.git" ]; then
  git clone -q "https://github.com/$OVH_FORK_REPO.git" "$F"
fi
git -C "$F" remote get-url upstream >/dev/null 2>&1 || git -C "$F" remote add upstream "https://github.com/$OVH_UPSTREAM_REPO.git"
git -C "$F" config remote.upstream.tagOpt --no-tags
git -C "$F" fetch -q origin
git -C "$F" fetch -q upstream "refs/tags/$tag:refs/tags/$tag"
if [ -z "$prev" ]; then
  prev=$(git -C "$F" branch -r --list 'origin/overhedge/patch-*' | sed 's#^ *origin/##' | grep -E '^overhedge/patch-[0-9]+$' | sed 's#overhedge/patch-##' | sort -n | awk -v r="$rid" '$1 != r' | tail -1)
  prev=overhedge/patch-$prev
fi
prev_id=${prev##*-}
prev_base=origin/overhedge/base-$prev_id
git -C "$F" rev-parse -q --verify "$prev_base" >/dev/null || { echo "no $prev_base" >&2; exit 1; }
git -C "$F" rev-parse -q --verify "origin/$prev" >/dev/null || { echo "no origin/$prev" >&2; exit 1; }

base_br=$prefix/base-$rid; patch_br=$prefix/patch-$rid
dirp=""; [ "$prefix" = overhedge/rehearsal ] && dirp=rehearsal-
bdir=$OVH_HOME/${dirp}base-$rid; pdir=$OVH_HOME/${dirp}patch-$rid
for d in "$bdir" "$pdir"; do [ ! -e "$d" ] || { echo "$d already exists; remove it or reuse it by hand" >&2; exit 1; }; done
base_sha=$(git -C "$F" rev-parse "$tag^{commit}")
if git -C "$F" rev-parse -q --verify "refs/heads/$base_br" >/dev/null || git -C "$F" rev-parse -q --verify "refs/remotes/origin/$base_br" >/dev/null; then
  have=$(git -C "$F" rev-parse "origin/$base_br" 2>/dev/null || git -C "$F" rev-parse "$base_br")
  [ "$have" = "$base_sha" ] || { echo "$base_br exists at $have, not at $tag ($base_sha); not touching it" >&2; exit 1; }
fi
git -C "$F" worktree add -q --detach "$bdir" "$base_sha"
git -C "$bdir" checkout -q -B "$base_br" "$base_sha"
if git -C "$F" rev-parse -q --verify "refs/remotes/origin/$patch_br" >/dev/null; then
  echo "$patch_br already exists on origin; check it out by hand instead" >&2; exit 1
fi
git -C "$F" worktree add -q -b "$patch_br" "$pdir" "$base_sha"
mkdir -p "$pdir/.chk"
git -C "$F" diff --binary "$prev_base" "origin/$prev" > "$pdir/.chk/prev.patch"
conf=""
if git -C "$pdir" apply -3 --index "$pdir/.chk/prev.patch" > "$pdir/.chk/apply.log" 2>&1; then
  git -C "$pdir" commit -q -m "overhedge: re-apply $prev onto $tag

Squashed diff ${prev_base#origin/}..$prev applied with a 3-way apply." 
  rc=0
else
  conf=$(git -C "$pdir" diff --name-only --diff-filter=U | tr '\n' ' ')
  rc=3
  [ -n "$conf" ] || { echo "apply failed without conflict markers; see $pdir/.chk/apply.log" >&2; rc=1; }
fi
cat <<KV
BASE_DIR=$bdir
PATCH_DIR=$pdir
BASE_BRANCH=$base_br
PATCH_BRANCH=$patch_br
BASE_SHA=$base_sha
PREV_BASE=${prev_base#origin/}
PREV_PATCH=$prev
CONFLICTS=$conf
KV
exit $rc
