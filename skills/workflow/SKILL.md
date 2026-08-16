---
name: workflow
description: "Explain Prism shared workflow rules."
---

# The code-centered engineering workflow

Use Prism for changes that need approved intent, architectural judgment, or durable behavioral documentation.
Make a small change directly when the project conventions provide enough guidance.

Read `.prism/workflow.md` when it exists.
It defines project paths, stack assumptions, verification, interaction, and review settings.

The sibling workflow skills are `roadmap`, `ideate`, `plan`, `design`, `design-audit`, `implement`, `review`, `orchestrate`, and the remaining `write-*` skills.
Use the host invocation mechanism for a sibling skill.
Use a project procedure before the Prism fallback.

## The workflow

- **Prioritize** with `roadmap`.
- **Shape intent** with `ideate` or `write-requirements`.
- **Plan slices** with `plan` when the initiative needs several dependency-ordered outcomes.
- **Explore and confirm fit** with `design`.
- **Audit the design** with `design-audit` in a fresh context before implementation.
- **Test and implement** with `implement` in the same delivery context.
- **Review completed code** with `review` in a fresh context until `CLEAN`.
- **Coordinate the chain** with `orchestrate`.

A phase skill does not choose its own context boundary.
Keep one delivery context for a slice from exploration through verified code.
Do not reuse that delivery context for another slice.
Use a fresh context for independent review.

## Artifact model

Artifacts preserve information that code cannot preserve.

- Requirements preserve intent.
- ADRs preserve consequential decisions and invariants.
- Tests and feature files preserve behavior.
- Diagrams explain the implemented structure.
- Code explains implementation.

Do not create an implementation handoff.
Do not create a mandatory build plan or execution ledger.
Create an executable contract only when code or verification consumes it.
Record one canonical contract path, its consumers, and its exact verification command for every declared contract.
Record a specific reason for every `NO CONTRACT NEEDED` decision.
Review and design audit must verify that every declared contract has a real consumer.
Keep final contracts at their canonical boundary paths, not in slice directories.
Keep coordination state inside the initiative plan only when several slices, workspaces, owners, or migration states require it.

## Outcome slices

A slice is one observable outcome across every required layer.
Tests, code, documentation, and executable contracts travel together.
Do not split by frontend, backend, tests, contracts, or documentation.

The planner predicts whether a slice fits one delivery context.
The `Develop <slice>` task confirms fit after bounded code exploration.
When a slice does not fit, it returns proposed child slices to `orchestrate`.
Completed code becomes the implementation context for later slices.

## Delegation

Inspect callable host actions before delegation.

Child-agent capability exists only when a child-start action is callable.
A wait or status action alone is not child-agent capability.
Use native child agents when the current context has a callable child-start action.
Otherwise, return a broker request to the nearest parent with child-agent capability.
Pass the model role and resolved model through every child start and broker request.

Use this exact broker request:

```text
Kind: explore | task | review
Scope: <slice, investigation, or review lane>
Inputs: <artifact and code paths>
Output: <scratch report path or workspace>
Profile: <execution profile>
Model role: <role>
Model: <resolved model or host default>
```

Put large read-only findings in the supplied scratch path.
Use the owning initiative plan for scratch output when it exists.
Otherwise, use task-scoped temporary scratch and delete it after the phase.
Return only paths and short status records through the broker.

Do not invoke a Codex, Claude, or other agent CLI to create a child agent.
Do not replace a required delegated capability with prohibited direct exploration.
When no parent can delegate, use the project fallback or work inline when permitted.
When no context can provide a fresh reviewer, ask the user to run `review` in a separate task.

Render an execution profile as:

- Complexity: standard | high
- Context: fresh | resume
- Parallelism: sequential | independent
- Focus: <specific risks>
- Model role: planning | delivery | design-audit | review | security-review
- Model: <resolved model or host default>

## Child-agent supervision

The orchestrator owns user interaction, routing, and lifecycle gates.
The active `Develop <slice>` task owns design and implementation for one slice.
Never wait without at least one active child identifier.
An empty receiver set or empty agent state is a positive routing failure.
Route that failure through the broker or the documented fallback.

A wait timeout means only that no final result arrived.
Interrupt only after a positive failure signal, a user request, or an explicit agent blocker.
Continue waiting when an active child exists and no failure signal exists.
Do not narrate unchanged waits.
Record the last progress, active command when reported, and recovery reason.
Do not count waits or replacements as correction rounds.
Resume the same agent when possible.
Start a replacement only from recorded recovery state and the current code.

## Documentation hierarchy

Read durable documentation in this order:

1. The glossary defines terms and navigation.
2. Approved requirements define product and system obligations.
3. Relevant ADRs define architectural decisions and invariants.
4. Relevant feature files describe verified behavioral expectations.

Stop when these sources conflict.
Do not resolve a durable conflict without the user.
Use code and tests to learn implementation details.

## Diagrams

Write PlantUML source beside the durable artifact or code area that it explains.
Read the source and do not read rendered images as implementation input.
Do not commit rendered images.

Create an ADR decision diagram during design when relationships, lifecycle, or call order are part of the decision.
Create or update an implemented-structure diagram after code establishes the structure.
Derive implemented structural relationships from code or CodeGraph when available.
Add only information that materially improves human understanding.
Do not use a diagram to instruct another agent how to implement the slice.

Use a dependency graph for roadmap initiatives and initiative slices.
Use a C4, component, class, state, or sequence diagram only when it materially improves understanding.
Do not add diagrams to requirements or feature files.

## Visual review

Use the Prism review server for human artifact review when its tools are available.
Missing `Review browser` defaults to `auto`.
For `auto`, use the internal browser in desktop sessions and the system browser in CLI sessions.
For `internal`, use the internal browser.
For `external`, use the system browser.
Explicit `internal` and `external` values override `auto`.
Open the recorded design artifacts and diagrams in the Prism artifact viewer after a clean design audit and before implementation.
Open changed artifacts and diagrams in the Prism artifact viewer before the final correctness gate.
Inspect the rendered artifact before the related user gate.
If the selected browser capability does not exist, present the URL and source artifacts.
If no review server exists, present the source artifacts.

## Lifecycles

- `roadmap` owns initiative priority and the `envisioned`, `planned`, `in-progress`, and `shipped` states.
- `write-requirements` owns requirement status.
- `write-adr` creates Proposed ADRs.
- `orchestrate` marks a slice `in-progress` before design starts.
- `orchestrate` marks a confirmed slice `done`.
- `orchestrate` accepts an implemented Proposed ADR after slice confirmation.
- `orchestrate` sets the initiative to `shipped` and deletes its completed plan.

An initiative plan is scratch coordination state.
Delete it only after every slice is done and all open information moves to a durable artifact or issue.
Set the roadmap initiative to `shipped` before deletion.

## Durable references

Durable artifacts must not reference slice names, plan sections, scratch paths, or temporary status identifiers.
Cite a requirement for an obligation.
Cite an ADR for rationale.
Describe the implemented behavior directly.

## User documentation

Update the configured user-guide path when observable behavior changes.
Ship an operator runbook with an operational capability.
Use exact verified commands or UI steps.
Mark an unsettled operational decision as `TBD`.

## User decisions

State a decision in plain language before its artifact reference.
Use structured input when configured and available.
Otherwise, provide the same short options in plain text.
Put the recommendation first.
Ask only at a real gate or unresolved choice.

## Git

Use `type(scope): header` for Conventional Commits.
Cite requirements and ADRs where they apply.
Never cite an initiative plan.
Never push without explicit permission.
Do not propose a commit unless the user asks or `orchestrate` has an enabled commit dial.
