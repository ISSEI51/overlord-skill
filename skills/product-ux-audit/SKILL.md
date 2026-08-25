---
name: product-ux-audit
description: Audit an application workflow for usability friction, interaction regressions, and recovery from errors using representative user scenarios. Use for product-quality inspection, not for visual redesign without a user flow.
---

# Product Ux Audit

Evaluate the experience through complete user tasks, not isolated screens or visual preference. Use existing representative scenarios when the project provides them. If none exist, propose up to five short scenarios before auditing; do not invent user research results.

For each scenario, identify the starting state, key actions, expected result, observable friction, and recovery behavior for predictable failures. Prefer measured or countable observations such as extra actions, waiting, ambiguity, accidental-action risk, or failed recovery.

Report findings in severity order. Each finding must contain:

```text
Scenario ID:
Observed behavior:
User impact:
Evidence or reproduction:
Likely cause: confirmed or hypothesis
Smallest useful improvement:
Acceptance condition:
```

Limit findings to five unless a user explicitly asks for a full audit. Do not implement fixes during the audit. Turn accepted findings into improvement cards with `product-improvement-card`.

## Artifact Board Update

For each accepted finding, update `docs/product-ops/board.yaml` first with a `discovery` card containing the scenario ID, evidence, severity, smallest useful improvement, and acceptance condition. Then update the existing `AI Product Operations Board` Artifact from those cards when Artifact editing is available. Do not create a new board. In a terminal-only client, update the YAML and return the equivalent `ARTIFACT_UPDATE` block after the audit.
