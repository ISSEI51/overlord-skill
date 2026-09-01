# Overlord Console

Overlord Console is a localhost web dashboard for `docs/product-ops/board.yaml`. It replaces the earlier `Overlord Board` Artifact, which could not reach a local process because Artifacts are served under a content security policy that blocks requests to any external host, including `127.0.0.1`.

## Start

There are two entry points to the same server.

```bash
# the commander's entry point: idempotent, starts nothing that is already running
/path/to/overlord/scripts/console.sh ensure [<project-directory>] [--port 7377] [--open]

# the explicit form: starts one server in the foreground and holds the terminal
/path/to/overlord/scripts/console.sh <project-directory> [--port 7377] [--open]
```

`ensure` is the form the commander runs, from the project directory, on the first
product-operations request. The installed skill has no `scripts/` of its own, so it is
called through the checkout path `scripts/install.sh` recorded beside the skill:

```bash
cd <project-directory>
"$(cat <skill-dir>/overlord-checkout)/scripts/console.sh" ensure .
```

The explicit form is for the user starting a console themselves, when they want to
choose the port or the cmux browser split by hand. It runs the server in the foreground,
so the console stops when that terminal is closed; `ensure` puts the server in a cmux
workspace or in a detached process instead, and leaves the calling terminal free.

Both take the same arguments in the same places, and differ only in how they reject a
mistyped one (see below). `<project-directory>` defaults to the current directory and
may also be a `board.yaml` inside a project. `--port` defaults to
`$OVERLORD_PORT`, then to 7377. `--open` shows the console in a cmux browser split; it
does not open the user's own browser. The server binds to `127.0.0.1` only and rejects
requests whose `Host` or `Origin` header is not loopback.

### What `ensure` does, and does not do

Each step is a no-op when it is already done, so a second run produces the same result:

1. the project directory has to exist. `ensure` writes into it; it does not create it,
   and a path that is not a directory exits 1;
2. `docs/product-ops/board.yaml` is created when it is missing — the skeleton only
   (`version`, `updated_at`, `items: []`). An existing board is not rewritten;
3. the server is started only when nothing is already serving that board on that port.
   With cmux reachable it runs in its own cmux workspace the user can see and close;
   otherwise it is started detached, with its output in `<project>/.overlord/console.log`;
4. the calling cmux session is registered as the board's `commander`. An unchanged
   commander is not written back, so a re-run does not touch `board.yaml` and does not
   make open consoles re-render.

`ensure` does not open a browser. The address it prints is the user's to open.

### The lines it prints

| Line | Meaning |
| --- | --- |
| `board` | the board file it resolved, `<project>/docs/product-ops/board.yaml` for a directory |
| `console` | the address to give the user |
| `board file` | `created` or `already present`; printed only on the run that starts a server |
| `server` | `already running, nothing started`, or `started, ` plus `cmux workspace <ref>` or `detached process <pid>, log: <path>` |
| `stop` | how to stop that console: closing the cmux workspace, or `kill $(lsof -ti tcp:<port> -sTCP:LISTEN)` |
| `commander` | `registered, surface <id>`, `unchanged, this session is already the commander (surface <id>)`, or a `not registered, …` reason |

Two more labels appear only on their own path: `cmux` when `new-workspace` failed and
the console is being started detached instead, and `open` when `--open` was passed and
`cmux browser open` failed. Some lines are followed by an unlabeled continuation line
(`register the session from the console sidebar instead`, `starting the console as a
detached process instead`).

The commander line is printed on the already-running path too, so a second session can
take an existing console over by running `ensure` from there — that run does write
`board.yaml`. Only a re-run from the session that is already the commander leaves the
file untouched.

Without cmux only the commander step is skipped: the line reads `not registered, cmux is
not reachable`, followed by `register the session from the console sidebar instead`. A
run from a shell that is reachable to cmux but not itself a cmux session reads `not
registered, this command is not running inside a cmux session`. In both cases the board
and the server are already up and the exit code is 0.

### When it refuses

`ensure` exits 1 without starting anything when the port is not free for this board:

```text
port 7377 is serving another board: /Users/example/other/docs/product-ops/board.yaml
choose a free port instead of stopping it: console.sh ensure /Users/example/project --port <port>
```

Run it again with `--port <n>` on a free port; do not stop the other project's console.
A port held by something that is not an Overlord console is refused the same way, with
`port 7377 is held by another process: <detail>` followed by `choose a free port
instead:` — and is also a reason to choose another port rather than to free this one.
It also exits 1, without creating the board file, when the project directory does not
exist.

