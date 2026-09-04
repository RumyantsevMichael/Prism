---
name: workflow
description: "Explain the Prism workflow, common terms, and skill boundaries."
sdm: "0.3"
---

# Prism workflow

- Use Prism for changes that need approved intent, architectural judgment, or durable behavioral documentation.
- Make a small change directly when project conventions provide enough guidance.
- If `.prism/workflow.md` exists:
  1. Read it.
  2. Use its project paths, stack assumptions, verification, interaction, and review settings.
- Use a project procedure before the Prism fallback.

The sibling workflow skills are `roadmap`, `ideate`, `plan`, `design`, `implement`, `review`, `orchestrate`, and the remaining `write-*` skills.
- Use the host invocation mechanism for a sibling skill.

## Flow

The `orchestrate` skill is the coordinating entry point for this lifecycle.
This coordinating role does not require an `orchestrate` invocation before a sibling skill.
The lifecycle has this ordered overview:

| Order | Phase | Skill and context |
| --- | --- | --- |
| 1 | Prioritize | `roadmap` |
| 2 | Shape intent | `ideate` or `write-requirements` |
| 3 | Plan slices | `plan` when the initiative needs several dependency-ordered outcomes |
| 4 | Explore and confirm fit | `design` |
| 5 | Audit the design | `review` in `design-audit` mode in a fresh context |
| 6 | Test and implement | `implement` in the same delivery context |
| 7 | Review completed code | `review` in `implementation-review` mode in a fresh context until `CLEAN` |

- Keep one delivery context for a slice from exploration through verified code.
- Use a fresh context for independent review.

The orchestrator owns routing, coordination state, and user gates.

## Common terms

| Term | Definition |
| --- | --- |
| Initiative | A set of related Approved outcomes. |
| Initiative plan | Scratch coordination for an initiative's dependency-ordered slices. |
| Slice | One observable vertical outcome across every required layer. |
| Frontier | Every not-started slice whose dependencies are done. |
| Starting surface | The command, route, public function, event, job, or user action where a slice enters the system. |
| Acceptance suite | Feature scenarios plus executable bindings or tests that prove one slice's observable outcome. |
| Approved requirement | An accepted product or system obligation. |
| Delivery context | One `Develop <slice>` task that designs and implements one slice. |
| Orchestrator | The control plane that routes phases, records state, and owns user gates. |
| Reviewer | A fresh `Review <slice>` context that audits design or implementation. |
| Fresh context | An independent context without the authoring conversation. |
| Design audit | An independent review of requirements, design artifacts, boundaries, security, and verification before implementation. |
| Implementation review | An independent review of completed code and verified behavior after implementation. |
| Gate | A user decision or correctness confirmation that controls progress. |
| Fit checkpoint | The design gate that decides whether one proposed slice fits one delivery context before slice-scoped artifacts are authored. |
| FIT | The slice fits one delivery context and can proceed to slice-scoped design artifacts. |
| SPLIT | The slice needs accepted child slices before slice-scoped artifacts are authored. |
| BLOCKED | An unresolved requirement, decision, or dependency stops progress. |
| CLEAN | A review found no actionable finding. |
| Proposed ADR | An architectural decision recorded for orchestration acceptance after implementation and verification. |
| Contract decision | The canonical contract and consumers to use, or a specific reason that no contract is needed. |
| Executable slice test | A test authored after the fit checkpoint through the selected starting surface that observes the required result or failure instead of a private helper. |
| Executable contract | A machine-readable boundary consumed by production code, generated code, or verification. |
| Feature file | Gherkin acceptance scenarios in domain language, authored during design after the fit checkpoint passes and bound to assertions during implementation when a BDD harness exists. |
| Step definition | An implementation-owned binding from a feature step to setup, action, or an observable assertion. |
| Shape-only scaffold | A non-behavioral seam authored after the fit checkpoint when the selected surface does not exist and replaced with complete behavior before verification. |
| Red checkpoint | The exact test command and expected failure recorded before production behavior changes. |
| Security surface | The declared trust boundaries and sensitive capabilities that determine security review scope. |
| Review wave | One coordinated pass of fresh review contexts against one slice. |
| Review probe | A minimal failing regression test authored by implementation review through a public or system surface that proves a concrete finding. |
| Design checkpoint | The commit after a clean design audit and visual review that becomes the implementation diff base. |
| Decision autonomy | An orchestration setting that controls automatic phase continuation without overriding requirements, ADR, or correctness gates. |
| Slice continuation | An orchestration setting that controls whether a confirmed slice proceeds automatically or pauses for user input. |
| `state.md` | The current initiative coordination snapshot. |
| `findings.md` | The durable review record for one slice. |
| `recovery.md` | A temporary record that lets a delivery context resume after a pause or replacement. |

## Artifacts

Durable sources preserve intent, architectural decisions, boundary behavior, acceptance examples, and implemented structure across the workflow.
Code remains the implementation source.

- Keep the artifacts for one slice together across every required layer.
- Create slice-scoped artifacts only after the design fit checkpoint passes.
- Create an executable contract only when a real consumer needs it.
- Don't
  - Create an implementation handoff.
  - Create a mandatory build plan.
  - Create an execution ledger.

## Durable sources

Durable documentation has this source order:

1. Read the glossary for terms and navigation.
2. Read Approved requirements for product and system obligations.
3. Read relevant ADRs for architectural decisions and invariants.
4. Read relevant feature files for intended acceptance behavior and examples.

- Stop when durable sources conflict.
- Use code and tests to learn implementation details.
- Don't
  - Resolve a durable conflict without the user.

## Supporting procedures

- Read [delegation.md](references/delegation.md) before delegated exploration or work.
- Read [visual-review.md](references/visual-review.md) before a human visual review.
- Read [artifact-rules.md](references/artifact-rules.md) when creating or reviewing diagrams, durable documentation, or user guidance.
- State a decision in plain language before its artifact reference.
- Ask only at a real gate or unresolved choice.
