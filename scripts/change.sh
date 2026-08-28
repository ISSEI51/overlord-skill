#!/usr/bin/env bash
set -euo pipefail

# Overlord change launcher.
#
#   scripts/change.sh start OV-103-C1                     現在のリポジトリの board を使う
#   scripts/change.sh start OV-103-C1 --board /path/board.yaml
#   scripts/change.sh start OV-103-C1 --base overlord-console

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
console_dir="$(cd "$script_dir/.." && pwd)/console"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun が見つかりません。次のいずれかでインストールしてください。" >&2
  echo "  brew install oven-sh/bun/bun" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

exec bun run "$console_dir/src/change.ts" "$@"