One failure is not of that kind: when the server it started does not answer
`<address>/api/state` within 30 seconds, `ensure` exits 1 with the board file created,
the `server:` and `stop:` lines already printed, and the started process still running.
Stop it as the `stop:` line says before running `ensure` again.

`ensure` also exits 1 on a mistyped option (`unknown option: --prot (see: console.sh
ensure --help)`) and on a port outside 1-65535. The explicit form's parser ignores an
unknown option instead, and `--help` exists only on `ensure`.

## What the console reads and writes

- It reads `<project-directory>/docs/product-ops/board.yaml` and re-renders when the file changes on disk.
- The user can change `state`, `owner`, `next_action`, `blocker`, and the `agent` link from the browser. Those edits are written back to the same file.
- Card writes use the file's modification time as a revision token. A write from the console is rejected with HTTP 409 when an agent changed the file first, so an agent's write is never silently overwritten.

## One commander, subagents behind it

The console docks one session on the right: the commander. The user types only there. Cards have no session picker and no compose box; their buttons write an instruction into the commander's input box, and the user presses 送信.

The commander is stored at the top level of the board:

```yaml
commander:
  workspace_id: "11111111-1111-1111-1111-111111111111"
  surface_id: "22222222-2222-2222-2222-222222222222"
  cwd: "/Users/example/dev/project"
```

A session can register itself as the commander:

```bash
cmux identify --json --id-format both   # caller.workspace_id, caller.surface_id
```

## cmux integration

The console controls cmux through the `cmux` CLI over the local cmux socket.

| Console action | cmux command |
| --- | --- |
| セッション一覧 | `cmux tree --all --json`, `cmux workspace list --json` |
| 司令塔の画面 | `cmux read-screen --surface <id>` |
| 司令塔への送信 | `cmux rpc surface.send_text`（bracketed paste）、`cmux send-key <key>` |
| 司令塔を新しく起動 | `cmux new-workspace --name <title> --cwd <path> --command claude` |
| cmux で開く | `cmux select-workspace`, `cmux rpc surface.focus` |

A cmux workspace does not start its terminal process until the workspace is selected once. The console selects the workspace, waits for the terminal, and restores the previously selected workspace.

## Dispatching a worker session

Work is dispatched per change, not per card: one change is one worktree, one branch, one pull request and one worker session. The commander does not create the worktree or the branch by hand — `scripts/change.sh` owns them and records them on the board.

`change.sh` is run from the project directory, with the absolute path of the Overlord checkout — the same way `console.sh` is started:

```bash
cd <project-directory>
/path/to/overlord/scripts/change.sh start <change-id>      # worktree と overlord/<change-id> ブランチを作り board に記録
cmux new-workspace --name "<change-id> <title>" --cwd <出力された worktree パス> --command claude
# 実装・検証の後
/path/to/overlord/scripts/change.sh pr <change-id>         # push して PR を作り change.pr を記録
# 独立レビューで blocking finding なしと判断した時点
/path/to/overlord/scripts/change.sh reviewed <change-id>   # レビューした commit を change.pr.reviewed_sha に記録
# レビュー済みで CI が通り、base が作業ブランチのとき
/path/to/overlord/scripts/change.sh merge <change-id>      # change の PR を merge commit でマージし board に記録
# 状態を報告する前、マージの後
/path/to/overlord/scripts/change.sh sync <card-id>         # カードの各 change の PR 状態を board に反映
# カードの change が全て merged になった後
/path/to/overlord/scripts/change.sh deliver <card-id>      # カードをデフォルトブランチへ出す PR を作り item.delivery に記録
# 新しいプロジェクトで最初に一度
/path/to/overlord/scripts/change.sh identity               # push と PR に使う GitHub アカウントを確認する
```

Every subcommand except `identity` takes `--board <path>` (a `board.yaml`, or a project directory containing one) when the board is not the one under the current directory; without it they fall back to `$OVERLORD_BOARD` and then to the current directory. `start` and `pr` also take `--base <branch>`, which defaults to the current branch of the main checkout: `start` branches from it and `pr` opens the pull request against it. A change that builds on the previous one is stacked by passing `--base overlord/<前の change-id>` to both commands, so its diff shows only its own work.

Exit codes are the same for all of them: 0 when the command did what it says, 1 when a git, `gh` or board step failed, and 2 for a usage or argument error. A failure leaves `board.yaml` untouched.

