# Orchestrator run settings

Read this reference before starting or resuming an initiative.
Resolve missing values once through the coordination-state capability before active work, then use the settings to coordinate every phase.
A persisted value remains authoritative when orchestration resumes.

All persisted settings below are fields under `state.json.settings`.

## Setting catalog

| Setting | Allowed values | Missing value | Effect |
| --- | --- | --- | --- |
| `autonomy` | `conservative`, `broad`, `full` | `conservative` | Selects automatic decision gates. |
| `agentFlow` | `mono`, `multi` | `multi` | Selects inline or delegated delivery. |
| `commit` | `on`, `off` | `on` under `full`, otherwise `off` | Controls authorized commits and checkpoints for slice-owned changes. |
| `push` | `on`, `off` | `off` | Controls authorized pushes and is never enabled automatically by autonomy. |
| `continuation` | `auto`, `stepwise` | `auto` | Controls whether the next confirmed leaf proceeds automatically. |
| `models` | `defaults`, `host defaults`, or `{delivery, review, securityReview}` | `host defaults` | Selects model assignments for delivery, review, and security review. |

## Decision autonomy

- `conservative` asks the user for requirements, decisions, conflicts, and correctness confirmation.
- `broad` makes routine technical and workflow decisions within Approved intent, but pauses for new intent, requirement changes, or durable-source conflicts.
- `full` resolves internal requirements, durable-source conflicts, roadmap state, splits, dependencies, ADR acceptance, correctness confirmation, and phase continuation.
- After required verification and fresh review, `conservative` asks for correctness confirmation, while `broad` and `full` record it automatically.
- No autonomy level invents external facts, overrides project constraints, bypasses independent review, or enables push automatically.

## Agent flow

- `multi` delegates slice delivery to child contexts and uses fresh review contexts.
- `mono` runs planning, design, implementation, corrections, and artifact-writing in the orchestrator context and workspace.
- Both flows run `ideate` and `roadmap` inline from a raw idea or missing initiative inputs.
- Both flows use fresh independent contexts for design and implementation review.
- If fresh review capability is unavailable, block and ask the user to run a separate review task.
- Mono delivery records `orchestrator` as the active worker and the current workspace.
- `agentFlow` is fixed after the first active phase or worker starts.

## Resolution and precedence

- Read the current state with `get_coordination_state`, resolve missing settings, and write `changes.settings` with `update_coordination_state` and the current revision before active work.
- Settings updates merge with existing settings, and `schemaVersion` remains unchanged at `1`.
- Explicit `commit`, `continuation`, and `push` values override autonomy defaults.
- `full` never turns push on by itself.
- Direct skill invocations keep their normal user gates.
