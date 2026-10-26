---
name: workflow
description: "Explain Prism phases, artifact ownership, and common terms when choosing or coordinating workflow skills."
sdm: "0.3"
---

# Prism workflow

- Read `.prism/workflow.md` when present for project paths, the test command, and settings.
- Use project procedures before Prism fallbacks.
- Make small changes directly when project conventions supply enough guidance.

## Choose the activity

| Need | Skill |
| --- | --- |
| Configure a project | `workflow-init` |
| Approve product intent and add it to the roadmap | `ideate`, using `write-requirements` |
| Run an initiative | `orchestrate` |
| Design a slice | `design` |
| Implement a designed slice | `implement` |
| Review a verified slice | `review` |
| Analyze reuse or restructure existing concepts | `refactor` |
| Author a specific artifact | The matching `write-*` skill |

These names resolve under the Prism plugin namespace.
A direct skill invocation does not require an earlier `orchestrate` invocation.

## Delivery lifecycle

An initiative starts as one root slice.
Each slice is designed when it is next, after its dependencies are done.
Design returns `SPLIT` with child slices, `FIT` with a frozen contract, probed assumptions, and failing acceptance tests, or `BLOCKED`.
After the design gate, fresh implementation sessions make the frozen tests pass, the server runs the project's test command, and a review follows only when the design asks for one.

## Artifact ownership

Code establishes implemented behavior.
Requirements preserve obligations, ADRs preserve decisions, `slice.md` preserves a slice's design, and tests enforce behavior.

- Read durable sources in this order: glossary, Approved requirements, relevant ADRs, and relevant feature files.
- Stop and report conflicting durable sources for user resolution.
- Change Prism records only through Prism MCP tools, never by editing their files or generated views, and report a refusal that the tool's message does not resolve.
- Persist a fact only when a later session needs it and no existing artifact owns it.
- Keep durable requirements, ADRs, features, and user guidance free of slice identities and scratch paths.

## Common terms

| Term | Definition |
| --- | --- |
| Initiative | A roadmap-owned item that groups related Approved outcomes, identified by a stable identifier that names its plans folder. |
| Prism record | Machine JSON that only Prism MCP tools read and write, addressed by initiative and slice identifiers rather than file paths. |
| Roadmap record | The Prism record owning initiative bands, order, required initiatives, rationale, open questions, and recorded ship and supersede decisions, read through `get_roadmap` and changed through `update_roadmap`. |
| Initiative lifecycle | `envisioned`, `planned`, and `in-progress` derived by `get_roadmap` from the initiative record and coordination state, plus recorded `shipped` and `superseded` decisions. |
| Initiative record | The Prism record of slice titles, outcomes, topology, requirement assignments, dependencies, status, and accepted designs, read through `get_initiative` and changed through `update_initiative`; `initiative.md` is its generated view. |
| Coordination state | The initiative's Prism record of settings, active work, pending user gate records, and next actions, read through `get_coordination_state` and changed through `update_coordination_state`. |
| Slice | One observable outcome across required layers, split recursively until one design can fix its whole interface. |
| `slice.md` | A slice's design document in its slice folder: contract, assumptions, steps, review recommendation, and frozen tests for a fitted slice, or the interfaces between children for a split one. |
| Approved requirement | An accepted product or system obligation. |
| Requirement assignment | Approved requirement references whose coverage is preserved through each split. |
| Effective dependencies | A leaf's own dependencies plus the dependencies inherited from its ancestors. |
| Starting surface | The command, route, public function, event, job, or user action where a slice enters the system. |
| FIT | A design result with a frozen contract, probed assumptions, and failing acceptance tests. |
| SPLIT | A design result with child slices, their order, and their shared interfaces, but no tests. |
| BLOCKED | An unresolved requirement, decision, or external fact stops progress. |
| Contract | The frozen observable interface of a fitted slice that fixes what the requirements leave open. |
| Assumption probe | A small experiment against the real system that confirms a contract assumption, or a fail-safe clause where no probe is possible. |
| Frozen tests | Acceptance test files fixed when the design is accepted; implementation must not change them, and verification refuses to run when one changed. |
| Implementation step | One ordered part of a fitted slice that one fresh implementation session delivers against the shared contract and suite. |
| Design gate | The user's acceptance of a design, which the autonomy setting may resolve automatically. |
| Accepted design | A slice's design recorded through `update_initiative` with its frozen tests and a review mark of `required` or `none`. |
| Verification run | A `verify_slice` run of the user-approved test command from `.prism/workflow.md`, recorded on the slice; a slice with an accepted design completes only on a fresh passing run. |
| Implementation review | An independent review of the verified result of a slice whose design is marked `required`. |
| Review record | The Prism record of one slice's review waves, lanes, and findings, read through `get_review` and changed through `update_review`. |
| Review wave | One pass of fresh reviewers over one verified result of a slice. |
| Review lane | One independently scoped review in a review wave. |
| CLEAN | A review lane result with no unresolved finding. |
| Review probe | A minimal failing test that a reviewer adds through a public surface to prove a finding. |
| Gate | A user decision that controls progress. |
| User gate record | A pending coordination state entry for a question to the user, with its kind, slice, question, artifacts, optional options, and any answer recorded in the review browser. |
| Orchestrator | The agent that runs an initiative and alone writes its Prism records. |
| Fresh context | A session that starts without the conversation that authored its inputs. |
| Decision autonomy | A run setting that selects which gates wait for the user. |
| Agent flow | A run setting that selects child agents or inline work for design and implementation. |
| Slice continuation | A run setting that controls whether the next slice starts without the user. |
| `recovery.md` | A slice note that preserves unfinished work when a run pauses. |
| Pause checkpoint | An orchestrator action that writes `recovery.md` and updates coordination state together. |
| Proposed ADR | An architectural decision recorded for acceptance after its slice passes verification. |
| Executable contract | A machine-readable boundary consumed by production code, generated code, or verification. |
| Feature file | Gherkin acceptance scenarios in domain language, authored by design for a fitted slice and bound to assertions during implementation when a BDD harness exists. |
| Step definition | An implementation-owned binding from a feature step to setup, action, or an observable assertion. |
| Refactoring | Behavior-preserving restructuring of existing concepts, with shared analysis for targeted cleanup and design reuse. |
| Semantic concept | A unit of meaning or responsibility that can span several source units or share one with other concepts. |
| Candidate relationship | An evidence-supported explanation of why concepts appear related, established before choosing a transformation. |
| Desired conceptual model | The structure that fits current requirements and knowledge, including meaningful distinctions and knowledge ownership. |
| Resynthesis | Reconstruction of affected text or declarations from current semantic requirements while preserving their observable obligations. |
| Complexity delta | Independent before/after measurements and qualified judgments whose tradeoffs require conceptual and behavioral evidence. |

## Supporting procedures

- Read [delegation.md](references/delegation.md) before starting child agents.
- Read [visual-review.md](references/visual-review.md) before human artifact review.
- State each decision in plain language before its artifact reference.
- Ask only at a real gate or unresolved choice.