`start` prints the worktree path on its last line — `<repo>/.overlord/worktrees/<change-id>` — and writes `changes[].branch` plus `changes[].state: implementing`. `pr` pushes the branch, opens the pull request — or reuses the one already open for that branch — and writes `changes[].pr` (`number`, `url`, `state`, `head_sha`). The change state follows the pull request: `reviewing` for an open one, `done` for one that is already merged, unchanged for a closed one. `pr --number <n>` records a pull request that was opened from the GitHub web UI instead of creating one; the number is checked against `changes[].branch` (`gh pr view --json headRefName`), and a pull request on any other branch is refused without writing the board, so a mistyped number cannot overwrite the record of the correct pull request. Both commands leave `board.yaml` untouched when the git or `gh` step fails, so they can be run again.

`reviewed <change-id>` records the commit the independent review actually read in `changes[].pr.reviewed_sha`, and writes nothing else — not `change.state`, not the other `pr` fields. By default it reads the HEAD of the change worktree (`<repo>/.overlord/worktrees/<change-id>`), because that is the tree the review was done on; when the worktree is already gone it reads the pull request head with `gh pr view <n> --json headRefOid`. `--sha <sha>` records a commit that is neither; the value must be 7 to 40 hex digits or the command exits 2 without writing. A change that has no `pr` on the board is an error, because `reviewed_sha` lives inside `pr`.

`sync <card-id>` reads `gh pr view` for every change of one card that carries a `pr.number`, and `sync --all` does the same for the whole board; the two are mutually exclusive. One run writes `board.yaml` at most once, whatever number of pull requests it read, so the console re-renders once; a run where nothing moved does not touch the file at all. A merged pull request also moves the change to `done`. A closed one records `pr.state: closed` and leaves `change.state` alone on purpose: closed can mean abandoned, superseded, or reopened next, and that call belongs to the commander. A change whose pull request is not on the branch recorded in `changes[].branch` is skipped with a warning and counted as a failure, and nothing is written for it — the same rule `pr --number` applies, so a wrong number cannot import an unrelated pull request's state. A change whose `head_sha` is not its `reviewed_sha` is reported on stderr as commits added after the review; that is a warning and the exit code stays 0. When one or more pull requests could not be read the command exits 1 with the rest still written, and it never reports the board as current in that run.

Do not use the `Agent` tool's `isolation: "worktree"` for a change: it names its own branch, which would not be the `overlord/<change-id>` branch recorded on the board.

The instruction is then sent to the new session:

```bash
cmux tree --all --json --id-format both     # find the new workspace and surface
cmux rpc surface.send_text '{"surface_id":"<uuid>","text":"<instruction>"}'
cmux send-key --surface <uuid> -- enter
```

Finally the session is written into the card, with `cwd` set to the worktree `start` printed:

```yaml
    agent:
      workspace_id: "33333333-3333-3333-3333-333333333333"
      surface_id: "44444444-4444-4444-4444-444444444444"
      cwd: "/Users/example/dev/project/.overlord/worktrees/OV-103-C2"
```

The console shows this session read-only on the card with a `cmux で開く` button. The identifiers become stale when the workspace is closed; the console then reports the session as not found. Work that does not need its own terminal — discovery, card creation, briefs, independent review — runs as a subagent inside the commander session and never appears in `agent`.

## エージェント名義の GitHub アカウント

Overlord が push する branch と作る pull request は、既定では `gh` のアクティブアカウント、つまり利用者本人の名義になる。`OVERLORD_GH_ACCOUNT` に `gh` のアカウント名を設定すると、その2つだけが別のアカウントの名義で行われる。

```bash
export OVERLORD_GH_ACCOUNT=<account>
```

これは監査のためだけの分離ではない。GitHub は pull request の作成者による自己承認を許さないため、「承認1件必須・bypass なし」の ruleset が main を守っている場合、**pull request が利用者以外の名義で作られていることが、利用者の承認なしに main へマージされないことの前提になる**。pull request が利用者名義に戻ると、この保証は失われる。

| 状態 | 挙動 |
| --- | --- |
| 未設定 | 従来どおり。`gh` のアクティブアカウントで push し、pull request を作る |
| 設定済み・解決できる | `gh auth token --user <account>` でトークンを読み、`gh` には `GH_TOKEN` として、`git push` には credential helper として、**そのサブプロセスにだけ**渡す |
| 設定済み・解決できない | 該当コマンドは非0で終了する。アクティブアカウントへフォールバックしない |

`OVERLORD_GH_TOKEN` にトークンを直接置くこともできる。`gh` の keyring にそのアカウントが無い環境向けで、設定されていれば `OVERLORD_GH_ACCOUNT` より優先される。

