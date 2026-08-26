---
name: product-change-review
description: Independently review a proposed or completed product change for requirement gaps, regressions, unsafe behavior, and missing verification. Use after implementation; do not make code changes unless explicitly requested.
---

# Product Change Review

Review independently of the implementation author. Compare the change to its improvement card or implementation brief, existing behavior, project rules, and relevant tests. Focus on defects and unverified risk, not explanation of the code.

For each finding, include the severity, exact evidence, reproduction or failure path, affected behavior, and whether it blocks acceptance. Do not report speculative style preferences as defects.

Return findings first, ordered by severity. Then return this compact acceptance summary:

```text
Acceptance conditions: PASS / FAIL / unverified for each condition
Regression coverage:
Required follow-up: none or the smallest blocking action
User verification: the one representative scenario worth checking manually
```

If no findings are present, state `No blocking findings.` and identify any tests or scenarios that remain unverified.

## Board Update

Update the matching card in `docs/product-ops/board.yaml`. Set it to `implementing` when blocking fixes remain, `acceptance` when no blocking findings remain but user verification is required, or `done` only after acceptance is confirmed. Record only the compact review outcome, blockers, and one manual scenario. Overlord Console renders the file, so no separate board update is needed. If the file cannot be written, return a `BOARD_UPDATE_REQUIRED` block and do not claim that the board is current.
