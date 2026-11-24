#!/usr/bin/env bash
# compare-wide.sh <base-tree> <patch-tree>
#
# Compares the wide vitest runs (checks.sh ... wide) of the pristine upstream base and the patch.
# Failing entries in the patch that are not failing in the base are "new failures". Their test
# files are re-run once in both trees (Docker) to separate flakes from regressions.
# Prints counts and lists; writes <patch-tree>/.chk/wide-compare.txt.
# Exit 0: no regression | 1: regression(s) remain after the re-run | 2: usage / missing data.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
[ $# -eq 2 ] || { sed -n '2,10p' "$0"; exit 2; }
b=$1; p=$2
case "$b" in /*) ;; *) b=$OVH_HOME/$b ;; esac
case "$p" in /*) ;; *) p=$OVH_HOME/$p ;; esac
for t in "$b" "$p"; do [ -f "$t/.chk/wide.txt" ] && [ -f "$t/.chk/wide.json" ] || { echo "missing $t/.chk/wide.{txt,json}: run checks.sh $t <base> wide first" >&2; exit 2; }; done

out=$p/.chk/wide-compare.txt
count() { jq -r '"\(.numTotalTests) tests, \(.numFailedTests) failed, \(.numTotalTestSuites) files"' "$1"; }
new=$(comm -13 <(sort -u "$b/.chk/wide.txt") <(sort -u "$p/.chk/wide.txt") | sed '/^$/d' || true)
fixed=$(comm -23 <(sort -u "$b/.chk/wide.txt") <(sort -u "$p/.chk/wide.txt") | sed '/^$/d' || true)
{
  echo "base:  $(count "$b/.chk/wide.json")"
  echo "patch: $(count "$p/.chk/wide.json")"
  echo "new failing entries in patch: $(printf '%s' "$new" | grep -c . || true)"
  printf '%s\n' "$new" | sed 's/^/  + /'
  echo "failing in base only: $(printf '%s' "$fixed" | grep -c . || true)"
} > "$out"

if [ -n "$new" ]; then
  files=$(printf '%s\n' "$new" | sed 's/ :: .*//' | sort -u | tr '\n' ' ')
  echo "re-running once in both trees: $files" >> "$out"
  for t in "$b" "$p"; do
    common=$(cd "$t" && readlink -f "$(git rev-parse --git-common-dir)")
    docker run --rm --cpus 6 -e CI=1 -v "$common":"$common" -v "$t":/w -w /w node:24 bash -lc \
      "git config --global --add safe.directory '*'; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; corepack enable >/dev/null 2>&1; pnpm exec vitest run --config config/vitest.config.ts --reporter=json --outputFile=.chk/rerun.json $files > .chk/rerun.log 2>&1; true"
    if [ -f "$t/.chk/rerun.json" ]; then python3 "$here/wide-summary.py" "$t/.chk/rerun.json" "$t/.chk/rerun.txt" >/dev/null; else : > "$t/.chk/rerun.txt"; fi
  done
  # Still failing in the patch, and not failing in the base re-run either.
  still=$(comm -12 <(printf '%s\n' "$new" | sort -u) <(sort -u "$p/.chk/rerun.txt") | sed '/^$/d' || true)
  still=$(comm -23 <(printf '%s\n' "$still" | sort -u) <(sort -u "$b/.chk/rerun.txt") | sed '/^$/d' || true)
  {
    echo "after re-run, still failing only in patch: $(printf '%s' "$still" | grep -c . || true)"
    printf '%s\n' "$still" | sed '/^$/d; s/^/  ! /'
  } >> "$out"
  cat "$out"
  [ -z "$still" ] || exit 1
  exit 0
fi
cat "$out"
