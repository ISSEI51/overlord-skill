# Overlord — 人間と AI エージェントの共通入口
#
#   just              レシピ一覧
#   just test         テスト一式
#   just ci           CI 相当を並列実行
#
# このリポジトリは Docker を使わないため、compose のホストポート環境変数化は対象外。
# Console のポートは OVERLORD_PORT か `--port` で変更できる（console/src/server.ts:34）。
# worktree は Overlord 自身が scripts/change.sh 経由で .overlord/worktrees/ に作るため、
# ここでは作成・削除を提供しない（二重管理を避ける）。参照は just worktrees。

set shell := ["bash", "-c"]
set dotenv-load := true
set dotenv-filename := ".env"
set dotenv-required := false

default:
    @just --list --unsorted

# ── 開発 ──────────────────────────────────────────────────────────

# 依存をインストールする（依存を持つのは console/frontend だけ）
install:
    bun install --cwd console/frontend

# Overlord Console を起動する（例: just console ~/dev/your-project 7400）
console target="." port="":
    #!/usr/bin/env bash
    set -euo pipefail
    args=("{{target}}")
    if [ -n "{{port}}" ]; then args+=(--port "{{port}}"); fi
    ./scripts/console.sh "${args[@]}"

# frontend の開発サーバーを起動する
dev:
    bun run --cwd console/frontend dev

# frontend をビルドする（tsc --noEmit を含む）
build:
    bun run --cwd console/frontend build

# ── 検査 ──────────────────────────────────────────────────────────

# console のテスト一式
test:
    bun test console/src/

# テストを1つだけ（例: just test-one console/src/board.test.ts）
test-one target:
    bun test {{target}}

# frontend の型チェック
typecheck:
    bun run --cwd console/frontend typecheck

# CI 相当（console テスト / frontend 型チェック）を並列実行して結果をまとめる
ci:
    #!/usr/bin/env bash
    set -uo pipefail
    # CI の frontend ジョブと同じく install から始める。クリーンなクローンでも通るようにする。
    bun install --frozen-lockfile --cwd console/frontend >/dev/null || {
      echo "FAIL frontend (bun install --frozen-lockfile)"; exit 1; }
    tmp=$(mktemp -d)
    just test  >"$tmp/console.log"  2>&1 & p1=$!
    just build >"$tmp/frontend.log" 2>&1 & p2=$!
    st_console=ok;  wait $p1 || st_console=fail
    st_frontend=ok; wait $p2 || st_frontend=fail
    fail=0
    for n in console frontend; do
      eval "st=\$st_$n"
      echo "──────── $n ($st) ────────"
      # 失敗したジョブは切り詰めない。原因が tail に入らないことがあるため。
      if [ "$st" = fail ]; then cat "$tmp/$n.log"; fail=1; else tail -6 "$tmp/$n.log"; fi
    done
    if [ "$fail" -eq 0 ]; then rm -rf "$tmp"; else echo; echo "ログ: $tmp"; fi
    exit $fail

# ── 参照 ──────────────────────────────────────────────────────────

# Overlord が管理している worktree を一覧する（作成・削除は scripts/change.sh）
worktrees:
    @git worktree list

# board.yaml の場所と件数を表示する
board:
    #!/usr/bin/env bash
    set -euo pipefail
    path="${OVERLORD_BOARD:-docs/product-ops/board.yaml}"
    # console/src/board.ts の boardPathFor と同じ正規化。.yaml/.yml でなければ
    # ディレクトリとみなして既定のボードパスを足す。
    case "$path" in
      *.yaml|*.yml) ;;
      *) path="$path/docs/product-ops/board.yaml" ;;
    esac
    if [ ! -f "$path" ]; then
      echo "board が見つかりません: $path"
      echo "テンプレート: docs/product-ops/board.example.yaml"
      exit 1
    fi
    # items: 配下だけを数える。decisions_required: の要素も同じ字下げのため、
    # 素朴な grep では両方に一致してしまう。
    cards=$(awk '/^items:/{i=1;next} /^[a-zA-Z_]+:/{i=0} i&&/^  - id:/{n++} END{print n+0}' "$path")
    echo "board: $path"
    echo "cards: $cards"
