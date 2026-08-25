#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <claude|codex|project>" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$(cd "$script_dir/.." && pwd)/skills"

case "$1" in
  claude)
    destination="${HOME}/.claude/skills"
    ;;
  codex)
    destination="${CODEX_HOME:-${HOME}/.codex}/skills"
    ;;
  project)
    destination=".claude/skills"
    ;;
  *)
    echo "Usage: $0 <claude|codex|project>" >&2
    exit 1
    ;;
esac

mkdir -p "$destination"

for skill_dir in "$source_dir"/*; do
  skill_name="$(basename "$skill_dir")"
  target="$destination/$skill_name"
  if [[ -e "$target" ]]; then
    echo "Refusing to overwrite existing skill: $target" >&2
    exit 1
  fi
  cp -R "$skill_dir" "$target"
  echo "Installed $skill_name -> $target"
done
