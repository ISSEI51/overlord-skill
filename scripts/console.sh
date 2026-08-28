#!/usr/bin/env bash
set -euo pipefail

# Overlord Console launcher.
#
#   scripts/console.sh                      対象は現在のディレクトリ
#   scripts/console.sh /path/to/project     対象プロジェクトを指定
#   scripts/console.sh --port 7400 --open   ポート指定と cmux のブラウザペインで表示
#
#   scripts/console.sh ensure [/path/to/project] [--port 7400] [--open]
#     起動済みなら何も起動せず URL を出力する。未起動なら board.yaml を用意して
#     サーバーを起動し、cmux が使えるときは司令塔も登録する。ブラウザは開かない。
#     第1引数の ensure は必ずサブコマンドとして解釈される。ensure という名前の
#     ディレクトリを対象にするときは ./ensure と書く。

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
console_dir="$(cd "$script_dir/.." && pwd)/console"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun が見つかりません。次のいずれかでインストールしてください。" >&2
  echo "  brew install oven-sh/bun/bun" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

if [[ ${1:-} == "ensure" ]]; then
  shift
  exec bun run "$console_dir/src/ensure.ts" "$@"
fi

if [[ $# -eq 0 ]]; then
  set -- "$PWD"
fi

exec bun run "$console_dir/src/server.ts" "$@"
