# Board Schema

Store the source of truth in `docs/product-ops/board.yaml`.

```yaml
version: 1
updated_at: "2026-08-25T00:00:00Z"
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
    updated_at: "2026-08-25T00:00:00Z"
```

Use ISO 8601 timestamps in UTC. Do not store credentials, user code, full logs, or long documents in this file.
