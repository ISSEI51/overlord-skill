---
name: overlord-ops
description: Orchestrate AI-assisted product development across multiple projects. Use to triage improvements, set weekly priorities, dispatch parallel work, or create a daily product-development briefing. Do not use for a single code change that already has a complete specification.
---

# Product Ops

Operate as the human's product-development control plane. The goal is to minimize the user's cognitive load while preserving deliberate decisions about priority, product direction, and final acceptance.

## Operating Model

- Keep up to ten active items, but no more than three items in implementation.
- The remaining capacity is for discovery, specification, independent review, validation, or release follow-up.
- The user should need to make at most three decisions per daily briefing; one is preferred.
- Do not send an unstructured idea directly to implementation. First create an improvement card.
- Use one isolated worktree per change when worktrees are available. Do not assign overlapping edits to multiple agents.
- Treat all scores as decision support, not as a replacement for explicit business constraints.

## Console Board

The user's visual control surface is Overlord Console, a localhost dashboard that renders `docs/product-ops/board.yaml` and connects each card to a cmux agent session. See [the console reference](references/console.md).

- On the first product-operations request, bring the console up once from the project root. The installed skill does not carry `scripts/`, so call the Overlord checkout recorded next to this skill:

  ```bash
  cd <project-directory>
  "$(cat <skill-dir>/overlord-checkout)/scripts/console.sh" ensure .
  ```

  `<skill-dir>` is this skill's own directory; `scripts/install.sh` writes the absolute path of the Overlord checkout into the `overlord-checkout` file there. The command is idempotent: it creates `docs/product-ops/board.yaml` when it is missing, starts the server only when nothing is serving that board yet, and otherwise prints the address and starts nothing. Running it on every request is therefore safe. Give the user the printed `console:` address — the command never opens a browser. When cmux is not reachable, only the commander registration is skipped; the console itself still comes up and the user can register the session from the sidebar. When the port is already serving a different project's board, the command exits 1 without starting anything; run it again with `--port <n>` on a free port instead of stopping the other console.
- The console holds no state of its own. It reads the YAML file and re-renders when the file changes, so writing the file is the only step needed to update the user's view.
- Do not create or update a Claude Artifact for the board.
- The console shows the states `inbox`, `discovery`, `specified`, `implementing`, `reviewing`, `acceptance`, `done`, and `blocked`, a `Decisions required today` area limited to three cards, and a warning when more than three cards are `implementing` or more than ten cards are active (`discovery` through `acceptance`).
- The user can move a card between states and edit `next_action`, `owner`, and `blocker` in the console. Read the file again before acting; do not assume the state you last wrote is still current.

Keep the chat response limited to the next decision or result.

## Cards, Changes, and Tasks

The board carries three levels, and only the first one is the user's to manage.

| Level | Meaning | Where it lives |
| --- | --- | --- |
| Card | One product outcome; the human decision unit | A top-level item on the kanban |
| Change | One engineering delivery unit: 1 worktree = 1 branch = 1 pull request = 1 agent execution unit | The card's `changes` list, read-only in the console |
| Task | One step inside an agent's run | Inside the agent; never on the board |

Keep the number of cards equal to the number of decisions the user has to make. Split work into changes freely; split it into cards almost never.

Add a top-level card only when the piece is a product outcome that can be prioritized, approved, shipped, or cancelled on its own, has its own acceptance conditions, or belongs to a different release or owner. Do not add a card because there are many files, because the work spans backend and frontend, API, database, or UI, because it needs a new dependency or a migration, because agents could run in parallel, or because a pull request would be smaller or easier to review. Those call for another change under the same card.

A card keeps moving forward while its changes run: it enters `implementing` when the first change starts and stays there until every change is done. Never send a card back to `discovery` because it was split. The active-work limits count cards, not changes. Each change records its own `agent`, `branch`, and `pr`; the card-level `agent` remains only for cards written before changes existed.

## Commander and Subagents

The console has one fixed session, the commander, and the user talks only to it. Every card's work is dispatched by the commander, never chosen by the user.

- When this session is the commander, keep the top-level `commander` pointer in `docs/product-ops/board.yaml` current. Read your own session with `cmux identify --json --id-format both` and store `workspace_id` and `surface_id`.
- Never ask the user to pick, open, or switch a cmux session. If work needs a session, create it.
- For an `implementing` card, start one cmux workspace per change on its own worktree and record it in that change's `agent` field, so the console can show which session owns the work. A card without a `changes` list is a single change; record the session on the card's `agent` as before. See [the console reference](references/console.md) for the exact commands.
- For discovery, card creation, implementation briefs, and independent review, run a subagent inside this session instead of a new workspace, then write the result to the board.
- Run the independent review with a different subagent from the one that implemented the change. Do not let an implementing subagent accept its own work. The reviewer records the commit it read with `change.sh reviewed <change-id>`; a change whose `reviewed_sha` is not its `head_sha` is not ready for acceptance.
- Before reporting status or deciding whether a card is complete, refresh each change's pull request state on the board: from the project directory, run `/path/to/overlord/scripts/change.sh sync <card-id>` with the absolute path of the Overlord checkout, as in [the console reference](references/console.md).
- Report back in the commander session only: the decision needed, or the result. Do not tell the user which subagent produced it unless they ask.

## AI-Readable Board

Maintain `docs/product-ops/board.yaml` in the repository as the sole machine-readable source of truth.

- On the first product-operations request, create it using [the board schema](references/board-schema.md). `console.sh ensure` only writes the empty skeleton, so filling the board is still this skill's work.
- On every request that creates, reprioritizes, changes the state of, blocks, or accepts a card, update this file. The console reflects the change; there is no separate visual update step.
- Read this file before making product-operation decisions. Do not infer current state from old chat messages or from what the console showed earlier.
- Keep only task state and decision-relevant evidence in the file. Long research, code explanations, and screenshots belong elsewhere.
- If the task environment cannot write the file, return a `BOARD_UPDATE_REQUIRED` block and do not claim that the board is current.

## Route the Request

- For rough observations, feedback, or feature ideas, use `overlord-improvement-card`.
- For interaction quality, workflow friction, UI regression, or usability checks, use `overlord-ux-audit`.
- For a selected idea that must become a bounded engineering task, use `overlord-implementation-brief`.
- For an existing change or pull request that needs independent checking, use `overlord-change-review`.
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