決めておくこと:

- **`gh auth switch` は使わない。** アクティブアカウントの切り替えはプロセス全体に永続的に効くため、並行して動く別の Overlord セッションと競合し、失敗したときに利用者のシェルが bot のままになる。トークンは各サブプロセスの環境変数として渡す。
- **トークンは argv・標準出力・標準エラー・ファイルのいずれにも出さない。** `git -c http.extraheader=...` やリモート URL への埋め込みはコマンドラインに載るため使わない。`git push` には `-c credential.helper=`（既存の helper を空にする）と、環境変数から読む helper の2つを渡す。空にする指定が要るのは、macOS の osxkeychain と `gh auth setup-git` が入れる `credential.https://github.com.helper` が先に応答すると、利用者の資格情報で push されるためである。
- **helper は要求されたホストを検査する。** git が標準入力に書く要求の `host=` が `GH_HOST`（既定は github.com）と一致し、かつ `protocol=https` のときだけ応答し、それ以外は何も出力せず exit 0 する。比較は大文字小文字を区別せず、`host` の末尾のポート（`:443`）は除く。git は `host=` と `protocol=` をリモート URL に書かれたままの表記で渡すため（`https://GitHub.com/o/r.git` は `host=GitHub.com`、`HTTPS://` は `protocol=HTTPS`）、区別すると大文字を含む URL のリモートで push が資格情報を得られなくなる。push リモートのホストは helper を入れる前に確認しているが、その確認では見えない経路（認証付きの `http.proxy`、別ホストへのリダイレクト）で、同じ `git push` の中から別ホストの資格情報が要求されうる。ホストが違えば「そのホストの資格情報は持っていない」と答えるのが正しい。helper は `store` と `erase` にも何も出力しない（トークンを macOS のキーチェーンに書き込ませないため）。
- **読み取りだけの `gh` 呼び出しも同じアカウントで実行する。** 書き込みだけを切り替える設計にすると「どの `gh` サブコマンドが書き込みか」の一覧を持つことになり、その一覧から漏れたサブコマンドが利用者名義で pull request を作る。ここで避けたい事故はそれ1つなので、`sync` や `reviewed` の読み取りも含めて一律に切り替える。代わりに、**エージェント用アカウントは Overlord を使う各リポジトリで read 権限以上を持っている必要がある**（pull request を作るためにどのみち write が要る）。
- push にこのアカウントが使われるのは、リモートが `https://github.com/...`（`GH_HOST` を設定している場合はそのホスト）のときだけである。それ以外のリモートの扱いは2つに分かれ、分かれ目は「利用者の資格情報に置き換わるかどうか」である。
  - **別ホストの https リモート（`https://gitlab.com/...`、`GH_HOST` が Enterprise ホストのときの `https://github.com/...` など）は push しない。** 非0で終了し、何も push せず board も書かない。トークンを他ホストへ送らないだけでは足りない。git は次の helper（macOS の osxkeychain、`gh auth setup-git` が入れたもの）に尋ね、それが利用者のアカウントで応答するため、push は利用者名義で成功してしまう。警告を出して push を通す形にすると、pull request が利用者名義で作られた後に stderr の1行が残るだけになり、ruleset の前提（作成者が利用者以外であること）が黙って崩れる。
  - **ssh リモート（`git@github.com:...`）とローカルパスのリモートは、トークンを送らずに警告を出して push する。** ここには置き換わる資格情報が無い。認証するのはその機械の鍵だけで、credential helper は呼ばれない。拒否すると、正しく動いているリポジトリを止めることになる。
  - `change identity` はどちらの場合も exit 1 で理由を出す。`push identity:` の行は前者で `(refused: another host)`、後者で `(not the agent account)` になる。

`change identity` はこの設定がこのリポジトリで機能するかを確認する。

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

順に、トークンが解決できること、そのトークンが名乗るアカウントが指定したアカウントと一致すること、そのアカウントがこのリポジトリで write を持つこと、push リモートがそのトークンで認証できるホストであることを確認する。どれかを満たさない場合は exit 1 で、満たさなかった項目を stderr に出す。アカウントが未設定の場合も exit 1 になる（この設問に対する答えが「いいえ」であるため）。アカウントの設定は全プロジェクト共通だが、リポジトリへのアクセス権はリポジトリごとに与えるものなので、新しいプロジェクトで Overlord を使い始めるときはこのコマンドで確認する。

