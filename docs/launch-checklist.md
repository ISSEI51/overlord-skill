# 公開前チェックリスト

OSS として公開するまでに確認・実施することの一覧です。GitHub の設定画面でしか変えられない項目は、推奨値をここに書いてあります。

## 1. リポジトリ内

- [x] **MIT License** — ルートの `LICENSE`（`Copyright (c) 2026 Issei Kunimasa`）
- [x] **README.md（日本語）** — キャッチコピー → 説明 → スクリーンショット → 主な特徴 → Quick Start → 詳細、の順
- [x] **README.en.md（英語）** — 日本語版と同じ情報構造
- [x] **`docs/launch-demo.md`** — 30〜60秒デモの撮影手順
- [x] **`CONTRIBUTING.md`** — 開発の入口（テストの実行、フロントエンドの再ビルド）
- [ ] **リポジトリ名の確定** — 現在の remote は `ISSEI51/overlord-skill`。README の `git clone` URL とディレクトリ名（`cd overlord-skill`）はこの名前に合わせてあります。**リポジトリ名を変えるなら、両 README の URL と `cd` 行を同時に直すこと**
- [ ] **デモ動画（30〜60秒）** — `docs/launch-demo.md` のとおりに撮影。README への埋め込みは任意

## 2. GitHub の設定（Web の設定画面でしか変えられない）

### Repository description

現在: `Run more products without losing control, while AI turns your decisions into real progress.`

| 案 | 文面 | 評価 |
| --- | --- | --- |
| A（**推奨**） | `Run your Claude Code and Codex agents as a development team. AI agents investigate, implement, and review — you make the decisions that matter.` | 思想（判断は人間）と具体語（Claude Code / Codex / agents）の両方が入る。検索でも拾われる |
| B | `A local control plane for AI coding agents (Claude Code, Codex): a kanban board, one worktree-branch-PR per change, and independent review.` | 何をする道具かは最も正確だが、思想が伝わらない |
| C | `AI coding agents do the work. You make the decisions that matter. Skills and a local dashboard for orchestrating Claude Code and Codex.` | 思想は最も強いが、先頭が抽象的で検索語が後ろに寄る |

**推奨は A。** 現在の description は「何のツールか」を含んでいないため、GitHub 検索と一覧表示で不利です。

### Topics

推奨（7件）:

```
claude-code  codex  coding-agents  ai-agents  agentic-coding  multi-agent  developer-tools
```

| Topic | 採否 | 理由 |
| --- | --- | --- |
| `claude-code` | 採用 | スキルの主対象。最も具体的で、探している人に届く |
| `codex` | 採用 | `install.sh codex` で Codex にもインストールできる。ただし同名の無関係なプロジェクトが多い語なので、単独では効果が薄い |
| `coding-agents` | 採用 | 対象そのもの |
| `ai-agents` | 採用 | 上位の一般語。流入の入口 |
| `agentic-coding` | 採用 | この領域を探すときに実際に使われる語 |
| `multi-agent` | 採用 | 司令塔1つ + カード単位のサブエージェント、変更ごとに並行実行という実際の構成に合っている |
| `developer-tools` | 採用 | 一般カテゴリとして妥当 |
| `workflow-automation` | **除外** | Overlord は人間の判断を残す管理レイヤーであり、判断まで自動化する道具ではない。CI / RPA を探している人に届いても期待とずれる |

### Social Preview

- サイズ: 1280x640px（GitHub の推奨。表示は 1280x640 に切り抜かれる）
- 内容の推奨: `docs/images/console-board.jpg` のボード部分を背景にして、上に大きく `You are the Overlord.` / 小さく `You make the decisions that matter.` を載せる
- 注意: ボードのカード文言とトップバーのパスが読める大きさで入るため、**デモ用のボードで作った画像を使うこと**（実プロジェクト名が写らないこと）

### そのほかの設定

