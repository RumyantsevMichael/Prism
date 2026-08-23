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

- **Initiative:** a set of related Approved outcomes.
- **Initiative plan:** scratch coordination for an initiative's dependency-ordered slices.
- **Slice:** one observable vertical outcome across every required layer.
- **Starting surface:** the command, route, public function, event, job, or user action where a slice enters the system.
- **Acceptance suite:** feature scenarios plus any executable bindings or tests that prove one slice's observable outcome.
- **Approved requirement:** an accepted product or system obligation.
- **Delivery context:** one `Develop <slice>` task that designs and implements one slice.
- **Orchestrator:** the control plane that routes phases, records state, and owns user gates.
- **Reviewer:** a fresh `Review <slice>` context that audits design or implementation.
- **Fresh context:** an independent context without the authoring conversation.
- **Design audit:** an independent review of requirements, design artifacts, boundaries, security, and verification before implementation.
- **Implementation review:** an independent review of completed code and verified behavior after implementation.
- **Gate:** a user decision or correctness confirmation that controls progress.
- **Fit checkpoint:** the design gate that determines whether one proposed slice fits one delivery context before slice-scoped artifacts are authored.
- **FIT:** the slice fits one delivery context and may proceed to author slice-scoped design artifacts.
- **SPLIT:** the slice needs accepted child slices before slice-scoped artifacts are authored.
- **BLOCKED:** an unresolved requirement, decision, or dependency stops progress.
- **CLEAN:** a review found no actionable finding.
- **Proposed ADR:** an architectural decision recorded for acceptance by orchestration after implementation and verification.
- **Contract decision:** the canonical contract and consumers to use, or a specific reason no contract is needed.
- **Executable slice test:** a test authored after the fit checkpoint through the selected starting surface that observes the required result or failure instead of a private helper.
- **Executable contract:** a machine-readable boundary consumed by production code, generated code, or verification.
- **Feature file:** Gherkin acceptance scenarios in domain language, authored during design after the fit checkpoint passes and bound to assertions during implementation when a BDD harness exists.
- **Step definition:** an implementation-owned binding from a feature step to setup, action, or observable assertion.
- **Shape-only scaffold:** a non-behavioral seam authored after the fit checkpoint when the selected surface does not yet exist and replaced with complete behavior before verification.
- **Red checkpoint:** the exact test command and expected failure recorded before production behavior changes.
- **Security surface:** the declared trust boundaries and sensitive capabilities that determine security review scope.
- **Review wave:** one coordinated pass of fresh review contexts against one slice.
- **Review probe:** a minimal failing regression test authored by implementation review to prove a concrete finding through a public or system surface.
- **Design checkpoint:** the commit after a clean design audit and visual review that becomes the implementation diff base.
- **Decision autonomy:** an orchestration setting that controls automatic phase continuation without overriding requirements, ADR, or correctness gates.
- **Slice continuation:** an orchestration setting that controls whether a confirmed slice proceeds automatically or pauses for user input.
- **`state.md`:** the current initiative coordination snapshot.
- **`findings.md`:** the durable review record for one slice.
- **`recovery.md`:** a temporary record that lets a delivery context resume after a pause or replacement.

## Artifacts

Durable sources preserve intent, architectural decisions, boundary behavior, acceptance examples, and implemented structure across the workflow.
Code remains the implementation source.

Artifacts for one slice travel together across every required layer.
Create slice-scoped artifacts only after the design fit checkpoint passes.
Do not create an implementation handoff, mandatory build plan, or execution ledger.
Create an executable contract only when a real consumer needs it.

## Durable sources

Read durable documentation in this order:

1. The glossary defines terms and navigation.
2. Approved requirements define product and system obligations.
3. Relevant ADRs define architectural decisions and invariants.
4. Relevant feature files describe intended acceptance behavior and examples.

Stop when durable sources conflict.
Do not resolve a durable conflict without the user.
Use code and tests to learn implementation details.

## Supporting procedures

Read [delegation.md](references/delegation.md) before delegated exploration or work.
Read [visual-review.md](references/visual-review.md) before a human visual review.
Read [artifact-rules.md](references/artifact-rules.md) when creating or reviewing diagrams, durable documentation, or user guidance.

State a decision in plain language before its artifact reference.
Ask only at a real gate or unresolved choice.
