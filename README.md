# Overlord

[日本語](README.md) | [English](README.en.md) · [MIT License](LICENSE)

## あなたは Overlord だ。重要な判断は、あなたが下す。

調査、実装前整理、実装、レビュー、進捗管理は AI に任せる。あなたは優先順位、方向性、最終判断に思考を使う。

Overlord は、Claude Code や Codex のコーディングエージェントを1人のコーダーではなく「開発チーム」として動かすための管理レイヤーです。1変更 = 1 worktree = 1 branch = 1 PR = 1 エージェント実行にそろえ、複数の作業を並行して進めながら、あなたの手元に残る操作を「決めること」だけにします。

![Overlord Console](docs/images/console-board.jpg)

## 主な特徴

- **決めることだけが残る** — 「今日の判断」バーには最大3件しか出ません。水色枠はあなたの操作待ち、黄色枠は AI が作業中。見る場所はこの2つだけです
- **AI をチームとして動かす** — あなたが会話するのは司令塔セッション1つだけ。カードごとの調査・実装前整理・実装・レビューは、司令塔がサブエージェントを起動して進めます
- **PR 単位で並行して進む** — 1変更 = 1 worktree = 1 branch = 1 PR = 1 エージェント実行。大きな仕事はカードを増やさずに変更へ分割します
- **実装した AI に自分の変更を承認させない** — 独立レビューは実装とは別のサブエージェントが担当します。レビュー済みの commit が PR の先頭と食い違うときは `sync` が警告を出します。その変更を完成確認待ちに上げないことは、スキルの規則として定めています
- **状態は1ファイルに集約** — AI が読み書きする管理情報は `docs/product-ops/board.yaml` だけで、あなたはブラウザのカンバンで見ます。書き込みは楽観ロックで保護されます
- **ローカルで完結** — コンソールは `127.0.0.1` だけで待ち受け、loopback 以外の `Host` / `Origin` を拒否します

## Quick Start

必要なもの:

- [Claude Code](https://claude.com/claude-code)（または Codex）
- [Bun](https://bun.sh) — Overlord Console の実行に必要です
- `git` と [GitHub CLI](https://cli.github.com/)（`gh`）— `scripts/change.sh` の `pr` / `sync` / `deliver` は `git` と `gh` を直接起動します（`gh pr create` / `gh pr list` / `gh pr view` / `gh pr edit` / `gh repo view`）。`gh auth login` で認証済みである必要があります
- [cmux](https://cmux.com/ja) — macOS 用のターミナルです。司令塔サイドバーとカードの指示ボタンに必要です

動作環境: コンソールとスキルは macOS 固有の処理を持たないため、Bun が動く環境（macOS / Linux）で動作します。cmux は macOS アプリで、コンソールは `cmux` コマンドが PATH に無いときは `/Applications/cmux.app/Contents/Resources/bin/cmux` を参照します。cmux が使えない環境でも、カンバンの閲覧・編集、「気づきを追加」、`scripts/change.sh` の各コマンドは動きます。使えないのは司令塔サイドバーとカードの指示ボタン、および `console.sh --open` です。

1. **スキルをインストールする**

   ```bash
   git clone https://github.com/ISSEI51/overlord-skill.git
   cd overlord-skill
   ./scripts/install.sh claude          # Codex 向けは ./scripts/install.sh codex
   ```

2. **管理したいプロジェクトを指定してコンソールを起動する**

   ```bash
   ./scripts/console.sh ~/dev/your-project
   ```

   起動すると待ち受けアドレス（既定は `http://127.0.0.1:7377`）が表示されます。ブラウザで開いてください。

3. **司令塔を用意する** — 画面右のサイドバー（初回は開いています。閉じているときはトップバーのアイコンまたは **⌘B** で開きます）で「司令塔を新しく起動」を押し、対象プロジェクトのディレクトリを入力して「起動」。Claude Code が動く cmux ワークスペースが作られ、司令塔として登録され、入力欄に最初の指示が入ります。そのまま「送信」を押すと、司令塔が `docs/product-ops/board.yaml` を読み（無ければ作り）、今日の状況を返します。

4. **1件試す** — トップバーの「気づきを追加」で気づきを1行書くと、受信箱にカードができます。カードを開いて「進める」を押すと、司令塔がそのカードの状態に必要な作業をサブエージェントに割り当てます。

以降は、水色枠のカードと「今日の判断」だけを見て、承認と受け入れを決めます。

## 構成

```text
気づき -> やることカード -> 順番を決める -> 実装前メモ -> 実装 -> 別のAIが確認 -> 完成の確認
                 |                                                    |
                 +---------- docs/product-ops/board.yaml ------------+
                                      |
                                      +-> Overlord Console (ブラウザ)
                                                   |
                                                   +-> 司令塔 (cmux) -> 各カードのサブエージェント
```

| 要素 | 役割 |
| --- | --- |
| スキル5種 | AIの作業手順（下記） |
| `docs/product-ops/board.yaml` | AIが読み書きする管理情報の唯一の置き場 |
| Overlord Console | 管理ファイルをブラウザで表示・操作するダッシュボード |
| 司令塔 | あなたが会話する唯一の cmux セッション。各カードの作業はここからサブエージェントに割り振られる |

### カード・変更・タスク

board は3階層で構成され、**あなたが管理するのは一番上のカードだけ**です。

| 階層 | 意味 | 見える場所 |
| --- | --- | --- |
| **カード** | 1つのプロダクト成果。人間の意思決定単位 | Kanban のカード |
| **変更** | 1つの実装単位。1変更 = 1 worktree = 1 branch = 1 PR = 1 エージェント実行単位 | カード詳細の「変更（PR単位）」（読み取り専用） |
| **タスク** | エージェント内部の手順 | 表示しない |

1つの変更は PR 単位で進みます。`start`（worktree とブランチを作る）→ 実装 → `pr`（push して PR を作る）→ 別のAIによるレビュー → `reviewed`（レビューした commit を記録）→ マージ → `sync`（PR の状態を board に反映）。この各段階は `scripts/change.sh` が実行し、board への記録も合わせて行うため、手で書き換える必要はありません。レビュー済みの commit と PR の先頭が食い違うときは `sync` が警告を出します。その変更を完成確認待ちに上げないことは、スキルの規則として定めています。

作業が大きいときは**変更**に分割します。ファイル数が多い、バックエンドとフロントに分かれる、マイグレーションがある、PRを小さくしたい — これらはすべて変更への分割で解決し、**カードは増えません**。

新しいカードを作るのは、独立して優先順位を決められる・片方だけリリースや中止ができる・独自の完成条件を持つ、といった**別のプロダクト成果**になる場合だけです。

## 含まれるスキル

| Skill | 用途 |
| --- | --- |
| `overlord-ops` | 何を先に進めるかと、AIの作業状況を整理する |
| `overlord-improvement-card` | 気づきや問い合わせを、実行できる「やることカード」にする |
| `overlord-ux-audit` | 実際の操作の流れをたどり、使いにくい所を見つける |
| `overlord-implementation-brief` | 実装前に、何をどこまで変えるかを小さく整理する |
| `overlord-change-review` | 実装したAIとは別のAIが、目的どおり動くかを確認する |

## Overlord Console

React + shadcn/ui 製のローカルダッシュボードです。`board.yaml` の変更は自動で画面に反映されます。

### ボード

- 8列のカンバン（受信箱 / 調査中 / 実装準備完了 / 実装中 / 確認中 / 完成確認待ち / 完了 / 停止中）。ドラッグ&ドロップで移動できます
- **水色枠** = あなたのアクションが必要なカード（完成確認待ち、担当があなた、今日の判断に掲載）
- **黄色枠** = AIが作業中のカード
- 「今日の判断」バーには、あなたが決める必要があることだけが最大3件表示されます
- 完了カードは右クリックから削除できます

### カードのモーダル

![カードのモーダル](docs/images/card-modal.jpg)

カードをクリックすると中央にモーダルが開きます。

- **指示ボタン**（状況を聞く / 進める / 実装ブリーフ / 独立レビュー / 完了の可否）: 1回押すだけで司令塔へ直接送信されます。スキルのコマンド文は画面に出ません
- **詳細指示**: 自由文で書いた指示が、カードIDを添えて司令塔へ送られます
- **受け入れて完了**: 完成確認待ちのカードに表示され、1クリックで完了になります
- 状態・次にすること・担当・止まっている理由はその場で編集できます（Escape で取り消し）

### 司令塔サイドバー

画面右のサイドバーが司令塔（あなたが会話する cmux セッション）です。

- トップバーのアイコンまたは **⌘B** で開閉。開閉状態は保存されます
- 端末ミラーは司令塔の活動に反応してほぼ即時に更新されます（イベント駆動 + 10秒の安全網。cmux とはソケット直結で子プロセスを起動しません）
- 「過去の出力を読む」で履歴（最大2000行）を遡れます。閲覧中は更新が止まり、「追従を再開」で戻ります
- 定型ボタン（今日の状況 / 作業を割り当て / 気づきをカードに / ボード更新）と自由入力欄、キー操作（Enter / Esc / ↑ / ↓ / 中断）を備えます
- サイドバーが勝手に開くことはありません。開閉は常にあなたの操作です

## インストール

### スキル（Claude Code）

```bash
git clone https://github.com/ISSEI51/overlord-skill.git
cd overlord-skill
./scripts/install.sh claude      # 個人用 (~/.claude/skills)
# プロジェクト単位なら対象リポジトリで: /path/to/overlord/scripts/install.sh project
```

Codex 向けは `./scripts/install.sh codex` です。同名スキルがある場合、インストーラーは安全のため停止します。

### 旧スキル（`product-*`）の削除

スキル名を `product-*` から `overlord-*` に変更したため、旧名でインストール済みのスキルは手動で削除してください。削除しないと旧スキルが残り続けます。`scripts/install.sh` は `cp -R` でコピーするため、インストーラーで導入した場合は実体コピー5件です。手動で symlink を張っていた場合はリンク切れの symlink 5本になります。

実体コピーが残っていると、旧 `/product-ops` などが旧内容のまま動作し続けます。説明文がほぼ同じスキルが新旧あわせて10件並ぶため、削除するまでは意図しない方が選ばれることがあります。

```bash
# 削除対象を先に確認する
ls -l ~/.claude/skills | grep product-
ls -l ~/.codex/skills | grep product-

# Claude Code
rm -rf ~/.claude/skills/product-ops \
       ~/.claude/skills/product-improvement-card \
       ~/.claude/skills/product-ux-audit \
       ~/.claude/skills/product-implementation-brief \
       ~/.claude/skills/product-change-review

# Codex
rm -rf ~/.codex/skills/product-ops \
       ~/.codex/skills/product-improvement-card \
       ~/.codex/skills/product-ux-audit \
       ~/.codex/skills/product-implementation-brief \
       ~/.codex/skills/product-change-review
```

`rm -rf` は symlink に対してはリンク自体だけを削除し、リンク先には影響しません。プロジェクト単位でインストールしている場合は、対象リポジトリの `.claude/skills/product-*` も同じ手順で削除してください。

スキルはセッションの開始時に読み込まれます。削除したら Claude Code / Codex のセッションを起動し直してください。

### コンソール

[Bun](https://bun.sh) が必要です。ビルド済みのフロントエンドを同梱しているため、そのまま起動できます。

```bash
brew install oven-sh/bun/bun     # まだ入っていない場合
/path/to/overlord/scripts/console.sh ~/dev/your-project
```

`http://127.0.0.1:7377` で開きます。ポートは `--port 7400`、cmux のブラウザペインで開くなら `--open` を付けます。

フロントエンドを変更した場合は `cd console/frontend && bun install` で依存を入れたうえで、`cd console && bun run build` を実行し `console/public` を再生成します。

サーバーは `127.0.0.1` だけで待ち受け、`Host` / `Origin` が loopback でない要求は拒否します。

## 初期化

サイドバーの「司令塔を新しく起動」を使わず、自分で起動した Claude Code を司令塔にすることもできます。対象リポジトリのルートで Claude Code を起動し、次を実行します。

```text
/overlord-ops
このプロジェクトの作業管理を始めてください。
コード、今ある説明、プロジェクトの決まりを確認し、
docs/product-ops/board.yaml を作成してください。
最初に私が決めることは最大3件にしてください。
```

別のターミナルでコンソールを起動し、サイドバーの「変更」からこの Claude Code セッションを司令塔として登録します（司令塔側から `cmux identify --json --id-format both` で自分の ID を読み、board の `commander` に書き込む方法もあります）。

リポジトリのマージ方式の設定については、[なぜ merge commit なのか](#なぜ-merge-commit-なのか)を参照してください。

## 日常の使い方

1. **気づきを残す**: トップバーの「気づきを追加」、またはサイドバーの「気づきをカードに」
2. **進める**: カードを開いて「進める」を1回押す。司令塔が状態に応じた作業（カード化 → ブリーフ → 実装 → 独立レビュー）をサブエージェントで進めます
3. **決める**: 「今日の判断」と水色枠のカードだけ見れば足ります。実装ブリーフの承認や完成の受け入れはカードのボタンで完結します
4. **受け入れる**: 完成確認待ちのカードを確認し、「受け入れて完了」。溜まった完了カードは右クリックで削除

## 運用の決まり

- 同時に実装するのは最大3件。AIが抱える作業は10件前後まで（超えるとトップバーに警告が出ます）
- 1リポジトリ1 `board.yaml` が原則です。複数リポジトリはコンソールを別ポートで並行起動してください
- コンソールはあなたが見る画面であり、AIは常に `board.yaml` を読んで作業します。書き込みは楽観ロックで保護され、AIの更新が黙って上書きされることはありません
- 実装したAIに自分の変更を最終確認させないため、独立レビューは別のサブエージェントが行います
- main 向けのPR（カードの配送PR）は **merge commit** でマージします。squash と rebase は使いません

### なぜ merge commit なのか

squash は main に新しいコミットを1つ作ります。作業ブランチ側の元のコミットは main の履歴に入らないため、内容が同じでもマージ後に merge-base が前進しません。この状態で、main の squash コミットが変更した行、またはその近傍の行を作業ブランチが再度変更すると、次の main 向けPRがその行で競合します。実際に PR #10 がこの経路で競合し、手作業で解消しました。

squash を使うと**必ず**競合するわけではありません。両側の差分が同じ内容なら git は解決できます。競合するのは、squash が変更した行と重なる範囲を作業ブランチが再度書き換えた場合です。同じファイルでも変更行が十分に離れていれば git は自動で解決します。ただし `.gitignore` や `console/src/board.ts`、`docs/product-ops/board.yaml` のように繰り返し変更するファイルでは、squash を続ける限り再発します。

merge commit なら配送のたびに merge-base が前進するため、この分岐そのものが起きません。

PR #10 も squash でマージされたため、この分岐は現時点でまだ残っています。次の main 向けPRを merge commit でマージすると解消されます。

この決まりは main 向けのPRについてのものです。変更（change）単位のPRは作業ブランチに向けたもので、ここでは対象外です。

現在の設定は次で確認できます。

```bash
gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
```

merge commit だけを許可する設定は、GitHub の Settings > General > Pull Requests でチェックボックスを操作するか、次のコマンドで行います。

```bash
gh repo edit --enable-merge-commit=true --enable-squash-merge=false --enable-rebase-merge=false
```

この設定はリポジトリごとに手動で行います。設定していない間は、マージ画面で merge commit を選ぶ運用で担保してください。Overlord を新しいリポジトリで使い始めるときも、同じ設定にしてください。
