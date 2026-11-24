#!/usr/bin/env bash
# static-compare.sh <patched.deb> <official-version>
#
# Unpacks the patched deb and the official orca-ide_<ver>_amd64.deb (from ~/overhedge-build/artifacts)
# into ~/overhedge-build/scratch and compares: control fields, maintainer scripts, top-level install
# paths, files only on one side, common files with different content.
# Exit 0: same top-level paths, same maintainer scripts, no file missing from the patched deb.
# Exit 1: something structural differs (read the output). The changed-content list is informational.
set -uo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
[ $# -eq 2 ] || { sed -n '2,10p' "$0"; exit 2; }
P=$(readlink -f "$1"); OFF=$OVH_ARTIFACTS/orca-ide_${2}_amd64.deb; S=$OVH_HOME/scratch/static-compare
[ -f "$P" ] && [ -f "$OFF" ] || { echo "missing $P or $OFF" >&2; exit 2; }
rm -rf "$S"; mkdir -p "$S"/{off,pat}/{root,ctl}
dpkg-deb -x "$OFF" "$S/off/root"; dpkg-deb -e "$OFF" "$S/off/ctl"
dpkg-deb -x "$P" "$S/pat/root"; dpkg-deb -e "$P" "$S/pat/ctl"
verdict=0
echo "== control diff (Version and Installed-Size are expected to differ)"
diff "$S/off/ctl/control" "$S/pat/ctl/control"
if diff <(grep -vE '^(Version|Installed-Size):' "$S/off/ctl/control") <(grep -vE '^(Version|Installed-Size):' "$S/pat/ctl/control") >/dev/null; then echo "other control fields identical"; else echo "OTHER CONTROL FIELDS DIFFER"; verdict=1; fi
echo "== maintainer scripts"
for f in preinst postinst prerm postrm; do
  if [ -e "$S/off/ctl/$f" ] || [ -e "$S/pat/ctl/$f" ]; then
    if diff -q "$S/off/ctl/$f" "$S/pat/ctl/$f" >/dev/null 2>&1; then echo "$f identical"; else echo "$f DIFFERS"; verdict=1; fi
  fi
done
echo "== top-level install paths"
(cd "$S/off/root" && find . -maxdepth 2 | sort) > "$S/off.top"; (cd "$S/pat/root" && find . -maxdepth 2 | sort) > "$S/pat.top"
if diff "$S/off.top" "$S/pat.top"; then echo same; else verdict=1; fi
(cd "$S/off/root" && find . -type f -o -type l | sort) > "$S/off.files"; (cd "$S/pat/root" && find . -type f -o -type l | sort) > "$S/pat.files"
only_off=$(comm -23 "$S/off.files" "$S/pat.files")
echo "== files only in official: $(printf '%s' "$only_off" | grep -c . )"; printf '%s\n' "$only_off" | head -40
# Bundlers rename hashed chunks; only a missing non-chunk file is structural.
printf '%s\n' "$only_off" | grep -vE '(chunk|-[A-Za-z0-9_-]{8}\.(js|css|mjs)|\.map)$' | grep -q . && { echo "NON-CHUNK FILES MISSING FROM THE PATCHED DEB"; verdict=1; }
echo "== files only in patched: $(comm -13 "$S/off.files" "$S/pat.files" | wc -l)"; comm -13 "$S/off.files" "$S/pat.files" | head -40
echo "== common files with different content"
comm -12 "$S/off.files" "$S/pat.files" | while read -r f; do cmp -s "$S/off/root/$f" "$S/pat/root/$f" || echo "$f $(stat -c%s "$S/off/root/$f") -> $(stat -c%s "$S/pat/root/$f")"; done > "$S/changed.txt"
wc -l < "$S/changed.txt"; head -60 "$S/changed.txt"
echo "== verdict: $([ $verdict = 0 ] && echo OK || echo REVIEW)"
rm -rf "$S/off/root" "$S/pat/root"
exit $verdict
