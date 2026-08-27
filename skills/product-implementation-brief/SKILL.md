---
name: product-implementation-brief
description: Convert an accepted improvement card into a bounded, testable implementation brief with a small change surface. Use immediately before coding or delegating a worktree; do not perform the implementation itself.
---

# Product Implementation Brief

Prepare one change that another agent can implement safely without rediscovering product decisions. Inspect the existing codebase and project rules before writing the brief. Do not modify files.

Do not approve a broad task as written. When the work needs more than five files, a new dependency, a data migration, or several independently reviewable steps, split it into **changes under the same card** and state their dependency order. A change is one engineering delivery unit: 1 change = 1 worktree = 1 branch = 1 pull request = 1 agent execution unit.

Splitting into changes is the default. Create a new top-level card only when the split produces a separate product outcome the user could prioritize, approve, ship, or cancel on its own. Never create a card because the file count is large, because the work spans backend and frontend, API and UI, or a migration, because agents could run in parallel, or because a pull request would be easier to review. Those are reasons to add a change, not a card.

Return:

```text
Change ID and title:
User-visible outcome: 3 lines or fewer
Current behavior and source locations:
Chosen approach:
Files likely to change and one-line reason for each:
Acceptance conditions:
Out of scope:
Verification plan: automated tests and representative scenarios
Risks and rollback:
Size: S / M / split into changes
Changes: id, title, and worktree boundary for each, in dependency order
Worktree boundary: files or modules the task owns
```

The brief is ready for implementation only when every acceptance condition has a concrete verification method.

## Board Update

Update the matching card in `docs/product-ops/board.yaml`: add the chosen approach, worktree boundary, verification plan, and risk; set the state to `specified` only when the brief is ready.

When the work is split, write the pieces to the card's `changes` list in dependency order and keep the card itself moving forward. Do not send the card back to `discovery`, and do not add top-level cards for the pieces. Give each change an id derived from the card (`RC-UX-001-C1`), a title, and the state `specified`; leave `agent`, `branch`, and `pr` null until the change starts. See [the board schema](../product-ops/references/board-schema.md).

Overlord Console renders the file, so no separate board update is needed. If the file cannot be written, return a `BOARD_UPDATE_REQUIRED` block and do not claim that the board is current.
