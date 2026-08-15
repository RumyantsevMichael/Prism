---
name: design
description: "Transform one Approved outcome slice into a bounded architecture, confirm that it fits one delivery context, and settle consequential decisions before implementation."
argument-hint: '[initiative/slice]'
---

# Design and confirm a slice

Read `.prism/workflow.md`, the glossary, relevant approved requirements, relevant ADRs, relevant feature files, and the slice record when present.
Use the delegation procedure in `workflow` when project rules require delegated exploration.

This skill transforms requirements into the architecture for one slice.
The same task keeps this design context for implementation unless orchestration replaces it after a failure.
Do not write an implementation specification for another agent.

## 1. Explore the slice

Find where the required behavior enters the system.
This location can be a command, route, public function, event handler, scheduled job, or user action.
Inspect the code that receives the input, changes relevant state, crosses an affected boundary, and produces the required observable result.
Inspect tests for those components and direct consumers whose behavior or compatibility can change.
Identify existing extension points, invariants, verification commands, and security boundaries in this code.
Test an uncertain technical claim with a bounded executable investigation when practical.

Stop exploration after you can name the changed components, affected boundaries, test location, and end-to-end verification command.
Expand the search only when an unresolved architecture question requires more evidence.
Do not scan the repository or read complete directories for general understanding.
Pass paths and focused questions through delegated exploration instead of returning large source excerpts.

## 2. Run the fit checkpoint

### Form the slice architecture

Map each applicable Approved requirement statement to the code or boundary that will satisfy it.
Choose where the behavior starts, which component owns it, how data moves, and how state changes.
Define failure, recovery, compatibility, migration, security, and operational behavior when they apply.
Identify each machine-readable contract that code or tests must consume.
Identify where the executable acceptance test will drive and observe the behavior.
Prefer existing architecture and extension points when they satisfy the requirements.

Do not write a prose design summary, task graph, or handoff.

### Confirm fit

Confirm the proposed slice architecture against actual code evidence.
The slice fits only when it has:

1. one observable outcome.
2. one connected set of changes from the initiating input to that outcome.
3. identified boundaries and compatibility effects.
4. at most one unresolved consequential architectural decision.
5. one end-to-end verification path.
6. a safe complete state for every changed path.
7. available dependencies.

Continue when the slice fits the remaining context and risk budget.

When it does not fit, divide it into smaller vertical outcomes.
Return proposed child slices with only the five fields that `plan` defines.
Do not add architecture, contracts, task lists, or implementation instructions.
Do not edit the accepted plan or `slices.puml`.
The orchestrator presents the split, records the accepted plan change, and resumes the delivery task.

## 3. Settle consequential decisions

Resolve an answer from Approved requirements, existing ADRs, project rules, and code when possible.
When a requirement is missing or must change, return `BLOCKED` with the exact question for the user.
Do not edit a requirement or invoke `write-requirements` without explicit user approval.
When a consequential architectural decision is already settled, record it as a Proposed ADR with `write-adr`.
When that decision is not settled, return `BLOCKED` with the exact user question before you create the ADR.

Leave private helper names, local data structures, and other code-level choices to implementation.
Do not create a separate artifact for these code-level choices.

The implementation skill creates or updates a machine-readable contract before production code when code or tests consume it.
Add a decision diagram with an ADR when relationships, lifecycle, or call order are part of the decision.
The implementation skill updates feature files and implemented-structure diagrams after the code passes verification.
Do not create a prose contract or feature file during design.

Identify the security surface as `none` or a short list of trust boundaries for reviewer routing.

## Result

Return one compact status:

- `FIT`: the proposed architecture fits one delivery context.
- `SPLIT`: include the proposed child slice records for orchestration and user acceptance.
- `BLOCKED`: name the unresolved requirement, decision, or dependency.

Do not repeat the explored code or reasoning in the status.
The orchestrator owns plan changes, lifecycle changes, and the transition to implementation.
