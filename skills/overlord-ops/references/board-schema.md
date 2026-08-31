# Board Schema

Store the source of truth in `docs/product-ops/board.yaml`.

```yaml
version: 1
updated_at: "2026-08-25T00:00:00Z"
commander:
  workspace_id: "11111111-1111-1111-1111-111111111111"
  surface_id: "22222222-2222-2222-2222-222222222222"
  cwd: "/Users/example/dev/project"
decisions_required:
  - "NOTE-031 の実装を承認する"
items:
  - id: "NOTE-031"
    project: "Notes App"
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
      - id: "NOTE-031-C1"
        title: "redirect先を認証フローへ引き渡す"
        state: "implementing"
        agent:
          workspace_id: "33333333-3333-3333-3333-333333333333"
          surface_id: "44444444-4444-4444-4444-444444444444"
          cwd: "/Users/example/worktrees/NOTE-031-C1"
        branch: "overlord/NOTE-031-C1"
        pr:
          number: 12
          url: "https://github.com/example/repo/pull/12"
          state: "open"
          head_sha: null
          reviewed_sha: null
      - id: "NOTE-031-C2"
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
| `id` | Derived from the card, e.g. `NOTE-031-C1` |
| `title` | What this delivery unit changes |
| `state` | `specified`, `implementing`, `reviewing`, `done`, or `blocked`. `acceptance` never appears here: acceptance is the user's decision and belongs to the card |
| `agent` | The cmux session working this change. This is where new work records its session |
| `branch` | The branch for this change, e.g. `overlord/NOTE-031-C1` |
| `pr` | `number`, `url`, `state` (`open` / `merged` / `closed`), `head_sha`, `reviewed_sha`. Unknown values stay null |

Every `pr` field has exactly one writer, so no agent edits the record by hand:

| Field | Written by |
| --- | --- |
| `number`, `url`, `state`, `head_sha` | `change.sh pr` when the pull request is opened or recorded, and `change.sh sync` on every later refresh. `change.sh merge` writes them too, through the same function `sync` uses, so a merge records what the next `sync` would have recorded |
| `reviewed_sha` | `change.sh reviewed`, run by the independent reviewer at the point it concludes that no blocking finding remains |

`pr`, `sync` and `merge` carry `reviewed_sha` over untouched, and `reviewed` touches nothing but `reviewed_sha`, so a review result and a pull request refresh never overwrite each other. `merge` also reads `reviewed_sha`: a change whose `reviewed_sha` is missing or is not the pull request head is not merged. `head_sha` is the current head of the pull request and `reviewed_sha` is the commit a review actually read: while they differ, the change carries commits no review has read, `sync` says so, and the card is not ready for `acceptance`.

`delivery` is the card-level pull request that proposes the finished card to the repository default branch: the branch the card's work sits on (`branch`) against that default branch (`base`). It appears once a delivery has been attempted, and is absent on every other card — a card is delivered only after every one of its changes is merged, so the example above, whose changes are still open, has none. One card holds one delivery record, rewritten on every attempt, so it says what the last attempt did rather than keeping a history.

```yaml
    delivery:
      branch: "overlord/NOTE-031"
      base: "main"
      pr:
        number: 34
        url: "https://github.com/example/repo/pull/34"
        state: "open"
        head_sha: "9f1c2ab"
        reviewed_sha: null
      error: null
      attempted_at: "2026-08-26T09:12:00Z"
```

| Field | Meaning |
| --- | --- |
| `branch` | Head branch the delivery pull request was opened from |
| `base` | Branch it merges into: the repository default branch unless `--base` said otherwise |
| `pr` | The delivery pull request, in the same shape as a change's: `number`, `url`, `state`, `head_sha`, `reviewed_sha`. `reviewed_sha` stays null, because the review happened on the changes |
| `error` | `null` when the last attempt recorded a pull request; the diagnostic of the failure otherwise |
| `attempted_at` | When the attempt this record describes ran |

| Written by | When |
| --- | --- |
| `change.sh deliver <card-id>` | After `gh pr view` confirmed the pull request's `headRefName` and `baseRefName`. Writes the whole record with `error: null` |
| Overlord Console | The same code, run by the server when a card moves 完成確認待ち -> 完了, and by `POST /api/items/:id/deliver`. A failure is recorded by the server with the diagnostic in `error`, keeping the branches and the pull request the attempt or the previous record knew |

No agent edits this record by hand, and nothing else writes it: a delivery touches neither `state` nor `changes`, and a failed delivery does not move the card out of `done`. A run that had nothing to deliver (`skipped`) or that found unmerged changes (`blocked`) writes no `delivery` at all - a blocked one may still write `changes[].pr`, because it synchronizes the change pull requests before it decides - so those two outcomes leave whatever `delivery` the card already had, or none. See [the console reference](console.md) for every outcome and the event they are reported on.

The card-level `agent` is kept for cards written before `changes` existed; when both are present the change's session wins. Cards without `changes` behave exactly as before.
