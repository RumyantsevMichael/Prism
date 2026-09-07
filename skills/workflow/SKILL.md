---
name: workflow
description: "Explain Prism phases, artifact ownership, and common terms when choosing or coordinating workflow skills."
sdm: "0.3"
---

# Prism workflow

- Read `.prism/workflow.md` when present for project paths, verification commands, and gate settings.
- Use project procedures before Prism fallbacks.
- Make small changes directly when project conventions supply enough guidance.

## Choose the activity

| Need | Skill |
| --- | --- |
| Configure a project | `workflow-init` |
| Approve product intent | `ideate`, using `write-requirements` |
| Prioritize initiatives | `roadmap` |
| Coordinate recursive delivery | `orchestrate` |
| Design an initiative or slice | `design` |
| Implement a fitted slice | `implement` |
| Independently audit design or code | `review` |
| Author a specific artifact | The matching `write-*` skill |

These names resolve under the Prism plugin namespace.
A direct skill invocation does not require an earlier `orchestrate` invocation.

## Delivery lifecycle

An initiative starts with a provisional root slice.
Design returns `SPLIT` for smaller outcomes, `FIT` for independent audit, or `BLOCKED` for missing decisions or evidence.
Orchestration passes ancestor diagrams and ADRs to child designs and repeats design until executable leaves fit.
Each leaf keeps one delivery context and uses fresh reviewers.
Implementation requires a clean design audit, complete effective dependencies, renewed fit, and the orchestration gate.
Completion requires verified integration, clean implementation review, and user correctness confirmation.
A split parent never implements and requires aggregate completion.

## Artifact ownership

Code establishes implemented behavior.

1. Read durable sources in this order: glossary, Approved requirements, relevant ADRs, and relevant feature files.

- Stop and report conflicting durable sources for user resolution.
- Keep every slice folder directly under the initiative directory.
- Read [artifact rules](references/artifact-rules.md) before creating or reviewing workflow artifacts.

## Common terms

| Term | Definition |
| --- | --- |
| Initiative | A roadmap-owned item that groups related Approved outcomes. |
| Initiative coordination | The initiative map, slice folders, design evidence, findings, and resume records. |
| Slice | One observable outcome across required layers, recursively split until it fits one delivery context. |
| `slice.md` | A slice folder's capability title, observable outcome, and Approved requirement links. |
| Atomic slice | An outcome that one delivery context can design, implement, and verify within its remaining context and risk budget. |
| Slice title | A concise human-readable capability name, stored separately from the stable slice slug and shown first on the map. |
| Provisional root slice | The initial candidate from the initiative outcome and Approved requirements before `design` returns `FIT` or `SPLIT`. |
| Design frontier | Unstarted leaf candidates eligible for exploration, including those with incomplete implementation dependencies. |
| Implementation frontier | Audited fitted leaves with complete effective dependencies and permission to implement. |
| Effective dependencies | A leaf's own dependencies plus the dependencies inherited from its ancestors. |
| Dependency amendment | An orchestrator-managed change to direct prerequisites that preserves the slice outcome and requirement assignment. |
| Integrated result verification | Delivery comparison and verification after integration, with fresh review and confirmation when behavior changes or equivalence is uncertain. |
| Aggregate completion | A split parent's completion when every descendant leaf is confirmed, integrated, and done, and fresh reviewers confirm all preserved finding lanes `CLEAN`. |
| Requirement assignment | Stable Approved requirement statement references whose coverage is preserved through each recursive split. |
| Starting surface | The command, route, public function, event, job, or user action where a slice enters the system. |
| Acceptance suite | Feature scenarios plus executable bindings or tests that prove one slice's observable outcome. |
| Approved requirement | An accepted product or system obligation. |
| Delivery context | One `Develop <slice>` task that designs, implements, and corrects one slice. |
| Orchestrator | The agent that owns coordination, parent relationships, dependencies, inherited design inputs, continuation, recovery, acceptance, and user gates. |
| Reviewer | A fresh `Review <slice>` context that audits design or implementation. |
| Fresh context | An independent context without the authoring conversation. |
| Design audit | An independent review of requirements, design artifacts, boundaries, security, and verification before implementation. |
| Implementation review | An independent review of completed code and verified behavior after implementation. |
| Design finding | A defect in approved intent, fit, boundaries, or planned verification that prevents a sound implementation gate. |
| Implementation gap | Missing production behavior or implementation-owned wiring after design fit that does not reopen design unless it invalidates the design evidence. |
| Gate | A user decision or correctness confirmation that controls progress. |
| Fit checkpoint | The design decision that an outcome fits the remaining context and risk budget with settled architecture and end-to-end verification. |
| FIT | A design result ready for independent audit, with design artifacts and verification evidence prepared. |
| SPLIT | A design result reporting new child slice folders for orchestration to accept and continue. |
| BLOCKED | An unresolved requirement, decision, or dependency stops progress. |
| CLEAN | A review found no actionable finding. |
| Proposed ADR | An architectural decision recorded for orchestration acceptance after implementation and verification. |
| C4 code diagram | A PlantUML level 4 view stored in the slice folder, completed for atomic fit and verified against implementation. |
| Contract decision | The canonical contract and consumers to use, or a specific reason that no contract is needed. |
| Executable slice test | A test authored after the fit checkpoint through the selected starting surface that observes the required result or failure instead of a private helper. |
| Executable contract | A machine-readable boundary consumed by production code, generated code, or verification. |
| Feature file | Gherkin acceptance scenarios in domain language, authored during design after the fit checkpoint passes and bound to assertions during implementation when a BDD harness exists. |
| Step definition | An implementation-owned binding from a feature step to setup, action, or an observable assertion. |
| Shape-only scaffold | A non-behavioral seam authored after the fit checkpoint when the selected surface does not exist and replaced with complete behavior before verification. |
| Red checkpoint | The exact test command and expected failure recorded before production behavior changes. |
| Security surface | The declared trust boundaries and sensitive capabilities that determine security review scope. |
| Review wave | One coordinated pass of fresh review contexts against one slice. |
| Review lane | One independently scoped review in a review wave. |
| Reporting slice | The slice that owns a finding's original evidence and lane findings file. |
| Escalation target | The affected slice or user gate named by a finding that exceeds its reporting slice. |
| Review probe | A minimal failing regression test authored by implementation review through a public or system surface that proves a concrete finding. |
| Design checkpoint | The commit after a clean design audit and visual review that becomes the implementation diff base. |
| Review base | The immutable design checkpoint or working-tree snapshot used for implementation review and every correction wave. |
| Decision autonomy | An orchestration setting that controls automatic phase continuation without overriding requirements, ADR, or correctness gates. |
| Slice continuation | An orchestration setting that controls whether a confirmed slice proceeds automatically or pauses for user input. |
| `state.json` | A short resume note with settings, active work, pending decisions, next actions, and evidence paths. |
| `map.puml` | The authoritative initiative graph, with topology and dependencies owned by orchestration and written through `write-map`. |
| `findings.md` | The authoritative review record for one reporting slice and review lane. |
| Lane findings file | Alias for `findings.md`. |
| `recovery.md` | A slice-owned note that preserves unfinished work and evidence when its delivery context must pause or be replaced. |

## Supporting procedures

- Read [delegation.md](references/delegation.md) before delegated work.
- Read [visual-review.md](references/visual-review.md) before human artifact review.
- Use the owning skill for artifact format and lifecycle rules.
- State each decision in plain language before its artifact reference.
- Ask only at a real gate or unresolved choice.
