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

For an `implementing` card, the commander starts one workspace per card and records it, so the console can show who owns the card:

```bash
cmux new-workspace --name "RC-UX-001 ログイン後の復帰" \
  --cwd /Users/example/worktrees/RC-UX-001 --command claude
cmux tree --all --json --id-format both     # find the new workspace and surface
cmux rpc surface.send_text '{"surface_id":"<uuid>","text":"<instruction>"}'
cmux send-key --surface <uuid> -- enter
```

Then write the worker session into the card:

```yaml
    agent:
      workspace_id: "50BC5A54-92C7-4A08-B31F-3DB33591D052"
      surface_id: "973ECD38-E9D7-4AF8-88AB-56F226E24C5B"
      cwd: "/Users/example/worktrees/RC-UX-001"
```

The console shows this session read-only on the card with a `cmux で開く` button. The identifiers become stale when the workspace is closed; the console then reports the session as not found. Work that does not need its own terminal — discovery, card creation, briefs, independent review — runs as a subagent inside the commander session and never appears in `agent`.
