#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <claude|codex|project>" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
overlord_root="$(cd "$script_dir/.." && pwd)"
source_dir="$overlord_root/skills"

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
  # インストールされたスキルは scripts/ も console/ も持たないので、
  # Overlord チェックアウトの絶対パスを各スキル配下に記録しておく。
  # スキルからは次のように呼ぶ:
  #   "$(cat <skill-dir>/overlord-checkout)/scripts/console.sh" ensure <project>
  printf '%s\n' "$overlord_root" > "$target/overlord-checkout"
  echo "Installed $skill_name -> $target"
done

echo "Recorded overlord checkout: $overlord_root"
