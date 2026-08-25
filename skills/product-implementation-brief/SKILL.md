---
name: product-implementation-brief
description: Convert an accepted improvement card into a bounded, testable implementation brief with a small change surface. Use immediately before coding or delegating a worktree; do not perform the implementation itself.
---

# Product Implementation Brief

Prepare one change that another agent can implement safely without rediscovering product decisions. Inspect the existing codebase and project rules before writing the brief. Do not modify files.

Do not approve a broad task as written. If it needs more than five files, a new dependency, a data migration, or a behavior change outside the stated acceptance conditions, split it into smaller briefs and explain the dependency order.

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
Size: S / M / split required
Worktree boundary: files or modules the task owns
```

The brief is ready for implementation only when every acceptance condition has a concrete verification method.

## Artifact Board Update

Update the matching card in `docs/product-ops/board.yaml` first: add the chosen approach, worktree boundary, verification plan, and risk; set the state to `specified` only when the brief is ready. If the work must be split, create the dependent cards and keep the original card in `discovery`. Then update the existing `Overlord Board` Artifact from the YAML state when Artifact editing is available. In a terminal-only client, update the YAML and return the equivalent `ARTIFACT_UPDATE` block after the brief.