`pr` と `deliver` は実行のたびに使用したアカウントを `agent account:` の行に出す。pull request を作るのはこの2つで、どちらの pull request も作成者が誰になったかは GitHub 上でしか確認できないため、実行時に名前を出す。値は解決できたアカウント名、`(none configured, using the active gh account)`、`(could not be resolved)` のいずれかである。

対象外: commit の author は変わらない。commit は各 change の worktree で利用者の git 設定のまま作られる。ruleset が見るのは pull request の作成者なので、この change の目的には commit の author は関係しない。

## change をマージする

`change merge <change-id>` は、レビュー済みで CI が通った change の pull request を、その pull request 自身の base ブランチへ **merge commit** でマージし、結果を board に記録する。

```bash
cd <project-directory>
/path/to/overlord/scripts/change.sh merge <change-id> [--board <path>]
```

引数は `<change-id>` 1つと `--board <path>` だけである。検査を外す引数は無い。次のいずれもマージを行わず exit 2 で終了する。

- `--base` / `--force` / `--admin` / `--squash` のような `--board` 以外のオプション（`change merge takes no option other than --board`）
- change id を2つ以上渡した場合（`change merge takes one change id, and was given 2`）。1つ目だけをマージして残りを無視することはしない
- 値を伴わないオプション（`change merge OV-1-C1 --board` など。`option --board needs a value`）

検査を外す環境変数も無い。

### 何を検査するか

マージの前に次を順に検査し、1つでも該当すれば **`gh pr merge` を呼ばず、`board.yaml` を1バイトも変更せず** exit 1 で終了する。判断材料は board の記録ではなく `gh pr view` で読んだ現在の pull request である。

1. **base ブランチ** — `baseRefName` が `main` または `master`（大小文字を区別しない）、あるいはリポジトリのデフォルトブランチと一致すれば拒否する。デフォルトブランチを特定できない場合も、判定できないので拒否する。base が空の pull request も拒否する。

   この検査でのデフォルトブランチは `gh repo view --json defaultBranchRef` を権威とし、`gh` が答えられない場合にだけ `git symbolic-ref --short refs/remotes/origin/HEAD` を使う（`deliver` の base 解決とは逆の順序である。「カードを配送する」の節を参照）。`refs/remotes/origin/HEAD` はローカルの symbolic ref で、検証されず、チェックアウトに書ける処理なら何にでも書き換えられる。存在しないブランチを指すこともできる。比較の片方（`baseRefName`）は GitHub から読んでいるので、もう片方も同じ出所にする。なお `main` と `master` はどちらの出所にもよらず名前で拒否するため、ローカルの ref が古いことが問題になりうるのは、デフォルトブランチが `main` でも `master` でもないリポジトリだけである。

2. **pull request の同一性** — `headRefName` が `changes[].branch` と一致しなければ拒否する。`pr --number` と `sync` が適用するのと同じ規則で、`pr.number` の誤りが無関係な pull request をマージすることを防ぐ。
3. **pull request の状態** — `state` が open でなければ拒否する。既にマージ済み、またはクローズ済みの pull request にはマージするものが無い。
4. **レビュー** — `changes[].pr.reviewed_sha` が記録されていない、または pull request の `headRefOid` と一致しなければ拒否する。短縮 SHA は前方一致で同一とみなすので、`reviewed --sha <7桁以上>` で記録した値もそのまま使える。
5. **CI** — `gh pr view --json statusCheckRollup` を読み、次のいずれかなら拒否する。
   - 失敗したチェックがある（`FAILURE` / `TIMED_OUT` / `CANCELLED` / `ACTION_REQUIRED` / `STARTUP_FAILURE` / `STALE`、status context なら `FAILURE` / `ERROR`）
   - 完了していないチェックがある（`COMPLETED` 以外の status、status context の `PENDING` / `EXPECTED`）
   - チェックが1件も無い（**未実行**として扱う。CI 導入前に作られた pull request がこの状態になる。このリポジトリの PR #24 が実例で、CI 導入前に作られたためチェックは0件だった）
   - 成功したチェックが1件も無い（全てが `SKIPPED` / `NEUTRAL`。検査されたものが無いという点でチェック0件と同じ）

`SKIPPED` と `NEUTRAL` のチェックは、成功したチェックが他に1件以上あれば妨げにならない。

### なぜ base ガードがあるか

change 単位の pull request（作業ブランチ向け）と、カードの配送 pull request（`deliver` が作るデフォルトブランチ向け）は、どちらも同じ `gh pr merge` でマージできてしまう。両者を機械的に区別できるのは base ブランチだけであり、後者をマージすることは「このカードをリリースする」という利用者の判断そのものである。

