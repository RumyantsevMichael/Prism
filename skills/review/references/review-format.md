# Slice review

Mode: design-audit | implementation-review
Initiative: <initiative name>
Slice: <slice name>
Lane: <review lane or design-audit>
Reporting slice: <slice name>
Writable findings: docs/plans/<initiative>/<slice>/lanes/<lane>/findings.md
Canonical findings: docs/plans/<initiative>/<slice>/findings.md
Last updated: <ISO 8601 timestamp>

## Findings

### F-001: <short finding title>

- Status: OPEN
- Severity: blocker | high | medium | low
- Source: design-audit | implementation-review
- Lane: <review lane or design-audit>
- Reporting slice: <slice slug>
- Escalation target: <slice slug | initiative | user gate | NONE>
- First reported: <review wave or date>
- Affected path: <file, symbol, artifact, or boundary>
- Evidence: <specific evidence and failure condition>
- Condition to close: <specific condition that a reviewer can verify>
- Review probe: <path, command, expected failure, or NONE>
- Implementer evidence: none
- Status history:
  - <wave or date>: OPEN | IN PROGRESS | FIXED | VERIFIED | REOPENED
- Review history:
  - <wave or date>: OPEN. <reporter and evidence>

## Result

Lane: <lane or none>
Reporting slice: <slice slug>
Review focus: <specific risks>
Coverage: <paths or checks>
Findings: <exact lane-specific writable findings path>
Canonical findings: docs/plans/<initiative>/<slice>/findings.md
Finding IDs: F-001, F-002
ADRs: <paths or NONE>
Executable tests: <paths or NONE>
Review probes: <paths or NONE>
Feature files: <paths or NONE>
Other artifacts: <paths or NONE>
Contracts: <paths or NO CONTRACT NEEDED reasons>
Diagrams: <paths or NONE>
Red checkpoint: <exact command and expected failure reason or NONE>
Verification: <exact command or NONE>
Status: CLEAN | FINDINGS
