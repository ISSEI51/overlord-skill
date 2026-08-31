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
```

Every subcommand takes `--board <path>` (a `board.yaml`, or a project directory containing one) when the board is not the one under the current directory; without it they fall back to `$OVERLORD_BOARD` and then to the current directory. `start` and `pr` also take `--base <branch>`, which defaults to the current branch of the main checkout: `start` branches from it and `pr` opens the pull request against it. A change that builds on the previous one is stacked by passing `--base overlord/<前の change-id>` to both commands, so its diff shows only its own work.

Exit codes are the same for all six: 0 when the command did what it says, 1 when a git, `gh` or board step failed, and 2 for a usage or argument error. A failure leaves `board.yaml` untouched.

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

## change をマージする

`change merge <change-id>` は、レビュー済みで CI が通った change の pull request を、その pull request 自身の base ブランチへ **merge commit** でマージし、結果を board に記録する。

```bash
cd <project-directory>
/path/to/overlord/scripts/change.sh merge <change-id> [--board <path>]
```

引数は `<change-id>` と `--board <path>` だけである。検査を外す引数は無い。`--base` / `--force` / `--admin` / `--squash` のような他の引数を渡すと、マージせず exit 2 で終了する（`change merge takes no option other than --board`）。検査を外す環境変数も無い。

### 何を検査するか

マージの前に次を順に検査し、1つでも該当すれば **`gh pr merge` を呼ばず、`board.yaml` を1バイトも変更せず** exit 1 で終了する。判断材料は board の記録ではなく `gh pr view` で読んだ現在の pull request である。

1. **base ブランチ** — `baseRefName` が `main` または `master`（大小文字を区別しない）、あるいはリポジトリのデフォルトブランチと一致すれば拒否する。デフォルトブランチを特定できない場合（`git symbolic-ref --short refs/remotes/origin/HEAD` と `gh repo view --json defaultBranchRef` のどちらも答えない場合）も、判定できないので拒否する。base が空の pull request も拒否する。
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

マージは `gh pr merge <n> --merge` だけを呼ぶ。merge commit のみで、squash と rebase は使わない（README「なぜ merge commit なのか」）。squash / rebase を選ぶ引数は無い。

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
- `--base` は「リポジトリのデフォルトブランチ」を次の順で解決する: `git symbolic-ref --short refs/remotes/origin/HEAD` からリモート名を取り除いた名前 → `gh repo view --json defaultBranchRef` → `main`。

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
