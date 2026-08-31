# 公開前チェックリスト

OSS として公開するまでに確認・実施することの一覧です。GitHub の設定画面でしか変えられない項目は、推奨値をここに書いてあります。

## 1. リポジトリ内

- [x] **MIT License** — ルートの `LICENSE`。著作権表記はメンテナの氏名です（著作権表記として必要なので、走査で検出されてもそのまま残します）
- [x] **README.md（日本語）** — キャッチコピー → 説明 → スクリーンショット → 主な特徴 → Quick Start → 詳細、の順
- [x] **README.en.md（英語）** — 日本語版と同じ情報構造
- [x] **`docs/launch-demo.md`** — 30〜60秒デモ動画の撮影手順と、README 用スクリーンショット2枚の撮り直し手順
- [x] **`CONTRIBUTING.md`** — 開発の入口（テストの実行、フロントエンドの再ビルド）
- [ ] **リポジトリ名の確定** — 現在の remote は `ISSEI51/overlord-skill`。README の `git clone` URL とディレクトリ名（`cd overlord-skill`）はこの名前に合わせてあります。**リポジトリ名を変えるなら、両 README の URL と `cd` 行を同時に直すこと**
- [ ] **デモ動画（30〜60秒）** — `docs/launch-demo.md` のとおりに撮影。README への埋め込みは任意
- [ ] **マージ前に、各クローンの `docs/product-ops/board.yaml` を退避する** — `board.yaml` の追跡解除を取り込むと、既存のクローンではこのファイルが作業ツリーから削除されます。対象は、このリポジトリで Overlord を動かしているすべてのクローン（メンテナの手元、別マシン、CI のチェックアウト）です。手順は §4 の該当項目に書いてあります

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

実際に走査した結果です。走査対象は Git の管理下にあるテキストファイル（`git ls-files` で70件、うち画像2件は `git grep` の対象外）です。画像に写り込んでいる情報は文字列走査では検出できないため、別項目として下に挙げてあります。以下はブランチ `overlord/OV-110-C4` で取り直した実測値です（`docs/product-ops/board.yaml` を追跡から外したあとの状態）。

```bash
# 1. .env / 鍵ファイルが追跡されていないか
git ls-files | grep -Ei '\.env|\.pem$|\.key$|id_rsa|credential|secret'
#=> 該当なし

# 2. トークン・秘密鍵のパターン
git grep -nIE '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,})' -- .
#=> 該当なし

# 3. メールアドレス
git grep -nIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- .
#=> console/src/change.test.ts:751,1795  "user.email=test@example.com"（テスト用のダミー。対処不要）
#=> docs/launch-checklist.md               この文書が上の1件を引用している行
#   実在の個人アドレスは0件。この文書では <maintainer-email> などのプレースホルダに置き換えてあります
#   （<...>@users.noreply.github.com の形は @ の直前が > になるため、この正規表現には一致しません）

# 4. 個人のホームディレクトリなど内部パス
git grep -nI '/Users/' -- .
#=> skills/overlord-ops/references/board-schema.md:11,40  /Users/example/...（サンプル。対処不要）
#=> skills/overlord-ops/references/console.md:29,98       /Users/example/...（サンプル。対処不要）
#=> docs/launch-checklist.md                              この走査コマンド自身の行
#   docs/product-ops/board.yaml は追跡外になったため、この走査には現れません

# 5. board.yaml が追跡されていないこと
git ls-files docs/product-ops/
#=> docs/product-ops/board.example.yaml
git check-ignore -v docs/product-ops/board.yaml
#=> .gitignore:9:docs/product-ops/board.yaml	docs/product-ops/board.yaml

# 6. コミット作者
git log --format='%ae' | sort | uniq -c | sort -rn
#=> 40  <maintainer-email>（メンテナの個人アドレス）
#=> 13  <github-user-id>+<github-username>@users.noreply.github.com
#   （この文書を更新した時点、overlord/OV-110-C4 の 53 コミットでの実測値。コミットのたびに増えます）

# 7. cmux のワークスペース／サーフェス UUID
#    注意: git grep -E は \b を解釈しません。\b を付けた正規表現は常に0件になるため、
#    「該当なし」と読み違えないこと。下の形（\b なし）で走査します。
git grep -nIE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}' -- .
#=> skills/overlord-ops/references/board-schema.md:9,10,38,39
#=> skills/overlord-ops/references/console.md:27,28,96,97
#   計8件。すべて 11111111-… / 22222222-…（commander の workspace / surface）と
#   33333333-… / 44444444-…（change の agent の workspace / surface）のダミー値です。
#   実在の cmux ID は0件。
```

判定と対応:

