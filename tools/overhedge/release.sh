#!/usr/bin/env bash
# release.sh --deb <deb> [--mac <zip>] [--appimage <AppImage>] [--notes <file>] [--dry-run]
#
# Publishes a verified build as a GitHub Release of the fork (UPDATE-RUNBOOK.md 4.7, after
# promote.sh). Tag v<ver>-overhedge.<n>, where <ver>+overhedge.<n>.g<sha10> is the deb's version:
# the release number is the deb workflow's build number (the mac zip keeps its own workflow's
# counter in its file name; both come from the same commit, which is checked).
#  1. names: orca-ide_<ver>+overhedge.<n>.g<sha10>_amd64.deb,
#     Orca-<ver>_overhedge.<m>.g<sha10>-mac-arm64.zip, Orca-<ver>_overhedge.<k>.g<sha10>-linux-x86_64.AppImage
#     (same <ver> and <sha10> everywhere); updater metadata (*.yml, *.blockmap) is refused, so
#     nothing here can ever look like an update feed
#  2. each file's sha256 matches the SHA256SUMS next to it (fetch-and-verify.sh wrote them); the
#     deb is package orca-ide, amd64, version <ver>+overhedge.<n>.g<sha10>
#  3. the commit <sha10> is in origin/overhedge/main (promote first)
#  4. notes: generated header (upstream version, commit, previous release), the body from --notes
#     (user-facing: what changed since the previous release) or, without it, the commit subjects
#     since the previous release; generated footer (install guides, downloads, build numbers, OVERHEDGE.md link)
#  5. annotated tag pushed through the fork clone (pre-push guard), `gh release create --verify-tag
#     --latest` with the files + a SHA256SUMS of them; then checks the uploaded names and sizes
# --dry-run: does 1-4 and prints the tag, assets and notes; creates nothing.
# Idempotent: a tag + release that already exist for the same commit -> prints the URL, exit 0.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
deb=""; mac=""; img=""; notes=""; dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --deb) deb=$2; shift ;;
    --mac) mac=$2; shift ;;
    --appimage) img=$2; shift ;;
    --notes) notes=$2; shift ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$deb" ] || { sed -n '2,24p' "$0"; exit 2; }
R=$OVH_FORK_REPO; F=$OVH_HOME/fork; M=$OVH_MAIN_BRANCH
fail() { echo "FAIL $*" >&2; exit 1; }

