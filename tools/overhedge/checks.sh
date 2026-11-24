#!/usr/bin/env bash
# checks.sh <tree-dir> <base-ref> [steps...]
#
# Runs the repo checks for one checkout in Docker (node:24, --cpus 6), never on the host.
#   <tree-dir>  checkout under ~/overhedge-build (absolute or relative to it), e.g. patch-274
#   <base-ref>  upstream tag / sha the patch sits on (changed-code lint gate, our-file lists)
#   steps       default: install gen fmt tc lint ours mobile wide
#     install   pnpm install --frozen-lockfile (pnpm version from package.json packageManager)
#     gen       run the generators the patch touches; fails if they change tracked files
#     fmt       oxfmt --check on .ts/.tsx files changed vs <base-ref>
#     tc lint   pnpm tc / pnpm lint (ORCA_CODE_QUALITY_BASE=<base-ref>)
#     ours      vitest on the *.test.ts(x) files changed vs <base-ref> outside mobile/
#     mobile    the same for files under mobile/ (skipped when none)
#     wide      vitest json run of src/main src/cli src/shared -> .chk/wide.json + wide.txt
# Results: <tree>/.chk/summary.txt (step=exit code lines), logs in <tree>/.chk/*.log.
# Exit code: 0 when every requested step passed, except `wide` (compare it with compare-wide.sh).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"

[ $# -ge 2 ] || { sed -n '2,20p' "$0"; exit 2; }
tree=$1; base=$2; shift 2
case "$tree" in /*) ;; *) tree=$OVH_HOME/$tree ;; esac
[ -d "$tree/.git" ] || [ -f "$tree/.git" ] || { echo "not a git checkout: $tree" >&2; exit 2; }
case "$(readlink -f "$tree")" in "$(readlink -f "$OVH_HOME")"/*) ;; *) echo "tree must be under $OVH_HOME" >&2; exit 2 ;; esac
steps=("$@"); [ ${#steps[@]} -gt 0 ] || steps=(install gen fmt tc lint ours mobile wide)
base_sha=$(git -C "$tree" rev-parse "$base^{commit}")

mkdir -p "$tree/.chk"
# Our test files: tests added or changed by the patch.
git -C "$tree" diff --name-only --diff-filter=AM "$base_sha" HEAD -- '*.test.ts' '*.test.tsx' | grep -v '^mobile/' > "$tree/.chk/ours-files.txt" || true
git -C "$tree" diff --name-only --diff-filter=AM "$base_sha" HEAD -- 'mobile/*.test.ts' 'mobile/*.test.tsx' | sed 's#^mobile/##' > "$tree/.chk/mobile-files.txt" || true
git -C "$tree" diff --name-only --diff-filter=AM "$base_sha" HEAD -- '*.ts' '*.tsx' > "$tree/.chk/changed-ts.txt" || true

cmds='set -u; git config --global --add safe.directory /w; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; corepack enable >/dev/null 2>&1;'
for s in "${steps[@]}"; do
  case "$s" in
    install) cmds+=' pnpm install --frozen-lockfile > .chk/install.log 2>&1; echo install=$?;' ;;
    gen) cmds+=' (pnpm generate:rpc-params-catalog && git diff --exit-code --stat) > .chk/gen.log 2>&1; echo gen=$?;' ;;
    fmt) cmds+=' if [ -s .chk/changed-ts.txt ]; then xargs pnpm exec oxfmt --check < .chk/changed-ts.txt > .chk/fmt.log 2>&1; echo fmt=$?; else echo fmt=0; fi;' ;;
    tc) cmds+=' pnpm tc > .chk/tc.log 2>&1; echo tc=$?;' ;;
    lint) cmds+=' pnpm lint > .chk/lint.log 2>&1; echo lint=$?;' ;;
    ours) cmds+=' if [ -s .chk/ours-files.txt ]; then xargs pnpm exec vitest run --config config/vitest.config.ts < .chk/ours-files.txt > .chk/ours.log 2>&1; echo ours=$?; else echo ours=skipped; fi;' ;;
    mobile) cmds+=' if [ -s .chk/mobile-files.txt ]; then (cd mobile && xargs pnpm exec vitest run < ../.chk/mobile-files.txt) > .chk/mobile.log 2>&1; echo mobile=$?; else echo mobile=skipped; fi;' ;;
    wide) cmds+=' pnpm exec vitest run --config config/vitest.config.ts --reporter=json --outputFile=.chk/wide.json src/main src/cli src/shared > .chk/wide.log 2>&1; echo wide=$?;' ;;
    *) echo "unknown step $s" >&2; exit 2 ;;
  esac
done

name=ovh-chk-$(basename "$tree")-$$
log "checks: $tree on $base ($base_sha) steps: ${steps[*]} (container $name)"
docker run --rm --name "$name" --cpus 6 --memory 24g -e CI=1 -e ORCA_CODE_QUALITY_BASE="$base_sha" \
  -e npm_config_store_dir=/pnpm-store -v "$OVH_HOME/.pnpm-store":/pnpm-store \
  -v "$tree":/w -w /w node:24 bash -lc "$cmds" > "$tree/.chk/summary.txt" 2>&1 || true
cat "$tree/.chk/summary.txt"
if [ -f "$tree/.chk/wide.json" ] && printf '%s\n' "${steps[@]}" | grep -qx wide; then
  python3 "$here/wide-summary.py" "$tree/.chk/wide.json" "$tree/.chk/wide.txt" | tee -a "$tree/.chk/summary.txt"
fi
# Pass = every listed step reported 0 or skipped (wide is judged by compare-wide.sh).
bad=$(grep -E '^[a-z]+=' "$tree/.chk/summary.txt" | grep -vE '^wide=' | grep -vE '=(0|skipped)$' || true)
[ -z "$bad" ] || { echo "FAILED steps: $(echo "$bad" | tr '\n' ' ')"; exit 1; }
missing=0
for s in "${steps[@]}"; do grep -q "^$s=" "$tree/.chk/summary.txt" || { echo "step $s did not report"; missing=1; }; done
exit "$missing"
