#!/usr/bin/env bash
set -euo pipefail

# Overlord Console launcher.
#
#   scripts/console.sh                      対象は現在のディレクトリ
#   scripts/console.sh /path/to/project     対象プロジェクトを指定
#   scripts/console.sh --port 7400 --open   ポート指定と cmux のブラウザペインで表示

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
console_dir="$(cd "$script_dir/.." && pwd)/console"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun が見つかりません。次のいずれかでインストールしてください。" >&2
  echo "  brew install oven-sh/bun/bun" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- "$PWD"
fi

exec bun run "$console_dir/src/server.ts" "$@"
