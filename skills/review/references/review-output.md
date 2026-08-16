# Review output example

Use one block for each review lane.

```text
Lane: lifecycle
Review focus: authority loss, cancellation, deadlines, cleanup
Coverage: state transitions, races, ownership, terminal outcomes
Status: FINDINGS

Severity: high
Finding: close acknowledges before cleanup completes.
Affected path: src/session.ts:123
Evidence: the acknowledgment runs before the cleanup barrier.
Condition to close: complete cleanup before the acknowledgment.
```

```text
Lane: integration
Review focus: requirements, contracts, compatibility, artifacts
Coverage: requirements, features, ADRs, diagrams, verification
Status: CLEAN
```
