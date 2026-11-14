---
name: workflow
description: "Explain Prism phases, artifact ownership, and common terms when choosing or coordinating workflow skills."
sdm: "0.3"
---

# Prism workflow

- Read `.prism/workflow.md` when present for project paths, the test command, and settings.
- Use project procedures before Prism fallbacks, and make small changes directly when project conventions supply enough guidance.

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

- Read durable sources in this order: glossary, Approved requirements, relevant ADRs, and relevant feature files, and take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, because a shipped initiative's state is [shipped history](#common-terms).
- Stop and report conflicting durable sources for user resolution.
- Change Prism records only through Prism MCP tools, never by editing their files or generated views, and report a refusal that the tool's message does not resolve.
- In a project with a store, read each [store artifact](#common-terms) only through `get_artifact` and change it only through `update_artifact`, never through a checkout file, and leave its status lines to [approval gates](#common-terms) and to the ship that a [correctness gate](#common-terms) confirms, while a project without a store edits these files and their status lines in the checkout as the owning skill says.
- Persist a fact only when a later session needs it and no existing artifact owns it.
- Keep durable requirements, ADRs, features, and user guidance free of slice identities and plans paths.

## Common terms

| Term | Definition |
| --- | --- |
| Initiative | A roadmap-owned item that groups related Approved outcomes, identified by a stable identifier that names its plans folder. |
| Prism record | Machine JSON that only Prism MCP tools read and write, addressed by initiative and slice identifiers rather than file paths. |
| Roadmap record | The Prism record owning initiative bands, order, required initiatives, rationale, open questions, recorded ship and supersede decisions, and the shipped initiative and slices that a fix initiative `corrects`, read through `get_roadmap` and changed through `update_roadmap`; its `readyToShip` is true once nothing but a ship's [correctness gate](#common-terms), which is the newest pending one, and the ship's reading of the initiative's `slice.md` files and the ADRs they link stands in the way, so with a store `ship` can still refuse with `ship_unconfirmed`, `adr_pending`, `adr_ambiguous`, or `artifact_too_large`. |
| Initiative lifecycle | `envisioned`, `planned`, and `in-progress` derived by `get_roadmap` from the initiative record and coordination state, plus recorded `shipped` and `superseded` decisions; a shipped initiative's state is shipped history from then on. |
| Initiative record | The Prism record of slice titles, outcomes, topology, requirement assignments, dependencies, status, and accepted designs, read through `get_initiative` and changed through `update_initiative`; `initiative.md` is its generated view. |
| Coordination state | The initiative's Prism record of settings, active work, pending user gate records, next actions, and the action history, read through `get_coordination_state` and changed through `update_coordination_state`, except the action history and the settings marks that only review app actions write. |
| Person change notice | `personChanges` on a Prism result that names an initiative, shown once per session and only to the initiative's coordinator, the agent whose claim or slice start last succeeded in the session, or its main agent until one has: the person's changes from the review app that the session has not seen, each with its author; a coordinator's gate wait returns them with status `changed`, and an agent's settings write keeps each setting the person set and lists it under `keptSettings`. |
| Slice | One observable outcome across required layers that one fresh implementation session delivers, planned by a contract. |
| Contract scope | The root slice, a part that a split design created, or a done slice with reported defects, that one design gives one contract. |
| Slice plan | The **Slices** section of a contract: each planned slice with its outcome, component, requirements, dependencies, frozen test files, and review recommendation. |
| Workspace | The grouping of one record store with every checkout and repository that shares it, named by the workspace name that `update_roadmap` sets with `set_workspace_name`, or after the store while it has none; it is the review app's unit, which lists and opens workspaces only, and a project without a store is a workspace of one; an agent reads the artifacts of every scope of the workspace through `get_artifact`, naming another scope by the scope label that its listings report, `workspace`, a repository's name, or `<repository>/<component>`, and changes only the artifacts of its own checkout's scopes. |
| Store artifact | A requirement, ADR, plan file such as `slice.md`, a diagram, or `recovery.md`, the glossary, or the roadmap view in a project whose `.prism/workflow.md` names a store, which Prism keeps in the store under its project-relative path with its [artifact scope](#common-terms), its comments from the review browser, and, for a requirement or ADR, the status that only gates change, read through `get_artifact` and changed through `update_artifact` with the version last read; the first Prism call of a checkout moves its tracked files of these kinds into the store and reports each move or why a file stays, while feature files, step definitions, tests, executable contracts, user documentation, and code stay in the checkout and the tools refuse them with `not_an_artifact`. |
| Artifact scope | The workspace, a repository, or a component that a store artifact belongs to, labeled `workspace`, `<repository>`, or `<repository>/<component>`; a checkout reads every scope and changes the workspace scope and its own repository's scopes, a new artifact takes the given `scope`, else its nearest folder's, else the workspace's, and `move_scope` moves an artifact with its comments. |
| Accepted version | A store artifact's bytes when a person last accepted it: at its approval gate, at the acceptance of the design of the slices whose folder holds it, at the ship of its initiative, or, for a file that moved in with a status past `Draft` or `Proposed`, at the move; `get_artifact` returns `acceptedVersion` and `changedSinceAccepted`, and reads those bytes with `accepted` true, which a reader that needs only approved text uses. |
| Portable name | A file, folder, or identifier name that agents choose in every project, with or without a store, so that a repository shared by Windows, macOS, and Linux engineers checks out everywhere: an ASCII letter or digit first, then only ASCII letters, digits, `.`, `_`, and `-`; no `.` or `.lock` ending; no Windows device name such as `con`, `aux`, `nul`, `com1`, or `lpt1` before the first `.`, in any letter case; no other name in the same folder that differs from it only in letter case; a project-relative path of at most 100 characters; and, for an initiative or slice identifier, no `.` and at most 40 characters. |
| Component | A part of a repository with its own folder, optional test command, and dependencies, declared under `## Components` in `.prism/workflow.md` and identified across the workspace as `<repository>/<component>`, where the repository's name is its `Repository` name under `## Workspace`, or `root` when it gives none. |
| Root component | The component named after the repository that holds every file outside the declared folders and tests with the repository's test command; a repository that declares no components is its root component alone. |
| Component proposal | A `## Components` block that `get_roadmap` returns as `components.proposal` when `.prism/workflow.md` lists no component and a workspace manifest at the project root gives workspace patterns, one component per member folder; Prism never writes it, and it takes effect only when the person commits it under `## Components`. |
| Shared path | A file or folder listed under `Shared paths` in `## Components` that any slice may change, whichever component it belongs to. |
| Component boundary | The rule that a planned slice's **Changes** and frozen tests, and every change made since its start content, stay inside its component or under a shared path; the start content is the project's content and `## Components` declaration that Prism records when the slice starts and keeps under this checkout's local ref `refs/prism/<initiative>/<slice>/<checkout>/start` until the slice returns to not-started; another slice's frozen tests at their frozen content and its verified changes do not count; Prism refuses a design that crosses the boundary, and fails a verification run that crosses it, with `component_boundary`, or with `start_content_missing` when Git can no longer read the start content or it was recorded without a declaration. |
| Split evidence | What Prism requires before a scope splits into parts that get their own contracts: `contract_size`, contract files estimated above the token budget that one implementer reads; `unfrozen`, an Unprobed assumption that one part settles; or `user_gate`, a gate where the person asked for the split. A split into a contract's slice plan needs none. |
| `slice.md` | A design document in a slice folder: for a contract scope, the contract, assumptions, and slice plan, or the interfaces between parts after a split; for a planned slice, its changes. |
| Approved requirement | An accepted product or system obligation. |
| Defect | Reported behavior that contradicts an Approved requirement; `triage` reproduces it and links that requirement, so the fix needs no new requirement, and records it on the done slice with `report_defect` while that slice's initiative has not shipped, or adds a later initiative that `corrects` the shipped work. |
| Fix slice | A new slice below a done slice that fixes defects reported on it with `report_defect`, proposed through one `add_fix` in the done scope's design and kept in its own folder, while the done slice's records stay unchanged; ship refuses with `fixes_unfinished` until every reported defect has a done fix slice. |
| Shipped history | A shipped initiative's state: its records, contracts, slice documents, frozen tests, verification runs, and reviews, which Prism marks in each slice document, reports through `shippedHistory`, and refuses to change with `initiative_shipped`; sessions cite it only as history. |
| Requirement assignment | Approved requirement references whose coverage is preserved through each split. |
| Effective dependencies | A leaf's own dependencies plus the dependencies inherited from its ancestors. |
| Starting surface | The command, route, public function, event, job, or user action where a slice enters the system. |
| FIT | A design result with a frozen contract, probed assumptions, failing acceptance tests, and a slice plan. |
| SPLIT | A design result with parts of a scope that cannot be one contract, their order, their shared interfaces, and the split evidence, but no new tests. |
| BLOCKED | An unresolved requirement, decision, or external fact stops progress. |
| Contract | The frozen observable interface of a contract scope that fixes what the requirements leave open, shared by its planned slices. |
| Assumption probe | A small experiment against the real system that confirms a contract assumption, or a fail-safe clause where no probe is possible. |
| Contract defect | A contract clause that an implementer finds wrong, or that a review finding names as its cause, reported through `verify_slice`, or an unresolved finding of a slice that the review loop decision returns to design through `update_review` `return_to_design`, which blocks the slice until design revises the contract. |
| Frozen tests | Acceptance test files of one slice, fixed when its design is accepted; implementation must not change them unless its slice is a fix of that slice whose **Changes** names the file, and verification refuses to run when one changed. |
| Staged tests | Frozen tests of a slice that has not started, which Prism keeps out of the work tree until `set_status` `in-progress` starts the slice, or until `restore_tests` puts them back for a design revision. |
| Design diagrams | PlantUML source written by design: an overview of each contract's slices, shared interfaces, and order, and a code view per slice; Prism parses them and refuses a view that does not parse or shows more than 30 elements. |
| Changes | The files a planned slice is expected to add, change, or remove, with the units each adds or whose interface it changes; after verification the review browser compares them with what the verified result changed. |
| Design gate | The user's acceptance of a design, which the autonomy setting may resolve automatically. |
| Design proposal | A design result that design records through `update_initiative` and Prism checks at once, kept pending without changing any slice until the orchestrator accepts it after the design gate. |
| Claim | A slice's mark naming the one Prism server that works on it, for `design` or `implementation`, taken by `claim` on a scope before design, or on a slice in progress after a lapse, or by `set_status` `in-progress`; it covers the slice's descendants, Prism refuses another holder's start or change with `slice_claimed` and an agent's work on a slice that no claim of its own covers with `claim_required`, and it ends when the slice leaves `in-progress`, when the scope's proposal is accepted, through `release_claim`, or 30 minutes after its last renewal. |
| Design view | The review browser's page for a design gate: one example per frozen test under its contract clause, clauses without a test, and the planned changes, written through `update_design_view` by the example writer. |
| Example writer | A child agent on a small model that writes the design view from the contract and the frozen tests only. |
| Accepted design | A planned slice's design recorded through `update_initiative` with its frozen tests, its review mark, and its component. |
| Review mark | `required` or `none` on an accepted design, set from the user's marks at the design gate and the `review` setting at that moment; a later change of the setting keeps it. |
| Verification run | An implementer's `verify_slice` run of the user-approved test command from `.prism/workflow.md`, recorded on the slice: the slice's component's own command in its folder, or the repository's command in the project root, after checking the component boundary against the slice's start content; a slice with an accepted design completes only on a fresh passing run, which completes a slice marked `none` by itself. |
| Dependents' run | The `verify_slice` run with `dependents` `true` that the orchestrator starts once every leaf of a contract scope whose design accepted a slice plan, or of a leaf that is a scope of its own, is done: the test command of every component of the same repository that depends, directly or through other components, on a component of the scope's leaves, each distinct command and folder once in dependency order behind one approval gate, recorded on the scope; until a later run passes, a failed or declined dependent, one that has not run, or a run that started before a leaf of its scope last passed verification blocks `ship` with `dependents_blocked` and keeps `readyToShip` false, and a dependency on another repository's component never runs. |
| Implementation review | An independent review of the verified result of a slice marked `required`. |
| Review record | The Prism record of one slice's review waves, lanes, and findings, read through `get_review` and changed through `update_review`. |
| Review wave | One pass of fresh reviewers over one verified result of a slice; after two waves for one accepted design, each further wave needs a review loop decision that chose `continue-review`. |
| Review loop decision | The `decision` gate that Prism records when `start_wave` refuses a further review wave with `review_loop_limit`, with the unresolved findings and the findings of each wave as context, offering `continue-review`, `return-to-design`, and, while every unresolved finding is low, `accept-deferred`; it recommends `accept-deferred` while offered, otherwise `return-to-design` when the latest wave raised at least as many findings above low severity as the wave before it, and otherwise `continue-review`. |
| Deferred finding | A low finding with status `DEFERRED`, which `accept_wave` sets on a review loop decision that chose `accept-deferred`, kept with that gate and a follow-up reference in the project's tracker or a roadmap open question; it counts as resolved, and Prism refuses to change it. |
| Review lane | One independently scoped review in a review wave. |
| CLEAN | A review lane result with no unresolved finding. |
| Review probe | A minimal failing test that a reviewer adds through a public surface to prove a finding. |
| Gate | A user decision that controls progress; a correctness gate is a `correctness` user gate record that asks the person to confirm that a finished initiative ships, and with a store `ship` takes its id as `afterGate` only once the person approved it in the review browser, refusing with `ship_unconfirmed` a missing or unapproved gate, one answered in the conversation, and one asked before a leaf's latest passing verification run or before a change to the initiative's `slice.md` files, the repositories their links resolve in, or the ADRs the ship would accept; a pending gate that `afterGate` names is not open work for that ship, which closes it, and asking a new correctness gate closes each earlier one that the person answered, while every other pending gate, an unanswered earlier correctness gate included, stays open work. |
| User gate record | A pending coordination state entry for a question to the user, with its kind, slice, question, context, artifacts, optional options with consequences, a recommendation for a decision, and any answer that the person recorded in the review browser as a review app action, with its author and history entry, or the option that `resolve` keeps as `choice` for an answer given in conversation; Prism refuses a decision or assistance gate without context, and a decision gate without consequences or a recommendation. |
| Approval gate | A gate that waits for the person's approval before Prism acts: the one `verify_slice` asks before it runs a test command in a folder that the person has not allowed, or the one that `update_artifact` `ask_approval` records on a requirement or ADR at the file's current version with the status that approving sets, `Approved` by default, which `wait_for_user_gate` waits on with `artifact` in place of `initiative` and only the review browser answers; approving that one rewrites the file's `Status:` line, and for `Approved` its `Approved:` line, and records that status and the [accepted version](#common-terms), an answer to a file that changed since the ask is refused, and no approval sets an ADR `Accepted`. |
| Blocker | A question for the person that stands on its own: the question in one or two plain sentences; context with what happened, what was tried, and a concrete example; for a choice, each option with what happens if the person picks it; and the recommended answer with why. |
| Review app action | A change that the review app lists and applies through one registry of declared actions, such as an initiative setting, a gate answer, a component's index rebuild, or the launch, stop, or resume of a launched session, refused when the record changed since the page read it; only the index rebuild and the launched-session actions start or end processes. |
| Action history | The entries of applied review app actions, each with a unique id, the values before and after, the time, and its author as the applying checkout's Git identity and checkout label, a claim that nothing verifies; the coordination state keeps an initiative's history, and each checkout keeps its index rebuilds on its own machine. |
| Write session | The credential with which one browser tab applies review app actions: a token that the tab takes once from the one-time grant in the URL fragment of a review page that Prism opened, keeps for itself, and sends with each change; a tab opened from a review URL without a grant, such as one an agent printed, can only read. |
| Launched session | A headless Claude Code or Codex session of one initiative's orchestration that Prism started on the person's machine because the person launched it in the review app, run by a detached supervisor under the host's automatic permission handling and the project's host settings; the review app's Launched sessions place shows its state and the terminal command that continues it and stops or resumes it, a gate answer given on that machine resumes it, and its host session identifier never leaves that machine; the person confirms a launch in a native dialog of the operating system, which opens the launch window: the 30 minutes in which further launches and resumes on that machine start without asking, whose end stops no running launched session. |
| Orchestrator | The agent that coordinates an initiative, its coordinator from its first claim: it runs design, implementation, and review in child sessions, starts slices, and keeps gates, while Prism records progress from its calls. |
| Child status | The short fixed result a child session returns: result, last commit, a one-sentence summary, and questions written as blockers. |
| Fresh context | A session that starts without the conversation that authored its inputs. |
| Decision autonomy | A run setting that selects which gates wait for the user. |
| Slice continuation | A run setting that controls whether the next slice starts without the user. |
| `recovery.md` | A slice note that preserves unfinished work when a run pauses. |
| Pause checkpoint | An orchestrator action that writes `recovery.md` and updates coordination state together. |
| Proposed ADR | An architectural decision recorded for acceptance after its slice passes verification: without a store, orchestration sets it `Accepted`, and with a store, the `ship` of an initiative whose `slice.md` files link it does, after a correctness gate, recording the commits of the verified slices. |
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
