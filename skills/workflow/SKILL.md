---
name: workflow
description: "Explain the Prism workflow, common terms, and skill boundaries."
---

# Prism workflow

Use Prism for changes that need approved intent, architectural judgment, or durable behavioral documentation.
Make a small change directly when project conventions provide enough guidance.

Read `.prism/workflow.md` when it exists.
It defines project paths, stack assumptions, verification, interaction, and review settings.
The sibling workflow skills are `roadmap`, `ideate`, `plan`, `design`, `implement`, `review`, `orchestrate`, and the remaining `write-*` skills.
Use the host invocation mechanism for a sibling skill.
Use a project procedure before the Prism fallback.

## Flow

- **Prioritize** with `roadmap`.
- **Shape intent** with `ideate` or `write-requirements`.
- **Plan slices** with `plan` when the initiative needs several dependency-ordered outcomes.
- **Explore and confirm fit** with `design`.
- **Audit the design** with `review` in `design-audit` mode in a fresh context.
- **Test and implement** with `implement` in the same delivery context.
- **Review completed code** with `review` in `implementation-review` mode in a fresh context until `CLEAN`.
- **Coordinate the chain** with `orchestrate`.

Keep one delivery context for a slice from exploration through verified code.
Use a fresh context for independent review.
The orchestrator owns routing, coordination state, and user gates.

## Common terms

- **Initiative:** a set of related approved outcomes.
- **Initiative plan:** scratch coordination for an initiative.
- **Slice:** one observable vertical outcome across every required layer.
- **Approved requirement:** an accepted product or system obligation.
- **Delivery context:** one task that designs and implements one slice.
- **Orchestrator:** the control plane that routes phases, records state, and owns user gates.
- **Reviewer:** a fresh context that audits design or implementation.
- **Fresh context:** an independent context without the authoring conversation.
- **Design audit:** an independent review before implementation.
- **Implementation review:** an independent review after implementation verification.
- **Gate:** a user decision or correctness confirmation that controls progress.
- **FIT:** the slice fits one delivery context.
- **SPLIT:** the slice needs accepted child slices.
- **BLOCKED:** an unresolved requirement, decision, or dependency stops progress.
- **CLEAN:** a review found no actionable finding.
- **Proposed ADR:** an architectural decision recorded for later acceptance.
- **Executable contract:** a machine-readable boundary consumed by production code, generated code, or verification.
- **`state.md`:** the current initiative coordination snapshot.
- **`findings.md`:** the durable review record for one slice.

## Artifacts

Artifacts preserve information that code cannot preserve.

- Requirements preserve intent.
- ADRs preserve consequential decisions and invariants.
- Tests and feature files preserve behavior.
- Diagrams explain the implemented structure.
- Code explains implementation.

Artifacts for one slice travel together across every required layer.
Do not create an implementation handoff, mandatory build plan, or execution ledger.
Create an executable contract only when a real consumer needs it.

## Durable sources

Read durable documentation in this order:

1. The glossary defines terms and navigation.
2. Approved requirements define product and system obligations.
3. Relevant ADRs define architectural decisions and invariants.
4. Relevant feature files describe verified behavioral expectations.

Stop when durable sources conflict.
Do not resolve a durable conflict without the user.
Use code and tests to learn implementation details.

## Supporting procedures

Read [delegation.md](references/delegation.md) before delegated exploration or work.
Read [visual-review.md](references/visual-review.md) before a human visual review.
Read [artifact-rules.md](references/artifact-rules.md) when creating or reviewing diagrams, durable documentation, or user guidance.

State a decision in plain language before its artifact reference.
Ask only at a real gate or unresolved choice.
