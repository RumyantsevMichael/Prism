# Workflow

Prism delivers an initiative as a tree of slices.
Each slice is designed when it is next, implemented in fresh agent sessions against frozen acceptance tests, and verified by running your tests.

## Stages

| Stage | Skill | Result |
|---|---|---|
| Shape | `prism:ideate` | Approved EARS requirement files and a roadmap entry, or a decision to stop |
| Triage a bug | `prism:triage` | A reproduction and the Approved requirements it breaks, with a roadmap entry, or a hand-off to ideate |
| Run an initiative | `prism:orchestrate` | One root slice, then each slice in turn |
| Design | `prism:design` | A frozen contract, probed assumptions, and failing acceptance tests, or a split into child slices |
| Implement | `prism:implement` | Working code for one step of a designed slice, committed |
| Verify | the Prism server | A recorded run of your test command |
| Review | `prism:review` | Independent findings on a verified slice whose design asks for review |
| Refactor | `prism:refactor` | Relationship analysis, a desired model, and proposed or verified behavior-preserving changes |

## Slices

The roadmap owns each initiative's name, intent, priority, and Approved requirement links.
When those inputs are missing, orchestration runs `ideate` first.
Design explores documents and focused code paths, then proposes `FIT`, one contract with a plan of slices, or `SPLIT`, parts with their order and the interfaces between them, or returns `BLOCKED`.
Prism checks a proposal as soon as design makes it and keeps it pending until the design gate accepts it.
Design splits a scope only with evidence Prism can check: a contract too large for one implementer to read, an unprobed assumption that one part settles, or your own request at the design gate.
Each part of a split is designed only when the parts it depends on are done.
A long initiative therefore never freezes a contract for work that is weeks away.

A fitted slice has a contract that fixes everything a user or caller observes, a list of assumptions about the system that design either probed or made fail safe, and acceptance tests that fail until the behavior exists.
The design also lists the files it expects to change, with the functions or types involved.
You approve the design in the review browser, unless the autonomy setting accepts it for you, and the slice's [design view](review-browser.md) shows its acceptance tests as plain-language examples under the contract clauses they check.
When a slice is too large for one implementation session, its design lists ordered steps, and each step runs in a fresh session.
Implementers may not change the frozen tests, and a contract problem goes back to design.

## Records

The MCP server owns the roadmap and initiative records, and agents change them only through its tools.
It validates requirement coverage and the slice dependency graph on every write, and refuses to mark a slice done without a passing completion gate.
Initiative progress on the roadmap is derived from the initiative records.
Each slice folder keeps the slice design in `slice.md`, and a recovery note when a run pauses.
A short resume note records settings, active work, pending questions, next actions, and evidence paths, so an interrupted initiative resumes where it stopped.

Requirements preserve intent, ADRs preserve decisions, and feature files preserve acceptance examples.
Tests and consumed contracts enforce behavior, and code supplies implementation details.

## Verification

A slice whose design is accepted lists its frozen acceptance tests and says whether its implementation needs independent review.
Before such a slice can be marked done, Prism runs your project's test command and records the run on the slice.
The implementer asks for that run itself and fixes failures in its own session; when it finds the contract wrong, it reports the clauses instead, and the slice waits for a revised design.
Configure the command in `.prism/workflow.md`:

```markdown
## Stack
- Test command: npm test
```

