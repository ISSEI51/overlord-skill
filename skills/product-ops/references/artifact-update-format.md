# Artifact Update Format

Use this only when the current client cannot create or update a Claude Artifact. It allows a main Claude App chat to update the existing `Overlord Board` without reinterpreting a long report.

```json
{
  "artifact": "Overlord Board",
  "project": "<project>",
  "changes": [
    {
      "id": "<card-id>",
      "title": "<title>",
      "state": "inbox | discovery | specified | implementing | reviewing | acceptance | done | blocked",
      "score": 0,
      "evidence": "<short evidence>",
      "acceptance_conditions": ["<condition>"],
      "next_action": "<single action>",
      "blocker": null
    }
  ],
  "decisions_required": ["<up to three decisions>"]
}
```

Do not include unchanged cards. `score` is omitted when the card is not ready for prioritization.