したがって base が `main` / `master` / デフォルトブランチの pull request は、このコマンドでは常に拒否する。**main / master へのマージは、常に利用者が行う。** `deliver` が作った配送 pull request の番号を `change merge` に渡しても、この規則で必ず拒否される。

### マージと board への記録

マージは `gh pr merge <n> --merge --match-head-commit <headRefOid>` だけを呼ぶ。merge commit のみで、squash と rebase は使わない（README「なぜ merge commit なのか」）。squash / rebase を選ぶ引数は無い。

`--match-head-commit` に渡すのは、上の検査を行った `gh pr view` が返した `headRefOid`、つまり `reviewed_sha` と一致することを確認した commit そのものである。検査とマージは別の `gh` 呼び出しなので、その間にブランチへ commit が push されうる。この引数があると、head がその commit でなくなっていれば GitHub 側がマージを拒否し、レビューされていない commit がマージされることはない。この理由でマージが失敗した場合は exit 1 で、stderr に `gh pr merge <n> --merge failed:` に続けて gh の理由と、どの commit を前提にしていたかを出す。

マージ後に `gh pr view <n> --json number,url,state,headRefOid,headRefName` をもう一度読み、**`sync` と同じ経路（`applyPullRequestView`）** で board に書く。したがって `changes[].pr` と `changes[].state: done` は、後から `sync` を実行した場合とまったく同じ値になり、`reviewed_sha` はそのまま保たれる。board への書き込みは1回だけで、カードの `state` は動かさない（カードを進めるのは司令塔の判断である）。

出力は他のサブコマンドと同じ体裁で、成功したときは次の行を印字する。

```text
change:           OV-111-C1
pull request:     #27 (open)
head branch:      overlord/OV-111-C1
base branch:      overlord-console
reviewed commit:  1a2b3c4d…
checks:           2 of 2 passed
merged:           #27 with a merge commit
change state:     done
board updated:    /Users/example/project/docs/product-ops/board.yaml
https://github.com/example/repo/pull/27
```

拒否されたときは `change:` から `checks:` までの行を stdout に、拒否の理由と `Nothing was merged and nothing was written to <board>` を stderr に出す。

exit code: マージした場合は 0、検査による拒否と git / `gh` / board の失敗は 1、引数エラーは 2。`gh pr merge` が成功した後に読み戻しや board への書き込みが失敗した場合も 1 で、pull request はマージ済みだが board は未記録である旨と、`change sync <card-id>` を実行するよう stderr に出す。

### 利用者が追加する許可規則

司令塔のセッションから `change.sh merge` を実行するには、Bash の許可規則が要る。利用者は自分の `settings.json`（`~/.claude/settings.json`、またはプロジェクトの `.claude/settings.json`）に、**`change.sh merge` だけ**を対象とする規則を追加する。Overlord 側はこのファイルを作成も編集もしない。

```json
{
  "permissions": {
    "allow": [
      "Bash(/path/to/overlord/scripts/change.sh merge:*)"
    ]
  }
}
```

`/path/to/overlord` は、司令塔が実際に打つのと同じ Overlord チェックアウトの絶対パスにする（`scripts/install.sh` がスキルの隣の `overlord-checkout` に書いた値）。前方一致なので、`change.sh merge <change-id> --board <path>` はこの1行で許可される。

**`gh pr merge` を直接許可する規則を案内してはならない。** 許可規則はコマンド文字列の前方一致で判定するのに対し、`gh pr merge <n> --merge` には pull request 番号しか現れず、base ブランチはコマンド文字列のどこにも含まれない。つまり許可規則では base を区別できない。`Bash(gh pr merge:*)` を許可すると、作業ブランチ向けの change の pull request と main 向けの配送 pull request が同じ規則で許可され、リリースの判断が利用者の手を離れる。`change.sh merge` を許可の単位にすれば、base の判定は実装側（上記の base ガード）で行われ、main / master / デフォルトブランチ向けの pull request は許可の有無にかかわらずマージされない。

## カードを配送する

`change deliver <card-id>` は、change が全て merged になったカードを 1 本の pull request にまとめてリポジトリのデフォルトブランチへ出し、その結果を `items[].delivery` に記録する。change 単位の `pr` がリポジトリ内のブランチ間の PR を作るのに対し、こちらはカード単位で 1 回だけ実行する。

```bash
cd <project-directory>
/path/to/overlord/scripts/change.sh deliver <card-id> [--base <branch>] [--head <branch>]
```

既定値:

