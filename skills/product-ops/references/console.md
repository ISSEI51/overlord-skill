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
  workspace_id: "C06728B8-B8BA-4D83-A69D-9ADE254532CB"
  surface_id: "93EF686E-FAF3-4474-850A-0DEAC3C5BD8D"
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

```bash
scripts/change.sh start <change-id>     # worktree と overlord/<change-id> ブランチを作り board に記録
cmux new-workspace --cwd <出力された worktree パス> --command claude
# 実装・検証・独立レビューの後
scripts/change.sh pr <change-id>        # push して PR を作り change.pr を記録
```

`start` prints the worktree path on its last line and writes `changes[].branch` plus `changes[].state: implementing`. `pr` pushes the branch, opens the pull request — or reuses the one already open for that branch — and writes `changes[].pr` (`number`, `url`, `state`, `head_sha`) plus `changes[].state: reviewing`. `pr --number <n>` records a pull request that was opened from the GitHub web UI instead of creating one. Both commands leave `board.yaml` untouched when the git or `gh` step fails, so they can be run again.

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
      workspace_id: "50BC5A54-92C7-4A08-B31F-3DB33591D052"
      surface_id: "973ECD38-E9D7-4AF8-88AB-56F226E24C5B"
      cwd: "/Users/example/worktrees/RC-UX-001"
```

The console shows this session read-only on the card with a `cmux で開く` button. The identifiers become stale when the workspace is closed; the console then reports the session as not found. Work that does not need its own terminal — discovery, card creation, briefs, independent review — runs as a subagent inside the commander session and never appears in `agent`.
