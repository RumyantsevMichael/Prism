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
| Set up, amend, or migrate a project, including when the person adds a tool or mentions another repository the work touches | `setup` |
| Approve product intent and add it to the roadmap | `ideate`, using `write-requirements` |
| Trace a reported defect to the requirement it breaks | `triage` |
| Run an initiative | `orchestrate` |
| Design a contract | `design` |
| Implement a planned slice | `implement` |
| Review a verified slice | `review` |
| Analyze reuse or restructure existing concepts | `refactor` |
| Author a specific artifact | The matching `write-*` skill |

These names resolve under the Prism plugin namespace, and a direct skill invocation does not require an earlier `orchestrate` invocation.

## Delivery lifecycle

An initiative starts as one root slice, which is its first contract scope.
Design proposes `FIT` with one frozen contract, probed assumptions, failing acceptance tests, and a slice plan, or `SPLIT` with parts that each get their own contract later, or returns `BLOCKED`.
After the design gate, the orchestrator accepts the proposal, which records the plan's slices and their designs at once, and Prism stages each slice's frozen tests until that slice starts.
One fresh implementation session per slice makes its frozen tests pass and has Prism run the project's test command, and a review follows only for a slice marked for review.

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
| Coordination state | The initiative's Prism record of settings, active work, pending user gate records, next actions, and the action history, read through `get_coordination_state` and changed through `update_coordination_state`, except the action history and the settings marks that only review app actions write. |
| Person change notice | `personChanges` on a Prism result that names an initiative, shown once per session: the person's changes from the review app that the session has not seen, each with its author; a gate wait returns them with status `changed`, and an agent's settings write keeps each setting the person set and lists it under `keptSettings`. |
| Slice | One observable outcome across required layers that one fresh implementation session delivers, planned by a contract. |
| Contract scope | The root slice, or a part that a split design created, that one design gives one contract. |
| Slice plan | The **Slices** section of a contract: each planned slice with its outcome, component, requirements, dependencies, frozen test files, and review recommendation. |
| Workspace | The checkouts and repositories whose Prism records share one store, named by the workspace name that `update_roadmap` sets with `set_workspace_name`, or after the store while it has none. |
| Component | A part of a repository with its own folder, optional test command, and dependencies, declared under `## Components` in `.prism/workflow.md` and identified across the workspace as `<repository>/<component>`, where the repository's name is its `Repository` name under `## Workspace`, or `root` when it gives none. |
| Root component | The component named after the repository that holds every file outside the declared folders and tests with the repository's test command; a repository that declares no components is its root component alone. |
| Component proposal | A `## Components` block that `get_roadmap` returns as `components.proposal` when `.prism/workflow.md` lists no component and a workspace manifest at the project root gives workspace patterns, one component per member folder; Prism never writes it, and it takes effect only when the person commits it under `## Components`. |
| Shared path | A file or folder listed under `Shared paths` in `## Components` that any slice may change, whichever component it belongs to. |
| Component boundary | The rule that a planned slice's **Changes** and frozen tests, and every change made since its start content, stay inside its component or under a shared path; the start content is the project's content and `## Components` declaration that Prism records when the slice starts and keeps under this checkout's local ref `refs/prism/<initiative>/<slice>/<checkout>/start` until the slice returns to not-started; another slice's frozen tests at their frozen content and its verified changes do not count; Prism refuses a design that crosses the boundary, and fails a verification run that crosses it, with `component_boundary`, or with `start_content_missing` when Git can no longer read the start content or it was recorded without a declaration. |
| Split evidence | What Prism requires before a scope splits into parts that get their own contracts: `contract_size`, contract files estimated above the token budget that one implementer reads; `unfrozen`, an Unprobed assumption that one part settles; or `user_gate`, a gate where the person asked for the split. A split into a contract's slice plan needs none. |
| `slice.md` | A design document in a slice folder: for a contract scope, the contract, assumptions, and slice plan, or the interfaces between parts after a split; for a planned slice, its changes. |
| Approved requirement | An accepted product or system obligation. |
| Defect | Reported behavior that contradicts an Approved requirement; `triage` reproduces it and links that requirement, so the fix needs no new requirement. |
| Requirement assignment | Approved requirement references whose coverage is preserved through each split. |
| Effective dependencies | A leaf's own dependencies plus the dependencies inherited from its ancestors. |
| Starting surface | The command, route, public function, event, job, or user action where a slice enters the system. |
| FIT | A design result with a frozen contract, probed assumptions, failing acceptance tests, and a slice plan. |
| SPLIT | A design result with parts of a scope that cannot be one contract, their order, their shared interfaces, and the split evidence, but no new tests. |
| BLOCKED | An unresolved requirement, decision, or external fact stops progress. |
| Contract | The frozen observable interface of a contract scope that fixes what the requirements leave open, shared by its planned slices. |
| Assumption probe | A small experiment against the real system that confirms a contract assumption, or a fail-safe clause where no probe is possible. |
| Contract defect | A contract clause that an implementer finds wrong, or that a review finding names as its cause, reported through `verify_slice`, which blocks the slice until design revises the contract. |
| Frozen tests | Acceptance test files of one slice, fixed when its design is accepted; implementation must not change them, and verification refuses to run when one changed. |
| Staged tests | Frozen tests of a slice that has not started, which Prism keeps out of the work tree until `set_status` `in-progress` starts the slice, or until `restore_tests` puts them back for a design revision. |
| Design diagrams | PlantUML source written by design: an overview of each contract's slices, shared interfaces, and order, and a code view per slice; Prism parses them and refuses a view that does not parse or shows more than 30 elements. |
| Changes | The files a planned slice is expected to add, change, or remove, with the units each adds or whose interface it changes; after verification the review browser compares them with what the verified result changed. |
| Design gate | The user's acceptance of a design, which the autonomy setting may resolve automatically. |
| Design proposal | A design result that design records through `update_initiative` and Prism checks at once, kept pending without changing any slice until the orchestrator accepts it after the design gate. |
| Claim | A slice's mark naming the one Prism server that works on it, for `design` or `implementation`, taken by `claim` on a scope before design or by `set_status` `in-progress`; it covers the slice's descendants, Prism refuses another holder's start with `slice_claimed`, and it ends when the slice leaves `in-progress`, when the scope's proposal is accepted, through `release_claim`, or 30 minutes after its last renewal. |
| Design view | The review browser's page for a design gate: one example per frozen test under its contract clause, clauses without a test, and the planned changes, written through `update_design_view` by the example writer. |
| Example writer | A child agent on a small model that writes the design view from the contract and the frozen tests only. |
| Accepted design | A planned slice's design recorded through `update_initiative` with its frozen tests, its review mark, and its component. |
| Review mark | `required` or `none` on an accepted design, set from the user's marks at the design gate and the `review` setting at that moment; a later change of the setting keeps it. |
| Verification run | An implementer's `verify_slice` run of the user-approved test command from `.prism/workflow.md`, recorded on the slice: the slice's component's own command in its folder, or the repository's command in the project root, after checking the component boundary against the slice's start content; a slice with an accepted design completes only on a fresh passing run, which completes a slice marked `none` by itself. |
| Dependents' run | The `verify_slice` run with `dependents` `true` that the orchestrator starts once every leaf of a contract scope whose design accepted a slice plan, or of a leaf that is a scope of its own, is done: the test command of every component of the same repository that depends, directly or through other components, on a component of the scope's leaves, each distinct command and folder once in dependency order behind one approval gate, recorded on the scope; until a later run passes, a failed or declined dependent, or one that has not run, blocks `ship` with `dependents_blocked` and keeps `readyToShip` false, and a dependency on another repository's component never runs. |
| Implementation review | An independent review of the verified result of a slice marked `required`. |
| Review record | The Prism record of one slice's review waves, lanes, and findings, read through `get_review` and changed through `update_review`. |
| Review wave | One pass of fresh reviewers over one verified result of a slice; after two waves for one accepted design, each further wave needs the user's answered decision gate. |
| Review lane | One independently scoped review in a review wave. |
| CLEAN | A review lane result with no unresolved finding. |
| Review probe | A minimal failing test that a reviewer adds through a public surface to prove a finding. |
| Gate | A user decision that controls progress. |
| User gate record | A pending coordination state entry for a question to the user, with its kind, slice, question, context, artifacts, optional options with consequences, a recommendation for a decision, and any answer that the person recorded in the review browser as a review app action, with its author and history entry; Prism refuses a decision or assistance gate without context, and a decision gate without consequences or a recommendation. |
| Blocker | A question for the person that stands on its own: the question in one or two plain sentences; context with what happened, what was tried, and a concrete example; for a choice, each option with what happens if the person picks it; and the recommended answer with why. |
| Review app action | A change to Prism records that the review app lists and applies through one registry of declared actions, such as an initiative setting, a gate answer, or a component's index rebuild, refused when the record changed since the page read it. |
| Action history | The entries of applied review app actions, each with a unique id, the values before and after, the time, and its author as the applying checkout's Git identity and checkout label, a claim that nothing verifies; the coordination state keeps an initiative's history, and each checkout keeps its index rebuilds on its own machine. |
| Write session | The credential with which one browser tab applies review app actions: a token that the tab takes once from the one-time grant in the URL fragment of a review page that Prism opened, keeps for itself, and sends with each change; a tab opened from a review URL without a grant, such as one an agent printed, can only read. |
| Orchestrator | The agent that coordinates an initiative: it runs design, implementation, and review in child sessions, starts slices, and keeps gates, while Prism records progress from its calls. |
| Child status | The short fixed result a child session returns: result, last commit, a one-sentence summary, and questions written as blockers. |
| Fresh context | A session that starts without the conversation that authored its inputs. |
| Decision autonomy | A run setting that selects which gates wait for the user. |
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
- Ask only at a real gate or unresolved choice, as a [blocker](#common-terms) in plain language before its artifact reference.
