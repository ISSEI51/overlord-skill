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
- `git` と [GitHub CLI](https://cli.github.com/)（`gh`）— `scripts/change.sh` は `git` と `gh` を直接起動します（`start` / `pr` / `reviewed` / `sync` / `merge` / `deliver` / `identity` の7つすべて）。`start` は `git worktree add` と `git rev-parse`、`pr` は `git push` と `gh pr list` / `gh pr create` / `gh pr view`、`reviewed` は `git worktree list` と worktree での `git rev-parse HEAD`（worktree が残っていない場合は `gh pr view --json headRefOid`）、`sync` は `gh pr view`、`merge` は `git rev-parse` / `git symbolic-ref` と `gh pr view` / `gh repo view` / `gh pr merge`、`deliver` は `git fetch` / `git diff` と `gh repo view` / `gh pr view` / `gh pr create` / `gh pr edit`、`identity` は `git rev-parse` / `git remote get-url` と `gh api user` / `gh repo view` を使います。`gh auth login` で認証済みである必要があります。`change.sh` は司令塔が自動で実行するコマンドで、あなたが直接打つ場面はありません
- [cmux](https://cmux.com/ja) — 複数の AI セッションを1画面のワークスペースとして扱う macOS 用のターミナルです。Overlord は司令塔セッションの画面の読み取りと入力の送信をこれ経由で行うため、司令塔サイドバーとカードの指示ボタンに必要です

動作環境: コンソールとスキルは macOS 固有の処理を持たないため、Bun が動く環境（macOS / Linux）で動作します。cmux は macOS アプリで、コンソールは `cmux` コマンドが PATH に無いときは `/Applications/cmux.app/Contents/Resources/bin/cmux` を参照します。cmux が使えない環境でも、カンバンの閲覧・編集、「気づきを追加」、`scripts/change.sh` の各コマンドは動きます。使えないのは司令塔サイドバーとカードの指示ボタン、`console.sh --open`、および `console.sh ensure` による司令塔の自動登録です（`ensure` のそれ以外の処理は cmux が無くても動き、サーバーは detached プロセスとして起動して出力を `<プロジェクト>/.overlord/console.log` に書きます）。

Overlord は、AI が読む**スキル5件**と、あなたが見る**コンソール**（上のスクリーンショットの画面）の2つで構成されます。手順1でスキルを、手順2でコンソールを用意します。

1. **スキルをインストールする**

   ```bash
   git clone https://github.com/ISSEI51/overlord-skill.git
   cd overlord-skill
   ./scripts/install.sh claude          # Codex 向けは ./scripts/install.sh codex
   ```

2. **管理したいプロジェクトを指定してコンソールを起動する**

   ```bash
   ./scripts/console.sh ensure ~/dev/your-project
   ```

   `ensure` は1コマンドで、`docs/product-ops/board.yaml` が無ければ作り、そのボードを配信しているコンソールがまだ無ければサーバーを起動し、cmux のセッションから実行した場合はそのセッションを司令塔として登録します。次のような行が表示されます。

   ```text
   board:            /Users/example/dev/your-project/docs/product-ops/board.yaml
   console:          http://127.0.0.1:7377
   board file:       created
   server:           started, cmux workspace workspace:48
   stop:             close the cmux workspace workspace:48, or: kill $(lsof -ti tcp:7377 -sTCP:LISTEN)
   commander:        registered, surface 22222222-2222-2222-2222-222222222222
   ```

   **`console:` に出たアドレスをブラウザで開いてください。** `ensure` はブラウザを開きません。

   `ensure` は冪等です。同じボードのコンソールが既に動いていれば、サーバーは起動せず（`server: already running, nothing started`）アドレスと止め方を出すだけなので、何度実行しても構いません（このとき `commander:` の行も出ます。同じセッションから実行した場合は `unchanged, ...` となり `board.yaml` は書き換わりません。別の cmux セッションから実行した場合は、そのセッションが司令塔として登録し直されます）。ポートは `--port 7400` で変えられます。**別のプロジェクトのボードが同じポートを使っている場合は、そのコンソールを止めずに終了し（exit 1）、別のポートを指定するよう促します。**

3. **司令塔を用意する** — cmux のセッションから手順2を実行した場合は、`commander:` 行が `registered, surface ...` になり、そのセッションが司令塔として登録済みです。`not registered, ...` と出た場合（cmux が使えない、または cmux のセッション内で実行していない場合）は、画面右のサイドバー（初回は開いています。閉じているときはトップバーのアイコンまたは **⌘B**（Linux では Ctrl+B）で開きます）で「司令塔を新しく起動」を押し、対象プロジェクトのディレクトリを入力して「起動」。Claude Code が動く cmux ワークスペースが作られ、司令塔として登録され、入力欄に最初の指示が入ります。そのまま「送信」を押すと、司令塔が `docs/product-ops/board.yaml` を読み（無ければ作り）、今日の状況を返します。

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

1つの変更は PR 単位で進みます。`start`（worktree とブランチを作る）→ 実装 → `pr`（push して PR を作る）→ 別のAIによるレビュー → `reviewed`（レビューした commit を記録）→ `merge`（レビュー済みかつ CI 成功かつ base が作業ブランチのときだけマージする）→ `sync`（PR の状態を board に反映）。この各段階は `scripts/change.sh` が実行し、board への記録も合わせて行うため、手で書き換える必要はありません。レビュー済みの commit と PR の先頭が食い違うときは `sync` が警告を出します。その変更を完成確認待ちに上げないことは、スキルの規則として定めています。

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
- 完了したカードには成果PR（main 向けのPR）の番号がタグとして出ます。同じ場所に、配送中は `配送中`、未マージの変更が残っていた場合は `未マージあり`、失敗した場合は `配送失敗` と出ます
- 完了カードは右クリックから削除できます

### カードのモーダル

![カードのモーダル](docs/images/card-modal.jpg)

カードをクリックすると中央にモーダルが開きます。

- **指示ボタン**（状況を聞く / 進める / 実装ブリーフ / 独立レビュー / 完了の可否）: 1回押すだけで司令塔へ直接送信されます。スキルのコマンド文は画面に出ません
- **詳細指示**: 自由文で書いた指示が、カードIDを添えて司令塔へ送られます
- **受け入れて完了**: 完成確認待ちのカードに表示され、1クリックで完了になります。このとき、そのカードの成果を main へ出す pull request が自動で提案されます
- **成果の配送**: 作られた成果PRの番号・状態・リンクがカードに残ります。配送するものが無かった場合、未マージの変更が残っていた場合、失敗した場合はその理由が出て、後の2つでは「配送をやり直す」から再実行できます。ブラウザを開き直した後も、カードに記録された失敗が残っていれば同じボタンが出ます
- 状態・次にすること・担当・止まっている理由はその場で編集できます（Escape で取り消し）

### 司令塔サイドバー

画面右のサイドバーが司令塔（あなたが会話する cmux セッション）です。

- トップバーのアイコンまたは **⌘B**（Linux では Ctrl+B）で開閉。開閉状態は保存されます
- 端末ミラーは司令塔の活動に反応してほぼ即時に更新されます（イベント駆動 + 10秒の安全網。cmux とはソケット直結で子プロセスを起動しません）
- 「過去の出力を読む」で履歴（最大2000行）を遡れます。閲覧中は更新が止まり、「追従を再開」で戻ります
- 定型ボタン（今日の状況 / 作業を割り当て / 気づきをカードに / ボード更新）、自由入力欄と「送信」「貼り付けのみ」、キー操作（Enter / Esc / ↑ / ↓ / 中断）を備えます
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

### インストール済みの `overlord-*` を更新する

`scripts/install.sh` は同名のスキルが1件でもあるとその時点で終了します（`Refusing to overwrite existing skill:` を出して exit 1）。したがって更新は、既存の `overlord-*` 5件を削除してから入れ直します。

```bash
cd /path/to/overlord
git pull

# 個人用 (~/.claude/skills) の場合
rm -rf ~/.claude/skills/overlord-ops \
       ~/.claude/skills/overlord-improvement-card \
       ~/.claude/skills/overlord-ux-audit \
       ~/.claude/skills/overlord-implementation-brief \
       ~/.claude/skills/overlord-change-review
./scripts/install.sh claude
```

Codex の場合は `${CODEX_HOME:-~/.codex}/skills` の同じ5件を削除して `./scripts/install.sh codex`、プロジェクト単位でインストールしている場合は対象リポジトリの `.claude/skills/overlord-*` を削除して `/path/to/overlord/scripts/install.sh project` です。

削除の前に `ls -l ~/.claude/skills | grep overlord-` で対象を確認してください。スキルはセッションの開始時に読み込まれるため、入れ直したら Claude Code / Codex のセッションを起動し直します。

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
/path/to/overlord/scripts/console.sh ensure ~/dev/your-project
```

起動方法は2通りあり、どちらも同じサーバーを起動します。

| 形 | 使う場面 | 挙動 |
| --- | --- | --- |
| `console.sh ensure [<プロジェクト>] [--port 7400] [--open]` | 司令塔が使う入口。あなたが手で打ってもよい | 冪等。ボードが無ければ作り、まだ起動していなければサーバーを起動し、cmux のセッションから実行した場合は司令塔も登録する。サーバーは cmux ワークスペース（cmux が使えないときは detached プロセス）で動くので、実行した端末は空く |
| `console.sh <プロジェクト> [--port 7400] [--open]` | ポートやブラウザペインを自分で指定して起動する場面 | サーバーをフォアグラウンドで起動する。端末を閉じるとコンソールも止まる |

引数は両方とも同じ位置で同じものを取ります。プロジェクトを省略すると現在のディレクトリが対象になり、`board.yaml` のパスを直接渡すこともできます。ポートは `--port 7400`（既定は環境変数 `OVERLORD_PORT`、無ければ 7377）、cmux のブラウザペインで開くなら `--open` です。`--open` は cmux のペインを開くもので、あなたのブラウザは開きません。

`ensure` が出す行の意味:

| 行 | 意味 |
| --- | --- |
| `board` | 対象のボードファイル。ディレクトリを渡した場合は `<プロジェクト>/docs/product-ops/board.yaml` |
| `console` | ブラウザで開くアドレス |
| `board file` | `created`（新しく作った）または `already present`。サーバーを起動する回にだけ出ます |
| `server` | `already running, nothing started`、または `started,` に続けて `cmux workspace <ref>` か `detached process <pid>, log: <パス>` |
| `stop` | そのコンソールの止め方。cmux ワークスペースを閉じるか、`kill $(lsof -ti tcp:<ポート> -sTCP:LISTEN)` |
| `commander` | `registered, surface <id>` / `unchanged, this session is already the commander (surface <id>)` / `not registered, ...`（理由付き） |

この他に、cmux のワークスペース作成に失敗して detached プロセスに切り替えたときの `cmux` 行と、`--open` の実行に失敗したときの `open` 行が出ることがあります。

`ensure` が何も起動せずに exit 1 で終わるのは次の3つの場合です。ボードファイルも作られません。

- プロジェクトのディレクトリが存在しない（`ensure` はボードファイルを作りますが、プロジェクトは作りません）
- そのポートを別のプロジェクトのボードが使っている
- そのポートを Overlord のコンソール以外のプロセスが使っている

後の2つでは、相手を止めるのではなく `--port` で空いているポートを指定してください。

これとは別に、起動したサーバーが30秒以内に `/api/state` に応答しない場合も exit 1 になります。この場合はサーバーの起動まで進んでいるため、`server:` と `stop:` の行は既に出力されており、起動したプロセスはそのまま残ります。`stop:` の行のとおりに止めてから、`.overlord/console.log`（cmux ワークスペースで起動した場合はその画面）を確認してください。

cmux が無い環境では、`commander` 行が `not registered, cmux is not reachable` になり、続けてサイドバーから登録するよう促す行が出ます。ボードの作成とサーバーの起動はそのまま行われ、終了コードは 0 です。

カードを完了にしたときの自動配送を止めるには `--no-deliver`、または環境変数 `OVERLORD_DELIVER=0` を付けて起動します。起動時の表示 `deliver on done` で現在の設定が分かります。

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

コンソールがまだ動いていない場合は、その Claude Code セッションから `/path/to/overlord/scripts/console.sh ensure .` を実行すれば、コンソールの起動と、そのセッション（cmux 上で動いている場合）の司令塔登録が同時に行われます。別のターミナルでコンソールを起動した場合は、サイドバーの「変更」からこの Claude Code セッションを司令塔として登録します（司令塔側から `cmux identify --json --id-format both` で自分の ID を読み、board の `commander` に書き込む方法もあります）。

board 自体を手で書きたい場合は、このリポジトリの `docs/product-ops/board.example.yaml` を対象リポジトリの `docs/product-ops/board.yaml` にコピーして出発点にできます。中身は架空のサンプルなので、`items` を自分のカードに置き換えてください（スキーマは `skills/overlord-ops/references/board-schema.md`）。

`board.yaml` には `commander.cwd` と `changes[].agent.cwd` としてホームディレクトリを含む絶対パスが、`commander` と `changes[].agent` としてローカルの cmux UUID が入ります。**公開リポジトリで Overlord を使う場合は、対象リポジトリの `.gitignore` に `docs/product-ops/board.yaml` を追加してください。** これらを追跡対象から外すためです（このリポジトリ自身も同じ理由で追跡していません）。

リポジトリのマージ方式の設定については、[なぜ merge commit なのか](#なぜ-merge-commit-なのか)を参照してください。

## エージェント名義の GitHub アカウント

Overlord が push するブランチと作るPRは、既定ではあなたのアカウント名義になります。専用のアカウントを用意すると、この2つだけをそのアカウント名義にできます。

これは記録のためだけの分離ではありません。GitHub はPRの作成者による自己承認を許さないため、main を「承認1件必須・bypass なし」の Ruleset で守っている場合、**PRがあなた以外の名義で作られていることが、あなたの承認なしに main へマージされないことの前提になります**。PRがあなたの名義に戻ると、この保証は失われます。

設定しなければ従来どおり、アクティブな `gh` アカウントで push しPRを作ります。

### 準備

1. **bot アカウントを対象リポジトリに Write コラボレーターとして追加する。** Admin にはしないでください。Admin は Ruleset を削除できるため、保護そのものが意味を失います。

2. **bot アカウントで classic personal access token を発行する。** スコープは `repo`, `read:org`, `gist` の3つだけにします。この3つは `gh auth login` が要求するスコープです。**`workflow` は付けないでください**（付けると CI のワークフロー定義を書き換えられます）。

   fine-grained PAT は、他人の個人アカウントが所有するリポジトリには権限を付与できないため、この用途では使えない場合があります（Organization 所有のリポジトリなら使えます）。

3. **`gh` に登録する。** アクティブアカウントは切り替わりません（Overlord も切り替えません）。

   ```bash
   gh auth login --hostname github.com
   gh auth status          # 2アカウントが並ぶ。active はあなたのままでよい
   ```

4. **環境変数を設定する。** 全プロジェクトで有効にするため、シェルの設定ファイルに書きます。

   ```bash
   echo 'export OVERLORD_GH_ACCOUNT=<bot のアカウント名>' >> ~/.zshrc
   ```

   このリポジトリの `.env` に書く方法もありますが、`.env` を読むのは `just` のレシピだけです。`scripts/change.sh` やコンソールサーバーを直接起動する場合は読まれないため、シェルの設定ファイルに書くほうが確実です。`.env` は `.gitignore` に入っています。

5. **確認する。** 対象リポジトリで次を実行します。

   ```bash
   /path/to/overlord/scripts/change.sh identity
   ```

   ```text
   agent account:    ISSEI-BOT
   token source:     gh auth token --user ISSEI-BOT
   github login:     ISSEI-BOT
   repository:       ISSEI51/overlord-skill
   permission:       WRITE
   push remote:      https://github.com/ISSEI51/overlord-skill.git
   push identity:    ISSEI-BOT
   ```

   トークンが取り出せること、そのトークンが名乗るアカウントが指定と一致すること、そのアカウントがこのリポジトリで write を持つこと、push リモートがそのトークンで認証できるホストであることを、この順に確認します。満たさない項目があれば exit 1 で理由を出します。**アカウントの設定は全プロジェクト共通ですが、リポジトリへのアクセス権はリポジトリごとに与えるものなので、新しいプロジェクトで Overlord を使い始めるときは 1. と 5. を行ってください。**

### 決めていること

- **アクティブな `gh` アカウントは切り替えません。** `gh auth switch` はプロセス全体に永続的に効くため、並行して動くセッションと競合します。トークンは実行するサブプロセスの環境変数としてだけ渡します。
- **指定したアカウントのトークンが取り出せない場合、そのコマンドは失敗します。** あなたのアカウントに黙って戻ることはありません。静かにあなたの名義でPRが作られるのが、最も避けたい事態だからです。
- **トークンはコマンドライン引数・標準出力・標準エラー・ファイルのどこにも出しません。** 環境変数として子プロセスに渡すだけです。
- push がこのアカウントで行われるのは、リモートが `https://github.com/...` のときだけです。ssh のリモートは鍵で認証されるため、トークンを送らずに警告を出して push します。
- 変わるのは push とPRの名義だけです。**コミットの author はあなたのままです。** Ruleset が見るのはPRの作成者なので、この目的にコミットの author は関係しません。

## 日常の使い方

1. **気づきを残す**: トップバーの「気づきを追加」、またはサイドバーの「気づきをカードに」
2. **進める**: カードを開いて「進める」を1回押す。司令塔が状態に応じた作業（カード化 → ブリーフ → 実装 → 独立レビュー）をサブエージェントで進めます
3. **決める**: 「今日の判断」と水色枠のカードだけ見れば足ります。実装ブリーフの承認や完成の受け入れはカードのボタンで完結します
4. **受け入れる**: 完成確認待ちのカードを確認し、「受け入れて完了」。成果を main へ出す pull request が自動で提案され、結果はカードの「成果の配送」に残ります。あとは GitHub でマージし、溜まった完了カードは右クリックで削除

## 運用の決まり

- 同時に実装するのは最大3件。AIが抱える作業は10件前後まで（超えるとトップバーに警告が出ます）
- 1リポジトリ1 `board.yaml` が原則です。複数リポジトリはコンソールを別ポートで並行起動してください（`console.sh ensure <プロジェクト> --port <ポート>`。既に別のボードが使っているポートを指定すると、`ensure` はそのコンソールを止めずに終了します）
- コンソールはあなたが見る画面であり、AIは常に `board.yaml` を読んで作業します。書き込みは楽観ロックで保護され、AIの更新が黙って上書きされることはありません
- 実装したAIに自分の変更を最終確認させないため、独立レビューは別のサブエージェントが行います
- main 向けのPR（カードの配送PR）は **merge commit** でマージします。squash と rebase は使いません
- main / master へのマージは常にあなたが行います。AIは `scripts/change.sh merge` でしかマージできず、このコマンドは base が main / master / 既定ブランチのPRを必ず拒否します
- push とPRを専用アカウント名義にする場合は [エージェント名義の GitHub アカウント](#エージェント名義の-github-アカウント)を参照してください。main の Ruleset で「承認1件必須」を使うなら、この設定が前提になります

### なぜ merge commit なのか

squash は main に新しいコミットを1つ作ります。作業ブランチ側の元のコミットは main の履歴に入らないため、内容が同じでもマージ後に merge-base が前進しません。この状態で、main の squash コミットが変更した行、またはその近傍の行を作業ブランチが再度変更すると、次の main 向けPRがその行で競合します。実際に PR #10 がこの経路で競合し、手作業で解消しました。

squash を使うと**必ず**競合するわけではありません。両側の差分が同じ内容なら git は解決できます。競合するのは、squash が変更した行と重なる範囲を作業ブランチが再度書き換えた場合です。同じファイルでも変更行が十分に離れていれば git は自動で解決します。ただし `.gitignore` や `console/src/board.ts`、`console/src/change.ts` のように繰り返し変更するファイルでは、squash を続ける限り再発します。

merge commit なら配送のたびに merge-base が前進するため、この分岐そのものが起きません。

PR #10 の squash で生じた分岐は、PR #16 を merge commit でマージした時点で解消しました。

この決まりは main 向けのPRについてのものです。変更（change）単位のPRは作業ブランチに向けたもので、ここでは対象外です。なお `scripts/change.sh merge` は変更単位のPRも `gh pr merge --merge --match-head-commit <レビュー済みの commit>` でマージします。squash と rebase を選ぶ引数はありません。

現在の設定は次で確認できます。

```bash
gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
```

merge commit だけを許可する設定は、GitHub の Settings > General > Pull Requests でチェックボックスを操作するか、次のコマンドで行います。

```bash
gh repo edit --enable-merge-commit=true --enable-squash-merge=false --enable-rebase-merge=false
```

この設定はリポジトリごとに手動で行います。設定していない間は、マージ画面で merge commit を選ぶ運用で担保してください。Overlord を新しいリポジトリで使い始めるときも、同じ設定にしてください。