- [x] API キー・アクセストークン・秘密鍵: **なし**
- [x] `.env` などの設定ファイル: **追跡されていない**（`.gitignore` に `.overlord/` あり）
- [x] **`docs/product-ops/board.yaml` の扱い（解消済み）** — 判断は「追跡から外して example を配る」。`git rm --cached` で追跡を外し、`.gitignore` に `docs/product-ops/board.yaml` の1行を追加しました。これで `commander.cwd` のホームディレクトリ実名、ローカルの cmux UUID、各カードの開発中メモは追跡対象から外れ、コントリビューターがこのリポジトリで Overlord を動かしても差分が出なくなりました。**すでに公開済みの過去のコミットには残っています**（履歴の書き換えが有効な対策にならない理由は下のコミット作者メールと同じです）。代わりに `docs/product-ops/board.example.yaml` を追跡し、新規利用者向けの雛形とスクリーンショット用のデモボードを兼ねさせています。

  **既存のクローンでは、この変更を取り込むと `docs/product-ops/board.yaml` が作業ツリーから削除されます。** ファイルがローカルに残るのは `git rm --cached` を実行した作業ツリーだけです。一時クローンで実測した挙動は次の3通りです。

  | 取り込むクローンの `board.yaml` の状態 | マージの結果 |
  | --- | --- |
  | 変更していない | `delete mode 100644 docs/product-ops/board.yaml`。マージは成功し、警告なしにファイルが削除される |
  | 変更あり・未コミット | `error: Your local changes to the following files would be overwritten by merge` / `Aborting` でマージが中止される。ファイルは残る |
  | 変更あり・コミット済み | `CONFLICT (modify/delete): docs/product-ops/board.yaml deleted in <取り込む側> and modified in HEAD.` で衝突する |

  どの場合も、退避しておけば元に戻せます。取り込む前に board を退避し、取り込んだあとに書き戻します。

  ```bash
  cd /path/to/clone
  cp docs/product-ops/board.yaml /tmp/board.backup.yaml
  git pull                                   # ここで board.yaml が削除される
  cp /tmp/board.backup.yaml docs/product-ops/board.yaml
  ```

  書き戻したあとは、取り込んだ `.gitignore` の効果で `board.yaml` は無視されます（`git status` は clean、`git check-ignore -v docs/product-ops/board.yaml` が `.gitignore:9` を返す）。衝突した場合は `git checkout --ours docs/product-ops/board.yaml` ではなく、`git rm docs/product-ops/board.yaml` で衝突を解消してから、退避したファイルを同じ場所に置き直します。
- [ ] **同梱スクリーンショットの撮り直し（未実施）** — `docs/images/console-board.jpg` と `docs/images/card-modal.jpg` は追跡されており、README から表示されます。目視で確認した結果、次の4種類が読める大きさで写っています。画像は文字列走査の対象外なので、`board.yaml` を追跡から外しても解消しません。
  - トップバーの board パス表示（ホームディレクトリ名を含む）
  - 実在のプロジェクト名2件と、そのカード本文
  - 「今日の判断」バーの本文
  - 司令塔サイドバーの端末ミラーのプロンプト行（同じくホームディレクトリ名を含む）と、そこに表示された第三者ツール（Claude Code CLI）のヘルプ出力

  写っている文字列そのものはこの文書には書きません。追跡ファイルの平文にすると、これまで画像の画素の中にしかなかった値が `git grep` と GitHub のコード検索で見つかる形になり、撮り直しの目的と逆になるためです。`docs/launch-demo.md` の「スクリーンショットの撮り直し」の手順で、`board.example.yaml` を使って撮り直し、同じファイル名で差し替えます（§2 の Social Preview はこの画像を素材にするため、先に撮り直すこと）。
- [ ] **今後のコミット作者メールを `@users.noreply.github.com` に統一する（未実施）** — `gh repo view ISSEI51/overlord-skill --json visibility` は `PUBLIC` を返します。**リポジトリはすでに公開済みで、メンテナの個人メールアドレス（以下 `<maintainer-email>`）を含むコミット履歴（53 コミット中 40 件）は誰でも読める状態です。** 今から `git filter-repo` で履歴を書き換えても、GitHub 側に残る到達可能な旧オブジェクト、フォーク、キャッシュ、既存のクローンは取り消せません。したがって取れる対策は今後のコミットの統一だけです。GitHub の「Keep my email addresses private」を有効にし、`git config user.email '<github-user-id>+<github-username>@users.noreply.github.com'` を設定します（このアドレスは GitHub の Settings > Emails に表示されます）。実アドレスをこの文書に書かないのは、追跡ファイルの平文にするとコミットのメタデータよりも検索しやすくなるためです。

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
