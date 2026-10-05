---
name: workflow
description: "Explain Prism phases, artifact ownership, and common terms when choosing or coordinating workflow skills."
sdm: "0.3"
---

# Prism workflow

- Read `.prism/workflow.md` when present for project paths, verification commands, and gate settings.
- Read [orchestrator run settings](../orchestrate/references/run-settings.md) when coordinating an initiative.
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
| Analyze reuse or restructure existing concepts | `refactor` |
| Implement a fitted slice | `implement` |
| Independently audit design or code | `review` |
| Author a specific artifact | The matching `write-*` skill |

These names resolve under the Prism plugin namespace.
A direct skill invocation does not require an earlier `orchestrate` invocation.

## Delivery lifecycle

An initiative starts with a provisional root slice.
Design returns `SPLIT` for smaller outcomes, `FIT` for independent audit, or `BLOCKED` for missing decisions or evidence.
Orchestration passes ancestor diagrams and ADRs to child designs and repeats design until executable leaves fit.
Each leaf keeps one `Develop <slice>` worker and uses fresh `Review <slice>` workers.
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
| Slice | One observable outcome across required layers, recursively split until it fits one `Develop <slice>` worker. |
| `slice.md` | A slice folder's capability title, observable outcome, and Approved requirement links. |
| Atomic slice | An outcome that one `Develop <slice>` worker can design, implement, and verify within its remaining context and risk budget. |
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
| Delivery context | The long-lived `Develop <slice>` worker and task that designs, implements, and corrects one slice. |
| Orchestrator | The agent that owns coordination, parent relationships, dependencies, inherited design inputs, continuation, recovery, acceptance, and user gates. |
| Reviewer | A fresh `Review <slice>` worker and task that audits design or implementation. |
| Fresh context | An independent worker task without the authoring conversation. |
| Design audit | An independent review of requirements, design artifacts, boundaries, security, and verification before implementation. |
| Implementation review | An independent review of completed code and verified behavior after implementation. |
| Design finding | A defect in approved intent, fit, boundaries, or planned verification that prevents a sound implementation gate. |
| Implementation gap | Missing production behavior or implementation-owned wiring after design fit that does not reopen design unless it invalidates the design evidence. |
| Gate | A user decision or correctness confirmation that controls progress. |
| Fit checkpoint | The design decision that an outcome fits the remaining context and risk budget with settled architecture and end-to-end verification. |
| Workflow decision record | An opt-in local record of a structured decision, its reason codes, evidence paths, and identity coverage. |
| Concept delta | MCP-managed version 2 design evidence binding the original baseline, requirements, native search receipts, planned transitions, and growth policy to an audited revision. |
| Conservation evidence | Immutable private B, A, and F source snapshots, semantic receipts, observations, and measurements used by MCP review gates. |
| Semantic reuse evidence | Snapshot-bound search candidates with model identity and reviewed reuse dispositions, recorded through the concept-delta MCP capability without treating similarity as equivalence. |
| Refactoring | Behavior-preserving restructuring of existing concepts, with shared analysis for targeted cleanup and design reuse. |
| Semantic concept | A unit of meaning or responsibility that can span several source units or share one with other concepts. |
| Candidate relationship | An evidence-supported explanation of why concepts appear related, established before choosing a transformation. |
| Desired conceptual model | The structure that fits current requirements and knowledge, including meaningful distinctions and knowledge ownership. |
| Resynthesis | Reconstruction of affected text or declarations from current semantic requirements while preserving their observable obligations. |
| Complexity delta | Independent before/after measurements and qualified judgments whose tradeoffs require conceptual and behavioral evidence. |
| Context plan | An explainable commit-bound estimate of repository source ranges that implementation must, likely, or possibly reads. |
| Session capacity profile | A versioned exact host, provider, model, and version match that supplies capacity facts with provenance. |
| Repository read budget | The context available for repository discovery after base, design, and implementation reserves are removed from the compaction threshold. |
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
| Review wave | One coordinated pass of fresh `Review <slice>` workers against one slice. |
| Review lane | One independently scoped review in a review wave. |
| Resolution exchange | A bounded direct conversation between a `Develop <slice>` worker and its assigned `Review <slice>` worker that resolves findings before a fresh review. |
| Reporting slice | The slice that owns a finding's original evidence and lane in `review.json`. |
| Escalation target | The affected slice or user gate named by a finding that exceeds its reporting slice. |
| Review probe | A minimal failing regression test authored by implementation review through a public or system surface that proves a concrete finding. |
| Design checkpoint | The commit after a clean design audit and visual review that becomes the implementation diff base. |
| Review base | The immutable design checkpoint or working-tree snapshot used for implementation review and every correction wave. |
| Decision autonomy | An orchestration setting that controls automatic internal decisions. |
| Agent flow | An orchestration setting that selects inline or delegated delivery. |
| Slice continuation | An orchestration setting that controls whether a confirmed slice proceeds automatically or pauses for user input. |
| `state.json` | Machine-managed coordination state with settings, active work, pending decisions, next actions, evidence paths, and a revision. |
| `map.puml` | The authoritative initiative graph, with topology and dependencies owned by orchestration and written through `write-map`. |
| `review.json` | The authoritative MCP-managed slice review containing lanes, waves, findings, assessments, disagreements, and evidence bindings. |
| `findings.md` | Legacy review evidence that remains readable and can be imported through MCP without carrying historical acceptance forward. |
| Lane findings file | A legacy name for a lane now read and changed through `review.json`; `review.md` is a generated human view. |
| `recovery.md` | A slice-owned note that preserves unfinished work and evidence when its `Develop <slice>` worker must pause or be replaced. |
| Pause checkpoint | An orchestrator action that writes an active slice recovery note before it updates coordination state at an expected revision. |

## Supporting procedures

- Read [delegation.md](references/delegation.md) before delegated work.
- Read [visual-review.md](references/visual-review.md) before human artifact review.
- Use the owning skill for artifact format and lifecycle rules.
- State each decision in plain language before its artifact reference.
- Ask only at a real gate or unresolved choice.
