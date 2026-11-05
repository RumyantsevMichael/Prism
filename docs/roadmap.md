# Roadmap

This file is a generated view of roadmap.json.
Current progress is derived from initiative records, so read it through `get_roadmap` or the review browser.

Serves: Reliable planning and resumable work in Prism's spec-driven engineering workflow.

## Initiative index

### Now

- **Shared record store** (`shared-record-store`): Let every checkout and machine of a project share one set of Prism records through an ordinary Git repository, without losing bytes or colliding on unrelated changes.
- **Single review app** (`single-review-app`): Run one review app per user that every agent session and project shares, with a project switcher that shows which project waits on the user.
- **Repository intelligence** (`repository-intelligence`): Give workflow agents deterministic repository evidence: providers, context planning, session capacity, structural analysis, and duplication gates.
- **Components in one repository** (`components`): Let a repository declare components with their own test commands and dependencies, keep each leaf slice inside one component, run dependents' tests when a spanning scope finishes, and prepare the native index per component so a large monorepo fits its limits.
- **Initiative settings from the review app** (`initiative-settings-actions`): Let the person change an initiative's orchestration settings from the review app through a generic, revision-checked action mechanism that only the person's page can write and that later actions reuse unchanged.

### Next

- **Agent execution evidence and continuity** (`agent-execution-evidence`): Report observed context ranges, keep pause checkpoints current and recoverable, and assess diagram readability.

### Shipped

- **Repository names in a shared store** (`repository-names`): Name each repository that shares a record store by a committed name the store registers with its remote, and let each machine know where its checkouts of each repository are. Shipped 2026-11-03.

## Sequencing rationale

- **Shared record store**: Now, because Michael made shared state outside working repositories milestone M1 on 2026-10-31: his colleagues use Prism across many repositories and give the best feedback. Increments 1 and 2 shipped in PR #57; code links, the migration ledger, the saved-conflict notice, and the structural merge are in PR #72; slice claims come next. Requirements and ADRs stay Proposed while they are adjusted.
- **Single review app**: Now, because Michael asked for it on 2026-10-17 and approved the design direction in the project thread; it builds on the plain-HTTP review server from PR #25.
- **Repository intelligence**: Kept in Now while repository-intelligence work continues on main.
- **Components in one repository**: Now, because Michael agreed on 4 November 2026 in the project thread that components are the next milestone after repository names, as increments 2 and 4 of the M3 multi-repository workspace design, with per-component indexing for issue #14; it is proven on one real Lumen initiative across two or more packages. Requirements stay Draft until Michael accepts the file text.
- **Initiative settings from the review app**: Now, because Michael agreed the scope and approved the requirements on 2026-11-05; it builds on the single review app and moves gate answers and index rebuild onto one write path.
- **Agent execution evidence and continuity**: Next, because observed-range reporting consumes verified ranges from repository context planning, while pause checkpoints and diagram-readability assessment can proceed independently after design. The new work stays together until design shows that its outcomes need separate sequencing.

## Open questions

- Should the three outcomes of agent-execution-evidence remain in one initiative after design assigns concrete slices?
- Should shipped initiatives be backfilled after the first roadmap baseline is accepted and reviewed against repository history?

## Lifecycle

`envisioned`, `planned`, and `in-progress` are derived from initiative records and coordination state.
`shipped` and `superseded` are recorded decisions.
