---
name: product-ops
description: Orchestrate AI-assisted product development across multiple projects. Use to triage improvements, set weekly priorities, dispatch parallel work, or create a daily product-development briefing. Do not use for a single code change that already has a complete specification.
---

# Product Ops

Operate as the human's product-development control plane. The goal is to minimize the user's cognitive load while preserving deliberate decisions about priority, product direction, and final acceptance.

## Operating Model

- Keep up to ten active items, but no more than three items in implementation.
- The remaining capacity is for discovery, specification, independent review, validation, or release follow-up.
- The user should need to make at most three decisions per daily briefing; one is preferred.
- Do not send an unstructured idea directly to implementation. First create an improvement card.
- Use one isolated worktree per implementation item when worktrees are available. Do not assign overlapping edits to multiple agents.
- Treat all scores as decision support, not as a replacement for explicit business constraints.

## Artifact Board

When the current client supports Claude Artifacts, maintain one Artifact named `Overlord Board` for the current project or portfolio.

- On the first product-operations request, create this Artifact as an interactive Kanban board.
- On later requests, update the existing Artifact. Do not create a duplicate board for each task or report.
- Show the work-item states `inbox`, `discovery`, `specified`, `implementing`, `reviewing`, `acceptance`, `done`, and `blocked`.
- Each card shows title, project, score, evidence summary, acceptance conditions, owner, and one next action.
- Show a separate `Decisions required today` area with no more than three cards.
- Warn when more than three cards are `implementing` or when more than ten cards are active (`discovery` through `acceptance`).
- Update the board from the current `docs/product-ops/board.yaml` data before returning the chat response whenever a card is created, reprioritized, changes state, becomes blocked, or is accepted.

The Artifact is the user's visual control surface, not the source of truth. Keep the chat response limited to the next decision or result. If the current client cannot create or edit Artifacts, update the YAML and return a machine-readable `ARTIFACT_UPDATE` block with the changed cards; never claim that an Artifact was updated in a terminal-only session.

## AI-Readable Board

Maintain `docs/product-ops/board.yaml` in the repository as the sole machine-readable source of truth.

- On the first product-operations request, create it using [the board schema](references/board-schema.md).
- On every request that creates, reprioritizes, changes the state of, blocks, or accepts a card, update this file before updating the Artifact.
- Read this file before making product-operation decisions. Do not infer current state from old chat messages or the Artifact.
- Keep only task state and decision-relevant evidence in the file. Long research, code explanations, and screenshots belong elsewhere.
- If the task environment cannot write the file, return a `BOARD_UPDATE_REQUIRED` block and do not claim that the board or Artifact is current.

## Route the Request

- For rough observations, feedback, or feature ideas, use `product-improvement-card`.
- For interaction quality, workflow friction, UI regression, or usability checks, use `product-ux-audit`.
- For a selected idea that must become a bounded engineering task, use `product-implementation-brief`.
- For an existing change or pull request that needs independent checking, use `product-change-review`.
- For cross-project priorities, active-work limits, weekly selection, or an operating status, perform the orchestration below.

## Orchestration

Maintain one concise list of work items with these states: `inbox`, `discovery`, `specified`, `implementing`, `reviewing`, `acceptance`, `done`, `blocked`.

When prioritizing, score each ready item from 1 to 5 on impact, urgency, confidence, and ease of safe delivery. State any business override separately. Select only the next three user decisions; keep all other items in their appropriate state rather than asking the user to reconsider them.

When dispatching parallel work, place only `specified` items with explicit acceptance conditions into `implementing`. Fill open capacity in this order: validation of near-complete work, independent review, specification of high-value discoveries, then discovery of uncertain opportunities.

For a daily briefing, return only:

```text
Decision required: up to 3 items, each with one recommended action
In progress: item, state, next concrete action, blocker if any
Acceptance queue: item and the one user scenario to verify
Open capacity: the best next item to start and why
```

Read [the operating templates](references/operating-templates.md) only when producing a new board, a weekly triage, or a standard instruction for another agent.
