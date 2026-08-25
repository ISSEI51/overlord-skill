# Product Operations Templates

## Work Item Board

```text
ID | Project | Title | State | Score | Owner agent | Next action | Blocker
```

States: `inbox`, `discovery`, `specified`, `implementing`, `reviewing`, `acceptance`, `done`, `blocked`.

## Weekly Triage

```text
For each ready item, score 1-5.

Impact:
Urgency:
Confidence:
Ease of safe delivery:
Business override, if any:
Decision: this week / discovery / later / stop
```

Select the three highest-priority decisions for the week. Implementation capacity is three items maximum. Keep other active capacity in discovery, specification, review, validation, and release follow-up.

## Completion Report

```text
Change ID:
User-visible change: 3 lines or fewer
Acceptance conditions: PASS / FAIL / unverified
Changed files: one-line reason per file
Verification: command or scenario and result
Risks or unknowns:
Review findings:
One user decision needed: or none
```

## Agent Dispatch

```text
Prepare <ID> for <state>.
Do not perform work outside the assigned state.
Use the improvement card and project rules as the source of truth.
Return only the artifact required by that state and list a single next action.
```
