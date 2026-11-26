#!/usr/bin/env bash
# Git pre-push hook for ~/overhedge-build/fork (installed by install.sh as .git/hooks/pre-push;
# all worktrees of that clone share it). Enforces the branch layout of UPDATE-RUNBOOK.md section 1,
# whatever the command line was:
#  - branches: only overhedge/main, overhedge/ci, overhedge/port-<id> and overhedge/rehearsal/*;
#    never main/master or anything else (no more overhedge/base-* or overhedge/patch-*)
#  - every branch update is a fast-forward (no force push, overhedge/main included: a port moves it
#    with a merge commit whose first parent is the old head, see promote.sh)
#  - deleting: overhedge/rehearsal/* always; overhedge/port-<id> only when its head is kept by an
#    overhedge-port/v* tag in this clone; nothing else (never overhedge/main or overhedge/ci)
#  - tags: only creating annotated overhedge-port/v<ver> and v<ver>-overhedge.<n> (release) tags;
#    a release tag's commit must be in origin/overhedge/main; no tag is ever moved or deleted
set -euo pipefail
z=0000000000000000000000000000000000000000
main=overhedge/main
fail() { echo "pre-push guard: $*" >&2; exit 1; }
while read -r _lref lsha rref rsha; do
  name=${rref#refs/*/}
  case "$rref" in
    refs/tags/*)
      [ "$rsha" = "$z" ] || fail "tag $name already exists on the remote; tags are never moved or deleted"
      [ "$lsha" != "$z" ] || fail "deleting tag $name is not allowed"
      [ "$(git cat-file -t "$lsha")" = tag ] || fail "tag $name must be annotated"
      case "$name" in
        overhedge-port/v[0-9]*.[0-9]*.[0-9]*) ;;
        v[0-9]*.[0-9]*.[0-9]*-overhedge.[0-9]*)
          c=$(git rev-parse "$lsha^{commit}")
          git merge-base --is-ancestor "$c" "refs/remotes/origin/$main" 2>/dev/null \
            || fail "release tag $name points at ${c:0:10}, which is not in origin/$main (fetch, or promote first)"
          ;;
        *) fail "tag $name is not an overhedge-port/v* or v*-overhedge.* tag" ;;
      esac
      continue
      ;;
    refs/heads/*) ;;
    *) fail "pushing $rref is not allowed" ;;
  esac
  case "$name" in
    "$main"|overhedge/ci|overhedge/port-[0-9]*|overhedge/rehearsal/*) ;;
    *) fail "branch $name is not part of the layout (overhedge/main, overhedge/ci, overhedge/port-<id>, overhedge/rehearsal/*)" ;;
  esac
  if [ "$lsha" = "$z" ]; then
    case "$name" in
      overhedge/rehearsal/*) continue ;;
      overhedge/port-*)
        kept=$(git tag -l 'overhedge-port/v*' --contains "$rsha" 2>/dev/null | head -1)
        [ -n "$kept" ] || fail "deleting $name refused: its head ${rsha:0:10} is in no overhedge-port/v* tag"
        continue
        ;;
      *) fail "deleting $name is not allowed" ;;
    esac
  fi
  if [ "$rsha" != "$z" ]; then
    git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null || fail "non-fast-forward update of $name refused (no force pushes)"
  elif [ "$name" = "$main" ] || [ "$name" = overhedge/ci ]; then
    fail "$name does not exist on the remote; it is never re-created by the automation"
  fi
done
exit 0
