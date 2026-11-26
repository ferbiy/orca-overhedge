#!/usr/bin/env bash
# promote.sh <vX.Y.Z> <port-sha> <from-sha> [--dry-run]
#
# Go step of a port (UPDATE-RUNBOOK.md 4.7): makes the verified port the patched Orca.
#  1. checks: <port-sha> sits on upstream <vX.Y.Z>, is pushed (in origin/overhedge/port-<id>), and
#     origin/overhedge/main is still <from-sha> (port-prep.sh's port-<id>/.chk/from.sha): if main
#     moved during the port, its new commits are not in the port -> refuse (cherry-pick them onto the
#     port branch, rebuild, and pass the new main head as <from-sha>)
#  2. annotated tag overhedge-port/<vX.Y.Z> at <port-sha> (the port's linear history on the tag)
#  3. moves overhedge/main WITHOUT a force push: a merge commit
#       parents: old overhedge/main (first), <port-sha> (second); tree: exactly <port-sha>'s tree
#     ("git merge -s ours" the other way round). History stays append-only, --first-parent shows
#     one "port to vX.Y.Z" commit per port, and the tree is byte-identical to what CI built and the
#     checks tested. When old main is already an ancestor of <port-sha>, it is a plain fast-forward.
#  4. pushes tag and branch in one atomic push (pre-push guard checks it), then deletes the
#     transient overhedge/port-<id> branch (the guard allows it because the tag keeps its head)
#  5. makes sure the fork's default branch is overhedge/main
# Prints MAIN_SHA= PORT_TAG= PORT_SHA=. Idempotent: rerunning after success prints the same.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
tag=${1:-}; port=${2:-}; from=${3:-}; dry=0; [ "${4:-}" = --dry-run ] && dry=1
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "$port" =~ ^[0-9a-f]{40}$ ]] && [[ "$from" =~ ^[0-9a-f]{40}$ ]] \
  || { sed -n '2,20p' "$0"; exit 2; }
ver=${tag#v}; rid=$(ovh_release_id "$ver"); ptag=$(ovh_port_tag "$ver")
F=$OVH_HOME/fork; M=$OVH_MAIN_BRANCH
run() { if [ "$dry" = 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }
git -C "$F" fetch -q --prune origin
ovh_fetch_port_tags "$F"
git -C "$F" fetch -q upstream "refs/tags/$tag:refs/tags/$tag"
cur=$(git -C "$F" rev-parse "refs/remotes/origin/$M")

if existing=$(git -C "$F" rev-parse -q --verify "refs/tags/$ptag^{commit}"); then
  [ "$existing" = "$port" ] || { echo "$ptag already exists at $existing, not at $port" >&2; exit 1; }
  if git -C "$F" merge-base --is-ancestor "$port" "$cur" && [ "$(git -C "$F" rev-parse "$cur^{tree}")" = "$(git -C "$F" rev-parse "$port^{tree}")" ]; then
    echo "already promoted"; printf 'MAIN_SHA=%s\nPORT_TAG=%s\nPORT_SHA=%s\n' "$cur" "$ptag" "$port"; exit 0
  fi
fi
git -C "$F" merge-base --is-ancestor "$tag" "$port" || { echo "$port does not sit on upstream $tag" >&2; exit 1; }
if git -C "$F" rev-parse -q --verify "refs/remotes/origin/overhedge/port-$rid" >/dev/null; then
  git -C "$F" merge-base --is-ancestor "$port" "refs/remotes/origin/overhedge/port-$rid" \
    || { echo "$port is not in origin/overhedge/port-$rid (push the port branch first)" >&2; exit 1; }
else
  [ -n "${existing:-}" ] || { echo "origin/overhedge/port-$rid does not exist (push it first)" >&2; exit 1; }
fi
if [ "$cur" != "$from" ]; then
  echo "origin/$M moved during the port: was ${from:0:10}, now ${cur:0:10}. Not in the port:" >&2
  git -C "$F" log --oneline "$from..$cur" >&2 || true
  echo "Re-apply those commits on the port branch, rebuild, and pass ${cur} as <from-sha>." >&2
  exit 1
fi

if [ -z "${existing:-}" ]; then
  run git -C "$F" tag -a "$ptag" "$port" -m "Overhedge patch ported onto upstream $tag (port head; linear history on top of $tag)."
fi
if git -C "$F" merge-base --is-ancestor "$cur" "$port"; then
  new=$port
else
  if [ "$dry" = 1 ]; then new="<merge of ${cur:0:10} and ${port:0:10}>"
  else
    new=$(git -C "$F" commit-tree "$port^{tree}" -p "$cur" -p "$port" -m "overhedge: port to $tag

$M now carries the patch re-applied onto upstream $tag ($ptag, ${port:0:10}).
Tree = $ptag's tree; first parent = the previous $M (${cur:0:10}).")
  fi
fi
run git -C "$F" push --atomic origin "$new:refs/heads/$M" "refs/tags/$ptag"
if git -C "$F" rev-parse -q --verify "refs/remotes/origin/overhedge/port-$rid" >/dev/null; then
  run git -C "$F" push origin ":refs/heads/overhedge/port-$rid"
fi
def=$(gh repo view "$OVH_FORK_REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
[ "$def" = "$M" ] || run gh repo edit "$OVH_FORK_REPO" --default-branch "$M"
[ "$dry" = 1 ] || git -C "$F" fetch -q --prune origin
printf 'MAIN_SHA=%s\nPORT_TAG=%s\nPORT_SHA=%s\n' "$new" "$ptag" "$port"
