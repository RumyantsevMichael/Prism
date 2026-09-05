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

The sibling workflow skills are `roadmap`, `ideate`, `design`, `implement`, `review`, `orchestrate`, and the remaining `write-*` skills.
- Use the host invocation mechanism for a sibling skill.

## Flow

The `orchestrate` skill is the coordinating entry point for this lifecycle.
This coordinating role does not require an `orchestrate` invocation before a sibling skill.
The lifecycle has this ordered overview:

| Order | Phase | Skill and context |
| --- | --- | --- |
| 1 | Prioritize | `roadmap` |
| 2 | Shape intent | `ideate`, using `write-requirements` for requirement-file authoring |
| 3 | Explore and confirm fit | `design` for the current candidate slice |
| 4 | Accept and map a split | `orchestrate` routes acceptance and runs `write-map` |
| 5 | Audit the design | `review` in `design-audit` mode in a fresh context |
| 6 | Test and implement | `implement` in the same delivery context |
| 7 | Review completed code | `review` in `implementation-review` mode in a fresh context until `CLEAN` |

- Keep one delivery context for a slice from exploration through verified code.
- Use a fresh context for independent review.

The orchestrator owns routing, coordination state, and user gates.

## Recursive slice flow

The `roadmap` skill creates and prioritizes an initiative after product intent is available.
The orchestrator starts only that roadmap initiative after it has Approved requirement links.
The orchestrator creates one provisional root slice from that intent without inventing a breakdown.
`design` reads the Approved requirements, durable documents, and focused code paths for the current leaf slice.
When the slice fits, the normal design, review, and implementation flow continues.
When the slice does not fit, `design` returns a `SPLIT` proposal with replacement child records.
The orchestrator checks coverage and routes acceptance without changing the proposed boundaries or dependencies.
Acceptance uses a user gate under conservative autonomy or policy acceptance under broad autonomy.
After acceptance, the orchestrator runs `write-map` to apply the exact child proposal to the authoritative map.
The orchestrator selects eligible child leaves and starts `design` for each one.
This cycle repeats until every executable leaf returns `FIT` or a real blocker stops work.
Design discovery can precede dependency implementation when the available evidence supports a sound fit decision.
Implementation waits for complete effective dependencies and a renewed fit check against their integrated changes.
Split parents remain `split` and count as complete only when all descendant leaves are confirmed, integrated, and `done`.

`write-map` applies accepted graph changes and makes no design decisions.

## Common terms

| Term | Definition |
| --- | --- |
| Initiative | A roadmap-owned item that groups related Approved outcomes. |
| Initiative coordination | Scratch state, map, findings, and recovery records for an initiative. |
| Slice | One observable vertical outcome across every required layer. |
| Slice title | A concise human-readable capability name, stored separately from the stable slice slug and shown first on the map. |
| Provisional root slice | The initial candidate slice from the declared initiative outcome before `design` confirms fit or returns `SPLIT`. |
| Design frontier | Unstarted leaf candidates eligible for exploration, including those with incomplete implementation dependencies. |
| Implementation frontier | Audited fitted leaves with complete effective dependencies and permission to implement. |
| Effective dependencies | A leaf's own dependencies plus the dependencies inherited from its ancestors. |
| Dependency amendment | A design proposal to replace a leaf's direct dependencies while preserving its outcome and requirement assignment. |
| Integrated result verification | Delivery comparison and verification after integration, with fresh review and confirmation when behavior changes or equivalence is uncertain. |
| Aggregate completion | A split parent's completion when every descendant leaf is confirmed, integrated, and done. |
| Requirement assignment | Stable Approved requirement statement references whose coverage is preserved through each recursive split. |
| Starting surface | The command, route, public function, event, job, or user action where a slice enters the system. |
| Acceptance suite | Feature scenarios plus executable bindings or tests that prove one slice's observable outcome. |
| Approved requirement | An accepted product or system obligation. |
| Delivery context | One `Develop <slice>` task that designs and implements one slice. |
| Orchestrator | The agent that coordinates activities, records progress, and routes decisions and user gates. |
| Reviewer | A fresh `Review <slice>` context that audits design or implementation. |
| Fresh context | An independent context without the authoring conversation. |
| Design audit | An independent review of requirements, design artifacts, boundaries, security, and verification before implementation. |
| Implementation review | An independent review of completed code and verified behavior after implementation. |
| Gate | A user decision or correctness confirmation that controls progress. |
| Fit checkpoint | The design gate that decides whether one proposed slice fits one delivery context before slice-scoped artifacts are authored. |
| FIT | The slice fits one delivery context and can proceed to slice-scoped design artifacts. |
| SPLIT | The slice needs accepted child slices, with existing work preserved and assigned to those children. |
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
| Review lane | One independently scoped review in a review wave. |
| Reporting slice | The slice that owns a finding's original evidence and lane findings file. |
| Escalation target | The affected slice or user gate named by a finding that exceeds its reporting slice. |
| Review probe | A minimal failing regression test authored by implementation review through a public or system surface that proves a concrete finding. |
| Design checkpoint | The commit after a clean design audit and visual review that becomes the implementation diff base. |
| Review base | The immutable design checkpoint or working-tree snapshot used for implementation review and every correction wave. |
| Decision autonomy | An orchestration setting that controls automatic phase continuation without overriding requirements, ADR, or correctness gates. |
| Slice continuation | An orchestration setting that controls whether a confirmed slice proceeds automatically or pauses for user input. |
| `state.json` | A short resume note with settings, active work, pending decisions, next actions, and evidence paths. |
| `map.puml` | The authoritative slice topology, requirements, titles, dependencies, and structural lifecycle, maintained by `write-map`. |
| `findings.md` | The canonical consolidated review record for one slice. |
| Lane findings file | The only writable findings file for one reporting slice and review lane. |
| `recovery.md` | A slice-owned note that preserves unfinished work and evidence when its delivery context must pause or be replaced. |

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