- [ ] Issues を有効にする
- [ ] Discussions は当面オフでよい（対応コストが増えるだけになりやすい）
- [ ] About 欄の Website は未設定でよい

## 3. バージョンタグと Release

**判断: 公開時に `v0.1.0` タグと GitHub Release を作る。**

理由:

- インストールは `git clone` なので、動かすためにタグは不要です。この意味では必須ではありません。
- それでも作る理由は3つです。(1) SNS や Reddit の投稿から「試した版」を特定できる。(2) スキル名の `product-*` → `overlord-*` のような後方互換のない変更を、Release ノートで伝える場所ができる。(3) GitHub の Releases 欄が空だと、メンテされているかどうかが読み取れません。
- 追加の作業は要りません。ソースの zip / tar は GitHub が自動生成します。ビルド済みフロントエンド（`console/public`）はリポジトリに含まれているため、リリース資産を別途用意する必要はありません。
- `v1.0.0` にはしません。`console/package.json` は `0.1.0` で、外部利用の実績がまだない段階です。

Release ノートに書くこと:

- Overlord が何をする道具か（README の冒頭2行）
- 含まれるスキル5件と Overlord Console
- 前提（Claude Code または Codex / Bun / `git` と `gh` / cmux）
- 既知の制約（コンソールの UI は日本語。cmux は macOS アプリで、司令塔サイドバーとカードの指示ボタンは macOS でのみ使える。コンソールとスキル自体は Bun が動く環境であれば動作する）

## 4. 秘密情報の確認（実施済み）

実際に走査した結果です。走査対象は Git の管理下にあるテキストファイル（`git ls-files` で70件、うち画像2件は `git grep` の対象外）です。画像に写り込んでいる情報は文字列走査では検出できないため、別項目として下に挙げてあります。

```bash
# 1. .env / 鍵ファイルが追跡されていないか
git ls-files | grep -Ei '\.env|\.pem$|\.key$|id_rsa|credential|secret'
#=> 該当なし

# 2. トークン・秘密鍵のパターン
git grep -nIE '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,})' -- .
#=> 該当なし

# 3. メールアドレス
git grep -nIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- .
#=> console/src/change.test.ts:740  "user.email=test@example.com"（テスト用のダミー。対処不要）

# 4. 個人のホームディレクトリなど内部パス
git grep -nI '/Users/' -- .
#=> docs/product-ops/board.yaml:6                       cwd: "/Users/kunimasa/dev/overlord"
#=> skills/overlord-ops/references/board-schema.md:11,40  /Users/example/...（サンプル。対処不要）
#=> skills/overlord-ops/references/console.md:29,96       /Users/example/...（サンプル。対処不要）

# 5. コミット作者
git log --format='%ae' | sort | uniq -c | sort -rn
#=> 38  issei60issei60@gmail.com
#=> 13  135028254+ISSEI51@users.noreply.github.com
#   （overlord-console ブランチの 51 コミット時点の実測値）
```

判定と対応:

- [x] API キー・アクセストークン・秘密鍵: **なし**
- [x] `.env` などの設定ファイル: **追跡されていない**（`.gitignore` に `.overlord/` あり）
- [ ] **`docs/product-ops/board.yaml` の扱いを決める（要判断）** — このファイルは Overlord 自身の作業ボードで、`commander.cwd` に `/Users/kunimasa/dev/overlord`、`commander.workspace_id` / `surface_id` にローカルの cmux UUID、各カードに開発中の内部メモが入っています。秘密情報ではありませんが、ホームディレクトリの実名と作業内容が公開されます。選択肢は「そのまま公開する（開発の実例として見せる）」「`commander` ブロックだけ削って公開する」「サンプル board に差し替える」の3つ。**この worktree では board.yaml を編集していません。**
- [ ] **同梱スクリーンショットに写り込んでいる情報の確認** — `docs/images/console-board.jpg` と `docs/images/card-modal.jpg` は追跡されており、README から表示されます。文字列走査の対象外なので、画像を開いて次を目視で確認します。トップバーの board のパス、カードモーダルの「担当セッション」欄に出る worktree のパス、カード本文とプロジェクト名、PR URL。ホームディレクトリの実名や実プロジェクト名が読めるなら、デモ用のボードで撮り直します（§2 の Social Preview と同じ注意です）。
- [ ] **今後のコミット作者メールを `@users.noreply.github.com` に統一する** — `gh repo view ISSEI51/overlord-skill --json visibility` は `PUBLIC` を返します。**リポジトリはすでに公開済みで、`issei60issei60@gmail.com` を含むコミット履歴（51 コミット中 38 件）は誰でも読める状態です。** 今から `git filter-repo` で履歴を書き換えても、GitHub 側に残る到達可能な旧オブジェクト、フォーク、キャッシュ、既存のクローンは取り消せません。したがって取れる対策は今後のコミットの統一だけです。GitHub の「Keep my email addresses private」を有効にし、`git config user.email 135028254+ISSEI51@users.noreply.github.com` を設定します。

## 5. 告知（**このリポジトリからは投稿しない。文面案のみ**）

### X（日本語）

> AI に実装させる時代の次は、AI を「チーム」として管理する時代だと思っています。
>
> Overlord は Claude Code / Codex のエージェントを開発チームとして動かすための管理レイヤーです。調査・実装・レビュー・進捗更新は AI が担当し、人間は優先順位と最終判断だけを行います。
>
> 1変更 = 1 worktree = 1 branch = 1 PR = 1 エージェント実行。
> MIT ライセンスで公開しました。
>
> （動画 + リポジトリ URL）

### X（英語）

> You are the Overlord. You make the decisions that matter.
>
> Overlord runs your Claude Code and Codex agents as a development team: they investigate, implement, review each other's work, and keep the board current. You handle priorities, direction, and the final call.
>
> 1 change = 1 worktree = 1 branch = 1 PR = 1 agent run. MIT licensed.
>
> (video + repo URL)

投稿時の注意:

- 動画は X に直接アップロードする（外部リンクの動画は再生されにくい）
- URL は本文に入れる。1投稿目に入れて問題ない
- 「全自動」「完全自律」とは書かない。人間が判断する設計であることが売りなので、事実と一致しない

### Reddit

投稿先候補（**投稿前に各サブレディットの自己宣伝ルールと投稿頻度制限を必ず確認する**）:

| サブレディット | 適合度 | 注意 |
| --- | --- | --- |
| r/ClaudeAI | 高 | Claude Code の利用者が中心。スクリーンショット付きの実用ツールは受け入れられやすい |
| r/ChatGPTCoding | 中〜高 | Codex 利用者に届く。ツール紹介は許容されることが多いが、宣伝色が強いと削除される |
| r/opensource | 中 | MIT ライセンスの新規公開として妥当。デモよりも「何を解決するか」を本文で書く |
| r/SideProject | 中 | 反応は早いが、開発者以外も多く深い議論にはなりにくい |

本文の骨子（英語）:

- 1段落目: 解いた問題（複数の AI エージェントを同時に動かすと、人間が状況を把握できなくなる）
- 2段落目: 仕組み（1つの司令塔セッション + カード単位のサブエージェント + `board.yaml` + ローカルのカンバン）
- 3段落目: 前提と制約（Bun / `git` と `gh` / cmux は macOS アプリ、UI は日本語）を先に書く。後から指摘されるより良い
- 最後: MIT、リポジトリ URL、フィードバックの依頼

## 6. 公開直後

- [ ] README の画像が GitHub 上で表示されているか（相対パス `docs/images/*.jpg`）
- [ ] `git clone` から Quick Start の手順どおりに、別のディレクトリで一度通しで動かす
- [ ] Issue テンプレートは、実際に Issue が来てから用意すれば足りる
