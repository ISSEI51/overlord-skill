# Overlord Console

Overlord Console is a localhost web dashboard for `docs/product-ops/board.yaml`. It replaces the earlier `Overlord Board` Artifact, which could not reach a local process because Artifacts are served under a content security policy that blocks requests to any external host, including `127.0.0.1`.

## Start

```bash
/path/to/overlord/scripts/console.sh <project-directory> [--port 7377] [--open]
```

`--open` creates a cmux browser split showing the console. The server binds to `127.0.0.1` only and rejects requests whose `Host` or `Origin` header is not loopback.

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
# 状態を報告する前、マージの後
/path/to/overlord/scripts/change.sh sync <card-id>         # カードの各 change の PR 状態を board に反映
# カードの change が全て merged になった後
/path/to/overlord/scripts/change.sh deliver <card-id>      # カードをデフォルトブランチへ出す PR を作り item.delivery に記録
```

Every subcommand takes `--board <path>` (a `board.yaml`, or a project directory containing one) when the board is not the one under the current directory; without it they fall back to `$OVERLORD_BOARD` and then to the current directory. `start` and `pr` also take `--base <branch>`, which defaults to the current branch of the main checkout: `start` branches from it and `pr` opens the pull request against it. A change that builds on the previous one is stacked by passing `--base overlord/<前の change-id>` to both commands, so its diff shows only its own work.

Exit codes are the same for all five: 0 when the command did what it says, 1 when a git, `gh` or board step failed, and 2 for a usage or argument error. A failure leaves `board.yaml` untouched.

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
