# Guidance for store artifacts

## Changes
- change `skills/workflow/SKILL.md`: the store artifact rule and the Common terms Store artifact, Artifact scope, Accepted version, Approval gate, and Portable name, the one statement of the portable name rule (§45, §46).
- change `skills/design/SKILL.md`, `skills/ideate/SKILL.md`, `skills/triage/SKILL.md`, `skills/setup/SKILL.md`, `skills/implement/SKILL.md`, `skills/refactor/SKILL.md`, `skills/write-adr/SKILL.md`, `skills/write-requirements/SKILL.md`, `skills/write-feature/SKILL.md`, `skills/write-contracts/SKILL.md`, `skills/write-step-definitions/SKILL.md`, `skills/write-user-docs/SKILL.md`: each step that chooses a new file, folder, or identifier name links the Portable name term, and `ideate`'s identifier sentence refers to it in place of its own character list (§46).
- change `skills/design/SKILL.md`, `skills/implement/SKILL.md`, `skills/ideate/SKILL.md`: read and write slice files and requirements through `get_artifact` and `update_artifact` when a store holds them (§45).
- change `skills/write-requirements/SKILL.md`, `skills/write-adr/SKILL.md`: approval through `ask_approval` and `wait_for_user_gate`, and ADR acceptance at ship, with a store (§45).
- change `skills/orchestrate/SKILL.md`: ship after a `correctness` gate, passing it as `afterGate` (§45).
- change `docs/user-guide/shared-records.md`, `docs/user-guide/review-browser.md`, `docs/user-guide/workflow.md`: how store artifacts are kept, moved, reviewed, commented, and approved (§45).
