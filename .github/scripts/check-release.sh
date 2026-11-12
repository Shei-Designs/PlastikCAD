#!/usr/bin/env bash
# Run when a release's builds have ended: says whether the release holds every platform's files, and writes
# what is missing at the top of the release's own notes, where it is read before publishing.
#
# Version 0.2.0 was published without its Linux packages: that one build had failed, the run was red, and the
# draft looked like any other. A draft that says "do not publish" is harder to miss.
#
#   check-release.sh <release id> [--look]     --look only reports, and changes nothing
set -euo pipefail

id="$1"
look="${2:-}"
repo="${GITHUB_REPOSITORY:?the repository, as owner/name}"
mark='> **Do not publish yet: this release is missing'

release=$(gh api "repos/$repo/releases/$id")
names=$(jq -r '.assets[].name' <<<"$release")
tag=$(jq -r '.tag_name' <<<"$release")

# The notes are changed with the tag said again beside them: GitHub takes a draft whose notes alone are sent for
# one without a tag, and names it "untagged-…". Published like that, the release makes a tag of that name and
# sits under it, and the version's own tag has no release (this happened to the draft of 0.2.2).
write_notes() {
  gh api -X PATCH "repos/$repo/releases/$id" -f tag_name="$tag" -f body="$1" --silent
  kept=$(gh api "repos/$repo/releases/$id" --jq .tag_name)
  if [ "$kept" != "$tag" ]; then
    echo "::error::The release's tag is now $kept, not $tag: set it back before publishing."
    exit 1
  fi
}

missing=()
need() { grep -Eq "$2" <<<"$names" || missing+=("$1"); }
need 'Windows installer (.exe)' '_x64-setup\.exe$'
need 'Windows installer (.msi)' '\.msi$'
need 'macOS, Apple Silicon (.dmg)' '_aarch64\.dmg$'
need 'macOS, Intel (.dmg)' '_x64\.dmg$'
need 'Linux AppImage' '\.AppImage$'
need 'Linux .deb' '\.deb$'
need 'Linux .rpm' '\.rpm$'
need 'the index of updates (latest.json)' '^latest\.json$'

# What an installed app is offered: every platform that updates itself has to be in the index.
index=$(jq -r '.assets[] | select(.name == "latest.json") | .id' <<<"$release")
if [ -n "$index" ]; then
  platforms=$(gh api -H 'Accept: application/octet-stream' "repos/$repo/releases/assets/$index" | jq -r '.platforms | keys[]')
  for platform in linux-x86_64 windows-x86_64 darwin-aarch64 darwin-x86_64; do
    grep -qx "$platform" <<<"$platforms" || missing+=("updates for $platform")
  done
fi

# The notes without a warning an earlier run left.
body=$(jq -r '.body // ""' <<<"$release" | awk -v mark="$mark" 'index($0, mark) == 1 { skip = 1; next } skip && $0 == "" { skip = 0; next } { skip = 0; print }')

if [ ${#missing[@]} -eq 0 ]; then
  echo "The release holds every platform's files."
  [ "$look" = "--look" ] || write_notes "$body"
  exit 0
fi

list=$(printf '%s, ' "${missing[@]}")
list=${list%, }
echo "::error::The release is missing: $list"
if [ "$look" != "--look" ]; then
  write_notes "$mark: $list.** Run the failed build again first.

$body"
fi
exit 1
