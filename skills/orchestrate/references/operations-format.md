# Slice operations

Use `state.json` as the current initiative state and audit record.
Read [state-schema.md](state-schema.md) before creating or changing an operations record.
The state record keeps delivery lineage, review waves, lanes, findings paths, supervision, recovery, and user gates.
The orchestrator appends an audit entry at each accepted or rejected patch.
The orchestrator does not add an audit entry after an unchanged wait.

```json
{
  "slices": {
    "slice-slug": {
      "status": "in-progress",
      "worker": {
        "id": "D1",
        "role": "delivery",
        "lineage": ["D1", "D2"],
        "restartReason": null
      },
      "reviewLanes": [
        {
          "name": "security",
          "status": "complete",
          "findingsPath": "docs/plans/initiative/slice-slug/lanes/security/findings.md"
        }
      ],
      "findingsPath": "docs/plans/initiative/slice-slug/findings.md",
      "supervision": {
        "expectedAt": "2026-01-01T00:15:00Z",
        "nextObservationAt": "2026-01-01T00:20:00Z",
        "fallbackMinutes": 5,
        "lastMeaningfulEvent": "2026-01-01T00:00:00Z"
      }
    }
  },
  "audit": [
    {
      "at": "2026-01-01T00:00:00Z",
      "kind": "patch-accepted",
      "summary": "Started delivery for slice-slug"
    }
  ]
}
```