A slice that records a [component](#components) runs that component's own `Test command` in the component's folder, or the `Test command` under `## Stack` in the project root when the component declares none.
The root component, and a slice accepted before components existed, run the `Test command` under `## Stack` in the project root.
Each result names the command, the folder it runs in, as a project-relative path that is empty for the project root, and the slice's component.
The folder is where the command really runs once symbolic links are followed, so a component folder that is a link to `lib/billing` runs, and is named, in `lib/billing`.

The first run of a command in a folder asks you in the review browser to allow that exact command in that folder, and a changed command, or the same command in another folder, asks again.
The question, in the review browser and in a cloud session's chat alike, names the command and the folder it runs in, project-relative, and never an absolute path of your machine.
An approval you gave before components existed still allows that command in the project root.
Approvals stay in Prism's local plugin data, never in your repository.
The command runs with your shell in its folder and the environment of the Prism server, except `NODE_USE_ENV_PROXY`, which Prism sets only for its own downloads, and the plugin directories that the agent host sets for Prism, such as `CLAUDE_PLUGIN_DATA`.
Prism refuses to run when a frozen acceptance test changed after the design was accepted.
Before it asks for approval, Prism refuses a slice whose recorded component the repository no longer declares with `component_unknown`, one whose component and `## Stack` give no test command with `test_command_missing`, one whose working folder does not exist with `component_folder_missing`, and one whose component folder leads outside the project through a symbolic link with `component_folder_outside`.

When a slice that records a component starts, Prism records the project's content, with the slice's frozen tests in place, as its start content, together with that time and the `## Components` declaration in force.
A slice keeps its start content when it is restarted after being blocked and when it receives a new design.
Prism keeps the start content under the local Git ref `refs/prism/<initiative>/<slice>/start`, and the content of the slice's latest passing run under `refs/prism/<initiative>/<slice>/passed`, so `git gc` keeps them; Prism never pushes these refs, and a clone does not carry them.
Before each run, Prism compares the project with the start content, and every project file added, changed, or removed since then, committed or not, counts as a change, a moved file at both of its paths.
Two kinds of change made by other slices of the initiative do not count: another slice's frozen test that holds its frozen content, or is absent while that slice has not started, and a file that another slice's latest passing run changed after this slice started and that still holds the content that run tested.
So another slice's verified work done while this slice was blocked or waiting does not fail it, while this slice's own changes still count.
A change that lies under no shared path and outside the slice's component, by the declaration recorded with the start content, crosses the component boundary: the command does not run, and the run fails with reason `component_boundary`, listing up to 200 crossing paths in `crossing` and their number in `crossingCount`, so the slice cannot complete until those changes move back or the contract changes.
For the root component, a change crosses when it lies inside another component's folder.
A change to `## Components` therefore applies only to slices started after it.
A result's `boundary` is `checked` when the run made that comparison, and `unchecked` when Prism recorded no content at the slice's start, such as a slice started where Git could not hash the work tree, which runs without the check.
When Git can no longer read a slice's start content, for example in another checkout that shares the records but not the Git objects, the run fails with reason `start_content_missing` and the command does not run.
To continue, set the slice back to `not-started` and start it again: Prism drops the old start content and its refs, and records the current content, the slice's earlier changes included, as new start content.
A passing run counts only while the project's source, tests, and configuration stay as they were when it ran, so a later edit needs a new run.
When the design requires review, an independent reviewer also reviews the verified result, and a later change needs a new run and a new review.
A finding that a contract clause itself causes sends the slice back to design instead of into another fix.
After two review waves for one accepted design, Prism asks you whether to continue the review, return the slice to design, or narrow it before each further wave.
The slice page in the review browser shows the latest run with its command, exit code, and output tail, and a failed run also names the failing tests that Prism found anywhere in the output.
Verification runs need a git work tree, and `PRISM_VERIFY_TIMEOUT_MINUTES` changes the 30-minute default timeout.

## Components

A repository can declare its packages as components in `.prism/workflow.md`, so that each planned slice stays inside one of them:

```markdown
## Components
- billing: packages/billing
  - Test command: npm test
  - Depends on: shared, portal/site
- shared: packages/shared/
- Shared paths: package-lock.json, config/shared/
```

Each top-level item names a component and its folder, relative to the project root, with forward slashes and without `.` or `..` segments; a trailing `/` is ignored, and the folder need not exist yet.
A name has 1 to 64 lowercase letters, digits, hyphens, or underscores, and starts and ends with a letter or digit.
The nested `Test command` and `Depends on` items are optional, labels match without case and without a parenthesized note, and lines that are not list items are ignored.
[Verification](#verification) runs a slice's component's test command in the component's folder.

Every file outside the declared folders belongs to the root component, which is named after the repository and tests with the `Test command` under `## Stack`.
A repository that declares no components is its root component alone.
A file belongs to the component whose folder holds it, so `packages/billing-extra/a.mjs` lies outside `packages/billing`.
Any slice may change a file under a `Shared paths` entry, which is a file or a folder with everything inside it.

Every component is identified across the workspace as `<repository>/<component>`.
The repository's name is its `Repository` name under `## Workspace`, with or without a `Store` line, and `root` when it gives none, so the components above are `api/billing` and `api/shared` in a repository named `api`, and its root component is `api/api`.
A `Depends on` entry names a component of this repository, bare or qualified with this repository's name, or another repository's component as `<repository>/<component>`, which Prism checks only for its form.

Design names each planned slice's component when it proposes the slice plan, and Prism records it on the slice as `<repository>/<component>`.
In a repository without components, a slice that names none records the root component.
Prism refuses the design with `component_unknown`, listing the repository's components, when a slice names no component in a repository that declares some, or names one that is not this repository's.
It refuses the design with `component_boundary`, listing each crossing path, when a slice's planned changes or frozen tests belong to another component and lie under no shared path.
Paths under `.prism`, the plans folder, and the roadmap belong to no component and are never checked.

Accepting a design, and verifying a slice that records a component, refuse an invalid declaration, and report its first problem in this order:

| Refusal | Problem |
|---|---|
| `component_invalid` | An invalid name, folder, shared path, or `Depends on` entry, a name declared twice or equal to the root component's name, an unknown nested label, a nested item before any component, or an invalid `Repository` name; `entry` quotes the line |
| `component_overlap` | Two components with the same folder, or one folder inside another |
| `component_dependency_unknown` | A `Depends on` entry of this repository that names no declared component and not the root component |
| `component_cycle` | `Depends on` entries that form a cycle, listed in dependency order |

Reading an initiative never reads the declaration, so an invalid one stops only design acceptance and the verification of slices that record a component.

## Questions and answers

Each question that waits on you is recorded, and the review browser's Attention page lists it with the artifacts to inspect.
You can answer there instead of in the conversation.
See [Review browser](review-browser.md#attention) for how the agent receives the answer.

## Autonomy and agent flow

`orchestrate` stores decision autonomy and agent flow per initiative.
Autonomy is `conservative`, `broad`, or `full`, and agent flow is `multi` or `mono`.
Conservative autonomy waits for you at every design gate, broad autonomy accepts a design unless it changes requirements, adds an ADR, or reports an open question, and full autonomy accepts every design.
Multi flow runs design, each implementation step, and review in fresh child agents, while mono flow runs design and implementation in the orchestrator's context.
Full autonomy turns commits on when you have not set them, while explicit commit, continuation, and push settings always apply.

## Defects

Defect repair stays outside this workflow.
Reproduce and diagnose a defect against the existing specification, and change the specification only when the required behavior must change too.

## Project files

Prism stores its configuration in `.prism/workflow.md`, and all configured paths resolve from the project root.

| Content | Default path |
|---|---|
| EARS requirements | `docs/requirements/` |
| Architecture decisions | `docs/ADRs/` |
| Slice designs and recovery notes | `docs/plans/` |
| Gherkin feature files | `docs/Features/` |
| Roadmap | `docs/roadmap.md` |
| Glossary | `docs/Glossary.md` |
| User documentation | `docs/user-guide/` |

The roadmap Markdown and each initiative's `initiative.md` are generated views of records that agents change only through Prism's MCP tools.
Slices have titles such as `Download signed reports`, while stable slugs identify slices and artifact paths.
The analysis runtime, models, indexes, and retained evidence live in the plugin data directory or your private Prism cache, never in your repository.

Prism collects run statistics by default whenever its hooks are installed.
To stop collection for a project, add this section to `.prism/workflow.md`:

```markdown
## Run statistics
- Collection: off
```

The value is case-insensitive, and any other value or an absent section leaves collection on.
While collection is off, or while Prism cannot read `.prism/workflow.md`, the hooks store no run-statistics trace and read no transcript usage, and pre-edit observations continue unchanged.
`summarize_session_consumption` then reports `runMeasures.collection` as `off` or `unknown` with no executions, as described in [Summarize pre-edit consumption](repository-intelligence.md#summarize-pre-edit-consumption).
Its `runMeasures.recorded` totals then report every measure as `unavailable` rather than zero, while existing run records still report `runTotals` through `get_review` and `get_initiative`, as described in [Run records](repository-intelligence.md#run-records).

Machine records live under `.prism` by default.
To share them between machines, name the store's Git remote and this repository in `.prism/workflow.md`:

```markdown
## Workspace
- Store: git@github.com:you/prism-store.git
- Repository: api
```

`Store` names a remote when it is a URL with the scheme `https`, `http`, `ssh`, `git`, or `file`, or the scp form `user@host:path`, and any other value is a folder path.
Prism clones a remote store once per machine into its application folder on the first record access, and every checkout and host on the machine that names the same remote shares that clone.
Store sync is on by default for a remote store, and `- Store sync: off` keeps the clone without fetching, committing, or pushing after the first clone.
After a failed clone, or when another repository's clone already sits at the clone path, every record operation fails with `store_unavailable`.

To share records only between linked worktrees or clones on one machine, name a record store folder outside the project instead:

```markdown
## Workspace
- Store: ../prism-store
```

A `Store` path is relative to the project root or absolute, and it must neither resolve inside the project nor contain it.
Create or clone the store folder yourself, because Prism never creates it, and a missing folder makes every record operation fail with `store_unavailable`.
On the first record access from a checkout, Prism moves each existing record into the store unless an earlier checkout already brought it, and it keeps both copies of a record whose bytes differ and lists the conflict in the store's `migrations` folder.
Record files that other checkouts still hold under `.prism` are then ignored, and you can delete them.
Every checkout whose configuration names the same store reads and writes the same records.

`Repository` names the repository to its store, so one store can hold the records of several repositories, and record operations ignore it without `Store`, where it only names the repository's [components](#components).
A name has 1 to 64 lowercase letters, digits, hyphens, or underscores, and starts and ends with a letter or digit, or every record operation fails with `repository_name_invalid`.
The first record operation that uses a name registers it in the store with the checkout's `origin` remote and root commit.
A name registered for another remote is refused with `repository_name_taken` unless the checkout's root commit proves it is the same repository, and a remote already registered under another name is refused with `repository_remote_registered`.
Each refusal proposes a name that the store accepts.
A checkout that names a store but no repository keeps working, and each tool result that opened its store warns with the `- Repository: <name>` line to add, because a later Prism release will refuse record operations without it.

To sync a path store between machines yourself, make it a Git checkout whose branch has an upstream, and add `- Store sync: on` under `Store`.
Prism then commits record changes a few seconds after each write, merges the upstream without rebasing, and pushes, and a record read fetches in the background when the last fetch is older than 30 seconds.
When two machines change different initiatives or slices of one record, the changes merge.
When they change the same initiative or slice, the first push wins, and the store saves the other version under `.prism-sync/conflicts/`.
Records keep working locally when Git, the network, or the upstream is unavailable, and the review browser shows a small chip when the last sync did not succeed.
Without `Store sync: on`, Prism never runs Git in a path store.
See [Share Prism state across worktrees and machines](shared-records.md) for setup, conflicts, sync status, and cloud sessions.

## Migrate an older setup

Prism no longer reads `.claude/workflow-config.md`, and `prism:workflow-init` migrates its values into `.prism/workflow.md` without changing the old file.
On resume, orchestration imports a legacy `map.puml` into the initiative record.
`prism:workflow-init` proposes a roadmap record from a legacy roadmap and replaces the hand-written roadmap Markdown only after you accept it.
See [Upgrading to managed records](upgrading-to-managed-records.md) for everything that changed in Prism 0.10.0.
