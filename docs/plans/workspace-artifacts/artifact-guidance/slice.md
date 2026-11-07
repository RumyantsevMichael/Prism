# Guidance for store artifacts

## Changes
- change `skills/workflow/SKILL.md`: the store artifact rule and the Common terms Store artifact, Artifact scope, Accepted version, and Approval gate (§45).
- change `skills/design/SKILL.md`, `skills/implement/SKILL.md`, `skills/ideate/SKILL.md`: read and write slice files and requirements through `get_artifact` and `update_artifact` when a store holds them (§45).
- change `skills/write-requirements/SKILL.md`, `skills/write-adr/SKILL.md`: approval through `ask_approval` and `wait_for_user_gate`, and ADR acceptance at ship, with a store (§45).
- change `skills/orchestrate/SKILL.md`: ship after a `correctness` gate, passing it as `afterGate` (§45).
- change `docs/user-guide/shared-records.md`, `docs/user-guide/review-browser.md`, `docs/user-guide/workflow.md`: how store artifacts are kept, moved, reviewed, commented, and approved (§45).