# 1. names
dn=$(basename "$deb")
[[ "$dn" =~ ^orca-ide_([0-9]+\.[0-9]+\.[0-9]+)\+overhedge\.([0-9]+)\.g([0-9a-f]{10})_amd64\.deb$ ]] || fail "deb name $dn"
ver=${BASH_REMATCH[1]}; n=${BASH_REMATCH[2]}; sha10=${BASH_REMATCH[3]}
mac_n=""
if [ -n "$mac" ]; then
  [[ "$(basename "$mac")" =~ ^Orca-${ver//./\\.}_overhedge\.([0-9]+)\.g${sha10}-mac-arm64\.zip$ ]] || fail "mac zip $(basename "$mac") is not $ver / g$sha10"
  mac_n=${BASH_REMATCH[1]}
fi
if [ -n "$img" ]; then
  [[ "$(basename "$img")" =~ ^Orca-${ver//./\\.}_overhedge\.[0-9]+\.g${sha10}-linux-x86_64\.AppImage$ ]] || fail "AppImage $(basename "$img") is not $ver / g$sha10"
fi
assets=("$deb"); [ -z "$mac" ] || assets+=("$mac"); [ -z "$img" ] || assets+=("$img")
for a in "${assets[@]}"; do
  case "$(basename "$a")" in *.yml|*.yaml|*.blockmap|latest*) fail "$(basename "$a"): updater metadata is never published" ;; esac
done

# 2. checksums and package fields
for a in "${assets[@]}"; do
  [ -f "$a" ] || fail "missing $a"
  sums=$(dirname "$a")/SHA256SUMS; b=$(basename "$a")
  want=$(awk -v f="$b" '$2 == f || $2 == "*" f {print $1}' "$sums" 2>/dev/null | head -1)
  [ -n "$want" ] || fail "$b is not listed in $sums"
  got=$(sha256sum "$a" | awk '{print $1}')
  [ "$want" = "$got" ] || fail "$b sha256 $got does not match $sums ($want)"
  echo "OK sha256 $b ${got:0:16}"
done
[ "$(dpkg-deb -f "$deb" Package)" = "$OVH_PKG" ] || fail "deb package is not $OVH_PKG"
[ "$(dpkg-deb -f "$deb" Architecture)" = amd64 ] || fail "deb architecture"
[ "$(dpkg-deb -f "$deb" Version)" = "$ver+overhedge.$n.g$sha10" ] || fail "deb control Version $(dpkg-deb -f "$deb" Version)"
echo "OK deb control $ver+overhedge.$n.g$sha10"

# 3. commit
git -C "$F" fetch -q --prune origin
ovh_fetch_port_tags "$F"
git -C "$F" fetch -q origin "+refs/tags/v*:refs/tags/v*" 2>/dev/null || true
git -C "$F" fetch -q upstream "refs/tags/v$ver:refs/tags/v$ver"
sha=$(git -C "$F" rev-parse -q --verify "$sha10^{commit}") || fail "commit $sha10 not in $F"
git -C "$F" merge-base --is-ancestor "$sha" "refs/remotes/origin/$M" || fail "$sha10 is not in origin/$M (run promote.sh first)"
echo "OK commit $sha is in origin/$M"
tag=$(ovh_release_tag "$ver" "$n")
if have=$(git -C "$F" rev-parse -q --verify "refs/tags/$tag^{commit}"); then
  [ "$have" = "$sha" ] || fail "tag $tag already exists at $have"
  if url=$(gh release view "$tag" -R "$R" --json url --jq .url 2>/dev/null); then echo "already released: $url"; exit 0; fi
fi

# 4. notes
prev=$(gh release list -R "$R" -L 100 --json tagName,isDraft --jq '.[] | select(.isDraft | not) | .tagName' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-overhedge\.[0-9]+$' | grep -vx "$tag" | sort -V | tail -1 || true)
W=$(mktemp -d "${TMPDIR:-/tmp}/ovh-release.XXXXXX"); trap 'rm -rf "$W"' EXIT
nf=$W/notes.md
{
  echo "Orca **$ver** (upstream [v$ver](https://github.com/$OVH_UPSTREAM_REPO/releases/tag/v$ver)) with the Overhedge patch, build $n, commit [\`$sha10\`](https://github.com/$R/commit/$sha)."
  echo
  if [ -n "$notes" ]; then
    cat "$notes"
  else
    if [ -n "$prev" ]; then
      git -C "$F" fetch -q origin "refs/tags/$prev:refs/tags/$prev" 2>/dev/null || true
      echo "## Changes since $prev"; echo
      git -C "$F" log --no-merges --format='- %s' "$prev..$sha" "^v$ver" | grep -v '^- release: ' | head -60
    else
      echo "## What the patch adds"; echo
      echo "See [OVERHEDGE.md](https://github.com/$R/blob/$tag/OVERHEDGE.md)."
    fi
  fi
  echo
  ig="https://github.com/$R/blob/$M/docs/overhedge/install"
  echo "## Install"
  echo
  echo "Step-by-step guides with checksum check, update, rollback and troubleshooting ([English]($ig/README.md), [українською]($ig/README.uk.md)): [macOS]($ig/macos.md), [Linux desktop]($ig/linux-desktop.md), [server]($ig/server.md), [ClickUp plugin]($ig/clickup-plugin.md). Updates come only from this fork's Releases page, never from Orca's official update channel."
  echo
  echo "## Downloads"
  echo
  echo "| File | What |"
  echo "|---|---|"
  echo "| \`$dn\` | Server package \`$OVH_PKG\` (amd64); installs over the official package of the same version |"
  [ -z "$mac" ] || echo "| \`$(basename "$mac")\` | macOS app, Apple silicon; ad-hoc signed, not notarized: install as described in the [macOS guide]($ig/macos.md) |"
  [ -z "$img" ] || echo "| \`$(basename "$img")\` | Linux desktop app, x86_64 AppImage |"
  echo "| \`SHA256SUMS\` | sha256 of the files above |"
  echo
  mac_note=""
  [ -z "$mac_n" ] || mac_note=" The mac zip carries the build counter of its own workflow ($mac_n)."
  echo "Release number = the deb's build number (\`+overhedge.$n\`).$mac_note All files are built by this fork's CI from \`$sha10\`."
  echo
  echo "This is not an official Orca release. Orca's built-in updater only reads stablyai/orca and never this repository; no updater metadata (\`latest*.yml\`) is published here."
  echo
  echo "What the patch does, how it is ported and rolled back: [OVERHEDGE.md](https://github.com/$R/blob/$tag/OVERHEDGE.md)."
} > "$nf"
for a in "${assets[@]}"; do sha256sum "$a" | awk -v f="$(basename "$a")" '{print $1 "  " f}'; done > "$W/SHA256SUMS"

echo "TAG=$tag"
echo "COMMIT=$sha"
echo "PREVIOUS=${prev:-none}"
for a in "${assets[@]}" "$W/SHA256SUMS"; do echo "ASSET=$(basename "$a") $(stat -c %s "$a") bytes"; done
echo "----- notes"; cat "$nf"; echo "-----"
echo "----- SHA256SUMS"; cat "$W/SHA256SUMS"; echo "-----"
if [ "$dry" = 1 ]; then echo "DRY-RUN: would tag $tag at $sha, push it, and create the release (latest) with ${#assets[@]} files + SHA256SUMS"; exit 0; fi

# 5. publish
if [ -z "${have:-}" ]; then
  git -C "$F" tag -a "$tag" "$sha" -m "Orca $ver with the Overhedge patch, build $n ($sha10)"
  git -C "$F" push origin "refs/tags/$tag"
fi
gh release create "$tag" -R "$R" --verify-tag --latest --title "Orca $ver + Overhedge (build $n)" \
  --notes-file "$nf" "${assets[@]}" "$W/SHA256SUMS"
up=$(gh release view "$tag" -R "$R" --json assets --jq '.assets[] | "\(.name) \(.size)"' | sort)
exp=$(for a in "${assets[@]}" "$W/SHA256SUMS"; do echo "$(basename "$a") $(stat -c %s "$a")"; done | sort)
[ "$up" = "$exp" ] || { echo "uploaded assets differ:"; diff <(echo "$exp") <(echo "$up") || true; fail "asset check"; }
echo "OK uploaded assets match (names and sizes)"
echo "RELEASE_URL=$(gh release view "$tag" -R "$R" --json url --jq .url)"
