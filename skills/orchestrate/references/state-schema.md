# Orchestration state schema

The initiative `state.json` file is the runtime source of truth.
The orchestrator writes `map.puml` from `state.json` after each accepted state change.
The `plan.md` file remains the accepted human plan.
The state file keeps current state, the latest worker event, and append-only audit records.

## Required structure

The state file has this shape.

```json
{
  "schemaVersion": 1,
  "initiative": "initiative-slug",
  "status": "active",
  "pendingUserGate": null,
  "slices": {
    "parent-slice": {
      "parent": null,
      "outcome": "one observable result",
      "startingSurface": "route or command",
      "doneSignal": "exact command or observation",
      "dependencies": [],
      "status": "not-started",
      "worker": null,
      "reviewLanes": [],
      "findingsPath": "docs/plans/initiative-slug/parent-slice/findings.md",
      "supervision": null
    }
  },
  "latestEvent": {
    "kind": "worker-result",
    "at": "2026-01-01T00:00:00Z",
    "worker": "Develop parent-slice",
    "summary": "FIT"
  },
  "audit": []
}
```

Each slice has one parent or `null`.
Only a leaf slice can have a worker or move to `in-progress`.
Each dependency names a slice in the same initiative.
Each review lane has a unique name and a lane findings path below its reporting slice directory.
The slice `findingsPath` is the canonical consolidated findings path.
The supervision object records `expectedAt`, `nextObservationAt`, `fallbackMinutes`, and the last meaningful event.
The `audit` array records accepted patches, rejected patches, worker results, user gates, and consolidation results.

## State patches

A worker returns an atomic patch instead of editing `state.json`.
The patch declares a base state version, one event, and a bounded list of operations.

```json
{
  "baseVersion": 12,
  "event": {
    "kind": "worker-result",
    "worker": "Review parent-slice security",
    "summary": "FINDINGS"
  },
  "operations": [
    {
      "op": "replace",
      "path": "/slices/parent-slice/reviewLanes/security/status",
      "value": "complete"
    }
  ]
}
```

The orchestrator validates the complete candidate state before it saves any operation.
The validator rejects an unknown schema version, missing required field, invalid lifecycle transition, duplicate worker, or duplicate lane name.
The validator rejects a dependency cycle, a running parent slice, or a child whose incomplete dependencies block it.
The validator rejects a findings path outside the reporting slice directory.
The validator rejects a worker result that changes another slice without an accepted user gate.
The orchestrator appends a rejected patch record without changing unrelated state.
The orchestrator writes an accepted patch, the latest event, and a compact audit record in one update.

## Projection and recovery

The orchestrator regenerates `map.puml` only from saved state.
The map uses nested PlantUML states for parent-child slices.
The map shows dependency edges and live slice status.
On resume, read `state.json`, validate it, inspect `latestEvent`, and continue from the recorded frontier.
Do not reconstruct current state from task transcripts, `map.puml`, or a worker report.
