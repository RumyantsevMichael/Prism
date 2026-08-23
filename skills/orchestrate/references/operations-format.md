# Slice operations

Use one operations block for each slice in the initiative `state.md` file.
Record the delivery context lineage, real restart reason, review waves, correction loops, findings references, current result, and recovery actions.
Count a fresh review context as a review wave, not as a child restart.
Update the block at child and phase transitions, not after every wait.
Link to the slice `findings.md` file for detailed review evidence.

```markdown
## Operations: <slice>

Status: <active | clean | blocked | stopped>
Current context: <child ID>

### Delivery

- Context lineage: D1 -> D2
- Restart count: 1
- Restart reason: D1 was unresponsive after liveness probes.
- Design phase: FIT
- Implementation phase: READY FOR REVIEW

### Design review

- Contexts: R1, R2
- Review waves: 2
- Correction loops: 1
- Findings: F1, F2, F3
- Result: CLEAN

### Review after implementation

- Contexts: R3, R4
- Review waves: 2
- Correction loops: 1
- Findings: F4
- Result: CLEAN

### Recovery

- Context: D1
- Signal: unresponsive after follow-up probes.
- Action: preserved the workspace and resumed as D2.
- Result: resolved.
```
