#!/usr/bin/env bash
# cleanup.sh [--dry-run]
#
# Frees space under ~/overhedge-build only. Keeps:
#  - debs: the installed version, the pending deploy, the last deploy's rollback deb, the official
#    deb of the installed base, plus the newest KEEP_BUILDS overhedge and KEEP_BUILDS official debs
#    (artifacts/, artifacts/old/, artifacts/rollback/); SHA256SUMS are rewritten
#  - mac zips: newest KEEP_BUILDS in artifacts/mac/
#  - Linux desktop AppImages: newest KEEP_BUILDS in artifacts/linux/
#  - backups: newest KEEP_BACKUPS backup-* dirs and the one in last-backup-path
#  - port worktrees of ~/overhedge-build/fork: the newest KEEP_PORT_TREES release ids (base-/port-, older patch-,
#    rehearsal-*); older ones are removed with `git worktree remove --force` (branches stay)
#  - smoke/ runs and logs/ files younger than 30 / 90 days
# Standalone clones from the manual ports (base-266, patch-266, ...) are only listed, never removed.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
ovh_load_conf
dry=0; [ "${1:-}" = --dry-run ] && dry=1
rmv() { if [ "$dry" = 1 ]; then echo "DRY-RUN: rm -rf $*"; else echo "rm -rf $*"; rm -rf -- "$@"; fi; }
A=$OVH_ARTIFACTS
installed=$(ovh_installed_version)
protect=("orca-ide_${installed}_amd64.deb" "orca-ide_$(ovh_base_version "$installed")_amd64.deb")
for m in "$OVH_STATE"/pending/*; do [ -f "$m" ] && protect+=("$(basename "$(sed -n 's/^DEB=//p' "$m")")"); done
[ -f "$OVH_STATE/last-deploy.env" ] && protect+=("$(basename "$(sed -n 's/^PREV_DEB=//p' "$OVH_STATE/last-deploy.env")")")
is_protected() { local n; for n in "${protect[@]}"; do [ "$n" = "$1" ] && return 0; done; return 1; }
ver_of() { local n=${1#orca-ide_}; echo "${n%_amd64.deb}"; }

echo "== debs (protected: ${protect[*]})"
mapfile -t debs < <(find "$A" -maxdepth 2 -name 'orca-ide_*_amd64.deb' -type f 2>/dev/null)
for kind in overhedge official; do
  list=()
  for f in "${debs[@]}"; do
    n=$(basename "$f")
    case "$n" in *+overhedge.*) [ $kind = overhedge ] || continue ;; *) [ $kind = official ] || continue ;; esac
    list+=("$(ver_of "$n")|$f")
  done
  [ ${#list[@]} -gt 0 ] || continue
  # newest first (dpkg version order)
  mapfile -t sorted < <(printf '%s\n' "${list[@]}" | while IFS='|' read -r v f; do echo "$v|$f"; done \
    | sort -t'|' -k1,1 -V -r)
  kept=0
  for e in "${sorted[@]}"; do
    f=${e#*|}; n=$(basename "$f")
    if is_protected "$n"; then echo "keep (protected) $f"; continue; fi
    if [ $kept -lt "$KEEP_BUILDS" ]; then kept=$((kept+1)); echo "keep $f"; continue; fi
    rmv "$f" "$f.sha256"
  done
done
if [ "$dry" = 0 ]; then
  for d in "$A" "$A/old" "$A/rollback"; do
    [ -d "$d" ] || continue
    (cd "$d" && if ls ./*.deb >/dev/null 2>&1; then sha256sum ./*.deb | sed 's# \./# #' > SHA256SUMS; fi)
  done
fi
echo "== mac zips"
if [ -d "$A/mac" ]; then
  find "$A/mac" -maxdepth 1 -name '*.zip' -printf '%T@ %p\n' | sort -rn | awk -v k="$KEEP_BUILDS" 'NR>k {print $2}' | while read -r z; do rmv "$z" "$z.sha256"; done
  [ "$dry" = 1 ] || (cd "$A/mac" && if ls ./*.zip >/dev/null 2>&1; then sha256sum ./*.zip | sed 's# \./# #' > SHA256SUMS; fi)
fi
echo "== Linux AppImages"
if [ -d "$A/linux" ]; then
  find "$A/linux" -maxdepth 1 -name '*.AppImage' -printf '%T@ %p\n' | sort -rn | awk -v k="$KEEP_BUILDS" 'NR>k {print $2}' | while read -r z; do rmv "$z" "$z.sha256"; done
  [ "$dry" = 1 ] || (cd "$A/linux" && if ls ./*.AppImage >/dev/null 2>&1; then sha256sum ./*.AppImage | sed 's# \./# #' > SHA256SUMS; fi)
fi
echo "== backups"
lastbk=$(cat "$OVH_HOME/last-backup-path" 2>/dev/null || true)
find "$OVH_HOME" -maxdepth 1 -name 'backup-*' -type d -printf '%T@ %p\n' | sort -rn | awk -v k="$KEEP_BACKUPS" 'NR>k {print $2}' | while read -r b; do
  [ "$b" = "$lastbk" ] && { echo "keep (last backup) $b"; continue; }
  rmv "$b"
done
echo "== port worktrees"
F=$OVH_HOME/fork
if [ -d "$F/.git" ]; then
  mapfile -t trees < <(git -C "$F" worktree list --porcelain | sed -n 's/^worktree //p' | grep -E '/(rehearsal-)?(base|patch|port)-[0-9.]+$' || true)
  ids=$(printf '%s\n' "${trees[@]}" | sed -E 's#.*-([0-9.]+)$#\1#' | sort -V -r -u)
  keep_ids=$(echo "$ids" | head -n "$KEEP_PORT_TREES")
  for t in "${trees[@]}"; do
    id=$(sed -E 's#.*-([0-9.]+)$#\1#' <<<"$t")
    if grep -qx "$id" <<<"$keep_ids"; then echo "keep $t"; continue; fi
    if [ "$dry" = 1 ]; then echo "DRY-RUN: git worktree remove --force $t"; else git -C "$F" worktree remove --force "$t" && echo "removed worktree $t"; fi
  done
  [ "$dry" = 1 ] || git -C "$F" worktree prune
fi
for d in "$OVH_HOME"/base-* "$OVH_HOME"/patch-* "$OVH_HOME"/overhedge-*; do
  [ -d "$d" ] && [ -d "$d/.git" ] && echo "legacy standalone clone (not removed): $d ($(du -sh "$d" 2>/dev/null | cut -f1))"
done
echo "== old smoke runs and logs"
find "$OVH_HOME/smoke" -mindepth 1 -maxdepth 1 -type d -mtime +30 2>/dev/null | while read -r s; do rmv "$s"; done
find "$OVH_LOGS" -maxdepth 1 -type f -mtime +90 2>/dev/null | while read -r s; do rmv "$s"; done
rmv "$OVH_HOME/dl/ci" "$OVH_HOME/dl/off" "$OVH_HOME/dl/mac" "$OVH_HOME/dl/linux" "$OVH_HOME/scratch/static-compare"
echo "free: $(ovh_free_gb)G"
