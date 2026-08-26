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
    agent:
      workspace_id: "50BC5A54-92C7-4A08-B31F-3DB33591D052"
      surface_id: "973ECD38-E9D7-4AF8-88AB-56F226E24C5B"
      cwd: "/Users/example/worktrees/RC-UX-001"
    updated_at: "2026-08-25T00:00:00Z"
```

Use ISO 8601 timestamps in UTC. Do not store credentials, user code, full logs, or long documents in this file.

`decisions_required` holds at most three entries, each a string or an object with `id` and `question`. Overlord Console shows them as the day's decisions.

`commander` is the single cmux session the user talks to in Overlord Console. `agent` is the worker session the commander started for that card. Both are optional and hold cmux UUIDs. See [the console reference](console.md).