- `--head` は main checkout の現在のブランチ。detached HEAD の場合はブランチが決まらないので、`--head <branch>` を明示しない限り失敗する。
- `--base` は「リポジトリのデフォルトブランチ」を次の順で解決する: `git symbolic-ref --short refs/remotes/origin/HEAD` からリモート名を取り除いた名前 → `gh repo view --json defaultBranchRef` → `main`。ここでローカルの ref を先に見るのは、ネットワーク呼び出しが要らず、誤った base は board へ書く前の `baseRefName` の確認で捕まるためである。`merge` の base ガードは誤りを見逃せないので逆の順序で解決する（「何を検査するか」の 1. を参照）。

同期が先、未マージならブロック:

1. まずそのカードの change のうち `pr.number` を持つものについて `gh pr view` を読み、`sync` と同じ規則で board に書き戻す。GitHub の web UI で merge された change を「未マージ」と誤判定しないための順序である。読めなかった PR と、`changes[].branch` と一致しない PR は警告として stderr に出し、その change は board 上の状態のまま残す。
2. 同期後に `state != done` の change が 1 つでも残っていれば `blocked` で終了する。この時点では pull request を作らず、`push` もせず、`items[].delivery` も書かない。未マージの change は `not merged:       <change-id>  <title>` の形で stderr に出る。

冪等性と、同一内容のときに PR を作らないこと:

- `--head` と `--base` の組で既に open な pull request があれば、`gh pr create` は呼ばれず `gh pr edit <n> --body <本文>` だけを呼ぶ。**title は渡さない**ので、人が付け直したタイトルは配送を繰り返しても戻らない。
- 本文はカードごとに `<!-- overlord:card <card-id> -->` … `<!-- /overlord:card <card-id> -->` で囲んだ節として差し込まれる。同じカードの節があれば置換し、無ければ末尾に追記するので、人が書いた説明文と他のカードの節はそのまま残る。
- `--head` が `--base` と同じブランチなら `skipped` (`same-branch`)。`git fetch origin <base>` の後 `git diff --quiet origin/<base> <head>` が exit 0（差分なし）なら `skipped` (`no-diff`)。どちらも pull request を作らない。`refs/remotes/origin/<base>` が無いリポジトリではローカルの `<base>` と比較する。`git fetch` の失敗は警告として stderr に出したうえで、その時点の ref と比較して続行する。

書き込みの順序は `pr` と同じで、`gh pr view <ref> --json number,url,state,headRefOid,headRefName,baseRefName` が `headRefName` と `baseRefName` の両方を確認した後にだけ board を書く。どちらかが違えば `failed` で終了し、`board.yaml` は 1 バイトも変わらない。

成功したときにカードへ書かれるのは `delivery` だけで、`state` や `changes` は動かない:

```yaml
    delivery:
      branch: "overlord-console"
      base: "main"
      pr:
        number: 12
        url: "https://github.com/example/repo/pull/12"
        state: "open"
        head_sha: "..."
        reviewed_sha: null
      error: null
      attempted_at: "2026-08-28T05:00:00Z"
```

exit code: 配送した (`created` / `updated`) と配送するものが無かった (`skipped`) は 0、`blocked` と `failed` は 1、引数エラーは 2。

## コンソールが自動で配送する

コンソールのサーバーは、カードが 完成確認待ち (`acceptance`) から 完了 (`done`) へ移ったときに、上と同じ配送を自動で実行する（`console/src/server.ts` の deliver 節）。ユーザーが `change deliver` を打つ場面を無くすためのもので、実行するのは `deliverCard`、つまり上と同一の処理である。

- **契機は 1 つだけ**: `PATCH /api/items/:id` が `state: "done"` を書き、かつ直前の状態が `acceptance` だったときに起動する。カードのモーダルの「受け入れて完了」がこの遷移を作る操作で、完成確認待ち 列から 完了 列へのドラッグも同じ PATCH になる。それ以外の列から 完了 列へドラッグした場合と、既に `done` のカードへの PATCH（2 回目のクリック、別のタブ）は board を書くだけで配送しない。
- **PATCH は配送を待たない**: 配送は `git fetch` / `git push` と複数の `gh` 呼び出しを行い数秒かかる。サーバーは board を書いた時点で応答し、配送の結果はイベントストリームで報告する。git と `gh` の 1 コマンドあたりのタイムアウトは 120 秒。
- **同一カードで多重起動しない**: そのカードの配送が走っている間に来た起動要求は、新しい実行を始めない。走っている実行が結果を報告する。ただし `running` フレームはこの場合も送る（下の表を参照）。リポジトリ単位の直列化は `deliverCard` 側にある。
- **失敗してもカードは戻らない**: 配送が失敗してもカードは `done` のままで、失敗は `items[].delivery.error` に記録される。ブラウザを閉じた後やイベントストリームが切れた後でも、PR が作られなかった理由がカードに残る。`branch` / `base` / `pr` は今回分かった値と前回の記録で埋めるので、失敗が過去に記録した pull request を消すことはない。
- **配送先が無いリポジトリは失敗ではない**: git リポジトリでない、またはリモートが無い場合は `skipped` (`no-repository` / `no-remote`) として報告する。それ以外の `git remote` の失敗は `failed`。

