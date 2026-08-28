# Board Schema

Store the source of truth in `docs/product-ops/board.yaml`.

```yaml
version: 1
updated_at: "2026-08-25T00:00:00Z"
commander:
  workspace_id: "C06728B8-B8BA-4D83-A69D-9ADE254532CB"
  surface_id: "93EF686E-FAF3-4474-850A-0DEAC3C5BD8D"
  cwd: "/Users/example/dev/project"
decisions_required:
  - "RC-UX-001 の実装を承認する"
items:
  - id: "RC-UX-001"
    project: "RaidCoder"
    title: "ログイン後に元のURLへ戻る"
    state: "specified"
    priority:
      impact: 4
      urgency: 3
      confidence: 5
      ease: 4
      override: null
    evidence: "middleware が復帰先を渡さず、OAuth callback は / へ戻る"
    acceptance_conditions:
      - "認証後に元の内部URLへ戻る"
      - "外部URLには遷移しない"
    out_of_scope: "認証方式の追加"
    owner: null
    next_action: "実装ブリーフを作成する"
    blocker: null
    changes:
      - id: "RC-UX-001-C1"
        title: "redirect先を認証フローへ引き渡す"
        state: "implementing"
        agent:
          workspace_id: "50BC5A54-92C7-4A08-B31F-3DB33591D052"
          surface_id: "973ECD38-E9D7-4AF8-88AB-56F226E24C5B"
          cwd: "/Users/example/worktrees/RC-UX-001-C1"
        branch: "overlord/RC-UX-001-C1"
        pr:
          number: 12
          url: "https://github.com/example/repo/pull/12"
          state: "open"
          head_sha: null
          reviewed_sha: null
      - id: "RC-UX-001-C2"
        title: "callbackでredirect先を検証する"
        state: "specified"
        agent: null
        branch: null
        pr: null
    updated_at: "2026-08-25T00:00:00Z"
```

Use ISO 8601 timestamps in UTC. Do not store credentials, user code, full logs, or long documents in this file.

`decisions_required` holds at most three entries, each a string or an object with `id` and `question`. Overlord Console shows them as the day's decisions.

`commander` is the single cmux session the user talks to in Overlord Console. It is optional and holds cmux UUIDs. See [the console reference](console.md).

`project` names the product a card belongs to. Overlord Console shows it as a tag on the card and in the card detail header. The server writes it: `POST /api/items` takes the board's project when the board names exactly one and leaves it null when the board names none or more than one, so the "気づきを追加" dialog does not ask for it. A card id never encodes the project; a new id follows the prefix the board's other cards already use. Correct either afterwards with `PATCH /api/items/<id>` or by editing this file.

`changes` is the engineering split of one card, in dependency order. A card is a product outcome and a change is one delivery unit: 1 change = 1 worktree = 1 branch = 1 pull request = 1 agent execution unit. Splitting work into changes never adds cards to the kanban, and the console shows changes read-only inside the card.

| Field | Meaning |
| --- | --- |
| `id` | Derived from the card, e.g. `RC-UX-001-C1` |
| `title` | What this delivery unit changes |
| `state` | `specified`, `implementing`, `reviewing`, `done`, or `blocked`. `acceptance` never appears here: acceptance is the user's decision and belongs to the card |
| `agent` | The cmux session working this change. This is where new work records its session |
| `branch` | The branch for this change, e.g. `overlord/RC-UX-001-C1` |
| `pr` | `number`, `url`, `state` (`open` / `merged` / `closed`), `head_sha`, `reviewed_sha`. Unknown values stay null |

Every `pr` field has exactly one writer, so no agent edits the record by hand:

| Field | Written by |
| --- | --- |
| `number`, `url`, `state`, `head_sha` | `change.sh pr` when the pull request is opened or recorded, and `change.sh sync` on every later refresh |
| `reviewed_sha` | `change.sh reviewed`, run by the independent reviewer at the point it concludes that no blocking finding remains |

`pr` and `sync` carry `reviewed_sha` over untouched, and `reviewed` touches nothing but `reviewed_sha`, so a review result and a pull request refresh never overwrite each other. `head_sha` is the current head of the pull request and `reviewed_sha` is the commit a review actually read: while they differ, the change carries commits no review has read, `sync` says so, and the card is not ready for `acceptance`.

The card-level `agent` is kept for cards written before `changes` existed; when both are present the change's session wins. Cards without `changes` behave exactly as before.
