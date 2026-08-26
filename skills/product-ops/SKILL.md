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

## Console Board

The user's visual control surface is Overlord Console, a localhost dashboard that renders `docs/product-ops/board.yaml` and connects each card to a cmux agent session. See [the console reference](references/console.md).

- The console holds no state of its own. It reads the YAML file and re-renders when the file changes, so writing the file is the only step needed to update the user's view.
- Do not create or update a Claude Artifact for the board.
- The console shows the states `inbox`, `discovery`, `specified`, `implementing`, `reviewing`, `acceptance`, `done`, and `blocked`, a `Decisions required today` area limited to three cards, and a warning when more than three cards are `implementing` or more than ten cards are active (`discovery` through `acceptance`).
- The user can move a card between states and edit `next_action`, `owner`, and `blocker` in the console. Read the file again before acting; do not assume the state you last wrote is still current.

Keep the chat response limited to the next decision or result.

## Commander and Subagents

The console has one fixed session, the commander, and the user talks only to it. Every card's work is dispatched by the commander, never chosen by the user.

- When this session is the commander, keep the top-level `commander` pointer in `docs/product-ops/board.yaml` current. Read your own session with `cmux identify --json --id-format both` and store `workspace_id` and `surface_id`.
- Never ask the user to pick, open, or switch a cmux session. If work needs a session, create it.
- For an `implementing` card, start one cmux workspace per card on its own worktree and record it in the card's `agent` field, so the console can show which session owns the card. See [the console reference](references/console.md) for the exact commands.
- For discovery, card creation, implementation briefs, and independent review, run a subagent inside this session instead of a new workspace, then write the result to the board.
- Run the independent review with a different subagent from the one that implemented the change. Do not let an implementing subagent accept its own work.
- Report back in the commander session only: the decision needed, or the result. Do not tell the user which subagent produced it unless they ask.

## AI-Readable Board

Maintain `docs/product-ops/board.yaml` in the repository as the sole machine-readable source of truth.

- On the first product-operations request, create it using [the board schema](references/board-schema.md).
- On every request that creates, reprioritizes, changes the state of, blocks, or accepts a card, update this file. The console reflects the change; there is no separate visual update step.
- Read this file before making product-operation decisions. Do not infer current state from old chat messages or from what the console showed earlier.
- Keep only task state and decision-relevant evidence in the file. Long research, code explanations, and screenshots belong elsewhere.
- If the task environment cannot write the file, return a `BOARD_UPDATE_REQUIRED` block and do not claim that the board is current.

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
