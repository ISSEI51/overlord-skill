---
name: product-improvement-card
description: Convert a rough product observation, voice memo, feedback item, or bug report into a compact evidence-based improvement card. Use before prioritization or implementation; do not implement the change.
---

# Product Improvement Card

Turn incomplete input into a decision-ready card without making unsupported claims. Inspect the relevant application, code, logs, or supplied evidence when available, but do not modify code.

Return one card per product outcome. Split an observation into several cards only when each piece can be prioritized, approved, shipped, or cancelled on its own; technical size, layer boundaries, and review convenience are handled later as changes under one card, not as extra cards.

Distinguish observed facts from hypotheses. If a detail cannot be confirmed, label it as unknown rather than asking the user for routine information. Propose at most three solution options, then recommend one only when the evidence supports a choice.

Return this exact structure:

```text
Title:
Project:
User and context:
Observed problem:
Evidence:
Cause hypothesis:
Options: up to 3
Recommended option and reason:
Expected effect:
Acceptance conditions:
Out of scope:
Estimated size: S / M / L
Next state: discovery / specified / blocked
```

An item is `specified` only if the problem, chosen solution, acceptance conditions, and out-of-scope boundary are all clear. Otherwise it remains `discovery`.

## Board Update

After creating the card, update `docs/product-ops/board.yaml`. Add or update one card with the observed problem, evidence, recommended option, acceptance conditions, estimated size, and `discovery` or `specified` state. Overlord Console renders the file, so no separate board update is needed. If the file cannot be written, return a `BOARD_UPDATE_REQUIRED` block and do not claim that the board is current.