### 配送のイベント（SSE）

`/api/events` に `{"type":"delivery"}` フレームが流れる。カード ID は `card`。

```json
{"type":"delivery","card":"OV-105","status":"running"}
{"type":"delivery","card":"OV-105","status":"created","pr":{"number":12,"url":"https://github.com/example/repo/pull/12","state":"open","head_sha":"...","reviewed_sha":null},"warnings":[]}
```

| `status` | 意味 | 一緒に来るもの |
| --- | --- | --- |
| `running` | そのカードの配送を要求された。既に走っている配送があってこの要求が新しい実行を始めなかった場合にも送る（配送中であることを、要求した画面にも伝えるため） | なし（このフレームだけが `DeliverOutcome` ではない） |
| `created` / `updated` | 成果 pull request がある | `pr` |
| `skipped` | 配送するものが無い | `reason`: `no-diff` / `same-branch` / `no-remote` / `no-repository` |
| `blocked` | 未マージの change が残っている | `unmerged`: `"<change-id>  <title>"` の配列 |
| `failed` | git / `gh` / board のいずれかが失敗した | `reason`（同じ文字列が `delivery.error` にも入る） |

`warnings`（実行を止めなかった問題）は `running` 以外のフレームに必ず配列で付く。`head` と `base` は、失敗したがブランチまでは解決できた実行に付く。

`skipped` と `blocked` は `items[].delivery` を書かない（`blocked` は配送の手順 1 の同期で `changes[].pr` を書くことはある）。したがってこの 2 つの結果はこのフレームにしか残らない。コンソールの画面はフレームをカード単位で保持し、カードのモーダルの「成果の配送」に出す。

### 手動で配送し直す

```
POST /api/items/:id/deliver
```

body は不要。応答は `{"ok":true,"card":"<id>","started":true}` で、`started` が `false` のときは「そのカードの配送が既に走っていた」ことを表す（要求自体は受け付けている）。

- 自動の契機は `acceptance` -> `done` だけなので、既に `done` のカードを自動で配送し直すには、いったん 完成確認待ち へ戻してもう一度 完了 にするしかない。この endpoint は列を動かさずに同じ配送を実行する。失敗した配送からの復帰経路である。
- カードの状態は問わない。`change deliver` と同じ扱いで、未マージの change が残っていれば `deliverCard` が `blocked` で拒否する。
- 結果は上と同じ `delivery` フレームで届き、失敗は `delivery.error` に残る。
- 404: 不明なカード、または board が見つからない。409: そのサーバーで配送が無効化されている。
- 画面では、カードのモーダルの「成果の配送」に `配送をやり直す` として出る。出るのは次の2つの場合で、それ以外では出ない。
  - この画面が見ていた最後のフレームが `failed` または `blocked` だった
  - この画面が配送のフレームを1つも見ておらず、カードの `items[].delivery.error` に失敗が記録されている（前のセッションで失敗した配送。ブラウザを開き直しても復帰経路が残る）

  この画面が見た最後のフレームが結果（`running` 以外）であれば、それが board の記録より優先する。やり直しが成功すれば、失敗の記録が出していたボタンは消える。

### 配送を止める

```bash
/path/to/overlord/scripts/console.sh <project-directory> --no-deliver
OVERLORD_DELIVER=0 /path/to/overlord/scripts/console.sh <project-directory>
```

`OVERLORD_DELIVER` は `0` / `false` / `off` / `no`（大文字小文字を問わない）で無効になる。起動時の 4 行目に `deliver on done   off` と出る。`console.sh ensure` は `--no-deliver` をサーバーへ渡さないので、そちらでは `OVERLORD_DELIVER` を使う（環境変数はサーバープロセスへ引き継がれる）。

無効なサーバーでは、`acceptance` -> `done` で配送は起動せず、`POST /api/items/:id/deliver` は 409 と理由を返す。画面はこの応答をエラーとして表示する。
