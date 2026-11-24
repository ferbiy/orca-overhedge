#!/usr/bin/env bash
# Git pre-push hook for ~/overhedge-build/fork (installed by install.sh as .git/hooks/pre-push;
# all worktrees of that clone share it). Refuses, whatever the command line was:
#  - any push to main, to tags, or deleting a branch (except overhedge/rehearsal/* scratch branches)
#  - any non-fast-forward update (force push)
#  - updating an existing overhedge/base-* branch (bases are created once at the upstream tag)
#  - creating overhedge/base-<id> at a commit other than the matching upstream tag v1.4.<id>
set -euo pipefail
z=0000000000000000000000000000000000000000
fail() { echo "pre-push guard: $*" >&2; exit 1; }
while read -r _lref lsha rref rsha; do
  case "$rref" in
    refs/heads/main|refs/heads/master) fail "pushing to ${rref#refs/heads/} is not allowed" ;;
    refs/tags/*) fail "pushing tags is not allowed" ;;
  esac
  if [ "$lsha" = "$z" ]; then
    case "$rref" in refs/heads/overhedge/rehearsal/*) continue ;; esac
    fail "deleting $rref is not allowed"
  fi
  case "$rref" in
    refs/heads/overhedge/base-*)
      [ "$rsha" = "$z" ] || fail "${rref#refs/heads/} already exists; bases are never updated"
      id=${rref##*/base-}
      t=$(git rev-parse -q --verify "refs/tags/v1.4.$id^{commit}" 2>/dev/null || true)
      [ -n "$t" ] && [ "$t" = "$lsha" ] || fail "${rref#refs/heads/} must point at upstream tag v1.4.$id"
      ;;
  esac
  if [ "$rsha" != "$z" ]; then
    git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null || fail "non-fast-forward update of ${rref#refs/heads/} refused (no force pushes)"
  fi
done
exit 0
