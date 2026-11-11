# Roadmap

This file is a generated view of roadmap.json.
Current progress is derived from initiative records, so read it through `get_roadmap` or the review browser.

Serves: Reliable planning and resumable work in Prism's spec-driven engineering workflow.

## Initiative index

### Now

- **Shared record store** (`shared-record-store`): Let every checkout and machine of a project share one set of Prism records through an ordinary Git repository, without losing bytes or colliding on unrelated changes.
- **Single review app** (`single-review-app`): Run one review app per user that every agent session and project shares, with a project switcher that shows which project waits on the user.
- **Repository intelligence** (`repository-intelligence`): Give workflow agents deterministic repository evidence: providers, context planning, session capacity, structural analysis, and duplication gates.
- **Shipped work as history** (`shipped-work-history`): Treat a shipped initiative's state as immutable history that tools and skills recognise, and let fixes to done work ship inside the initiative that has not shipped yet.
- **Launched sessions from the review app** (`launched-sessions`): Let the person start, watch, stop, and continue an initiative's orchestration as a headless Claude Code or Codex session on their own machine, resumed by Prism when they answer its gates.
- **Review loop decisions from the findings** (`review-loop-decisions`): Let the user accept a slice whose remaining review findings are all low with tracked follow-ups, and ask the review loop decision with a findings summary, only options Prism can carry out, and a recommendation by a stated rule.
- **Index preparation that finishes** (`index-preparation`): Make every native index build finish while it makes progress, publish structure before embeddings, keep a stopped build's work, keep scoped calls fast, and rank searches across indexes as well as inside one.

### Next

- **Agent execution evidence and continuity** (`agent-execution-evidence`): Report observed context ranges, keep pause checkpoints current and recoverable, and assess diagram readability.
- **Workspace artifacts in the store** (`workspace-artifacts`): Keep a workspace's requirements, ADRs and plans in its shared store, reviewed in Prism and changed in status only at gates, while executable artifacts stay with the code.
- **Show a whole workspace in the review app** (`workspace-view`): Make the workspace, one record store, the unit the review app opens: list workspaces only, combine every scope's artifacts for people and agents, add a workspace from its store URL alone, and show code-repository content from Prism-kept clones. Requires `workspace-artifacts`.
- **Nested work items** (`nested-work-items`): Replace initiatives with one nested work item, so any node of the work tree is a work item and a leaf done in one session stays a slice, and migrate existing records, terms, tools and skills to it while a top work item pins each reference repository it reads to a commit that its children inherit. Requires `workspace-artifacts`.
- **Questions about records and code** (`record-search`): Answer with records rather than passages, find similar and governing records for an intent, and read the recorded links between records and code in both directions. Requires `index-preparation`.
- **Search of reference repositories and libraries** (`reference-search`): Let a separate search_references tool answer from reference repositories, libraries, and peer workspaces' records at the commit or version a work item pins, without mixing them into the project's own results. Requires `index-preparation`, `record-search`, `workspace-artifacts`.

### Shipped

- **Navigate the review app by places** (`review-app-places`): Switch the review app between Attention, Work, Roadmap, Knowledge, and History from an icon rail, with the sidebar showing only the current place, so large projects stay navigable without losing any page or feature. Shipped 2026-11-10.
- **Initiative settings from the review app** (`initiative-settings-actions`): Let the person change an initiative's orchestration settings from the review app through a generic, revision-checked action mechanism that only the person's page can write and that later actions reuse unchanged. Shipped 2026-11-08.
- **Components in one repository** (`components`): Let a repository declare components with their own test commands and dependencies, keep each leaf slice inside one component, run dependents' tests when a spanning scope finishes, and prepare the native index per component so a large monorepo fits its limits. Shipped 2026-11-07.
- **Repository names in a shared store** (`repository-names`): Name each repository that shares a record store by a committed name the store registers with its remote, and let each machine know where its checkouts of each repository are. Shipped 2026-11-03.
- **Review app UI kit** (`review-app-ui-kit`): Give the review app one set of design values, one shared component per kind of control, theme and density choices, and a served catalog with checks, so every screen stays consistent as it moves toward an IDE-like tool. Shipped 2026-11-09.

## Sequencing rationale

- **Shared record store**: Now, because Michael made shared state outside working repositories milestone M1 on 2026-10-31: his colleagues use Prism across many repositories and give the best feedback. Increments 1 and 2 shipped in PR #57; code links, the migration ledger, the saved-conflict notice, and the structural merge are in PR #72; slice claims come next. Requirements and ADRs stay Proposed while they are adjusted.
- **Single review app**: Now, because Michael asked for it on 2026-10-17 and approved the design direction in the project thread; it builds on the plain-HTTP review server from PR #25.
- **Repository intelligence**: Kept in Now while repository-intelligence work continues on main.
- **Launched sessions from the review app**: Now, because Michael approved the requirements on 2026-11-09 after agreeing the scope in the project thread; it builds on the review app action registry and gate answers.
- **Review loop decisions from the findings**: Now, because the user asked on 2026-11-10: review loop gates always offered the same three options, agents always recommended another wave, and accepting low findings left no record.
- **Index preparation that finishes**: Now, because indexing reliability is stabilization work Michael asked threads to drive: large builds never finish today (#14), coverage reports almost nothing covered (#119), and scoped reports miss sibling components (#120). Measured on 7 November 2026; approved on 11 November under Michael's overnight delegation.
- **Agent execution evidence and continuity**: Next, because observed-range reporting consumes verified ranges from repository context planning, while pause checkpoints and diagram-readability assessment can proceed independently after design. The new work stays together until design shows that its outcomes need separate sequencing.
- **Workspace artifacts in the store**: Next, because Michael decided on 7 November 2026 that descriptive artifacts move to the store so every session's progress is visible in one place, and that Prism's own documents leave its public repository.
- **Show a whole workspace in the review app**: Next, after workspace-artifacts, whose store artifacts and scopes it builds on and whose scope filter it amends; Michael asked for it on 10 November 2026 and agreed the design the same day.
- **Nested work items**: Next, after workspace-artifacts, whose store artifacts the migration moves; Michael decided on 8 November 2026 to drop initiatives for one nested work item, and that a top work item pins the reference repositories it reads, with children inheriting the pins.
- **Questions about records and code**: Next, because Michael asked on 8 November 2026 for duplicate, governing-record, gap, and record-to-code questions; the November record-question baseline showed search alone cannot answer them. It needs cross-index ranking from index-preparation.
- **Search of reference repositories and libraries**: Next, because Michael decided on 9 November 2026 that workspaces declare reference repositories and libraries pinned per work item; it needs workspace settings and work-item pins from workspace-artifacts, record results from record-search, and finishing builds from index-preparation.

## Open questions

- Should the three outcomes of agent-execution-evidence remain in one initiative after design assigns concrete slices?
- Should shipped initiatives be backfilled after the first roadmap baseline is accepted and reviewed against repository history?

## Lifecycle

`envisioned`, `planned`, and `in-progress` are derived from initiative records and coordination state.
`shipped` and `superseded` are recorded decisions.
