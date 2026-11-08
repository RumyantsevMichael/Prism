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

A project with no tests yet, such as a new project, sets `- Test command: none yet`.
Verification then refuses with `test_command_placeholder` instead of passing, and design puts the test runner and the real `Test command` line into the first slice, whose verification runs that command once it is set and you allow it.
A no-op command such as `true` would let every slice pass without running its tests, so Prism never suggests one.

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
Prism keeps the start content under the local Git ref `refs/prism/<initiative>/<slice>/<checkout>/start`, and the content of the slice's latest passing run under `refs/prism/<initiative>/<slice>/<checkout>/passed`, so `git gc` in any worktree of the repository keeps them.
`<checkout>` is the first 16 hexadecimal digits of the SHA-256 of the project root's real path, so linked worktrees and projects that share one Git repository each keep their own refs, and Prism sets and deletes only the refs of its own checkout.
Before each run, Prism compares the project with the start content, and every project file added, changed, or removed since then, committed or not, counts as a change, a moved file at both of its paths.
Two kinds of change made by other slices of the initiative do not count: another slice's frozen test that holds its frozen content, or is absent while that slice has not started, and a file that another slice's latest passing run changed after this slice started and that still holds the content that run tested.
So another slice's verified work done while this slice was blocked or waiting does not fail it, while this slice's own changes still count.
A change that lies under no shared path and outside the slice's component, by the declaration recorded with the start content, crosses the component boundary: the command does not run, and the run fails with reason `component_boundary`, listing up to 200 crossing paths in `crossing` and their number in `crossingCount`, so the slice cannot complete until those changes move back or the contract changes.
For the root component, a change crosses when it lies inside another component's folder.
A change to `## Components` therefore applies only to slices started after it.
A result's `boundary` is `checked` when the run made that comparison, and `unchecked` when Prism recorded no content at the slice's start, such as a slice started where Git could not hash the work tree, which runs without the check.
When Git can no longer read a slice's start content, for example in another checkout that shares the records but not the Git objects, the run fails with reason `start_content_missing` and the command does not run.
To continue, set the slice back to `not-started` and start it again: Prism drops the old start content and this checkout's refs of the slice, and records the current content, the slice's earlier changes included, as new start content.
A slice started while the `## Components` declaration was invalid or did not hold the slice's component records its start content without a declaration, and the start still succeeds.
Every run of such a slice fails with reason `start_content_missing` without running the command, because no later declaration may decide its boundary.
To continue, first make the `## Components` declaration valid and hold the slice's component, then set the slice back to `not-started` and start it again, which records the current content with that declaration.

The start and passed refs are snapshots of the project, not of its commits.
They hold every file that Git does not ignore, uncommitted changes and untracked files included, apart from Prism's records, plans, and roadmap.
They stay until the slice is set back to `not-started`, so a done slice keeps them, and removing an initiative's records with `remove_records` leaves them in place.
A checkout that is moved or removed leaves its refs behind, because Prism deletes only the refs named by a checkout's current path.
Prism never pushes these refs, and a plain clone or fetch does not carry them.
A mirror push such as `git push --mirror`, a push of every ref such as a `refs/*` refspec, a mirror clone such as `git clone --mirror`, and a bundle of every ref such as `git bundle create <file> --all` do carry them, with any uncommitted file they hold.

To list every slice's refs in the repository, and the segment that names the current checkout, run these in the project root:

```bash
git for-each-ref refs/prism/
printf %s "$(pwd -P)" | shasum -a 256 | cut -c 1-16
```

To delete one ref of a slice, or every ref of an initiative in every checkout of the repository, run:

```bash
git update-ref -d refs/prism/<initiative>/<slice>/<checkout>/start
git for-each-ref --format='delete %(refname)' refs/prism/<initiative>/ | git update-ref --stdin
```

`git gc` then removes the snapshots once nothing else holds them.
A started slice whose start content Git has removed fails its next run with `start_content_missing`.
A done slice's refs are still needed while another slice of its initiative is started and not done, because Prism leaves the done slice's verified changes out of that slice's boundary check only while Git can read the done slice's start content and its latest passing run.
Deleting a done slice's start or passed ref before then can therefore make that other slice fail with reason `component_boundary` for the done slice's changes.
That other slice can be in another checkout, because checkouts that share a `Store` share records, while only the refs of the checkout that ran the done slice keep its content.
Delete an initiative's refs only after the initiative is shipped or superseded and `remove_records` has removed its records in every checkout that shares this Git repository, because until then any slice of it may still read them, a deferred slice included.
Delete a single slice's refs only when you will set that slice back to `not-started`.
A removed checkout's refs are harmless to keep, so leave them until you can delete their initiative's refs.
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

Reading an initiative never reads the declaration, so an invalid one stops only design acceptance, the verification of slices that record a component, [dependents' runs](#dependents), and shipping.

`get_roadmap` returns the repository's components without refusing an invalid declaration.
Its `components` holds the repository's name in `repository`, and in `declared` the root component and then each declared component in declaration order, each as `{ component, folder, testCommand, dependsOn }` with identities, where the root component's folder is `""` and a missing test command is `null`.
For an invalid declaration, `declared` is empty and `problem` holds the refusal's `code` and `message`.

### Component proposal

When `.prism/workflow.md` lists no component under `## Components`, `get_roadmap` proposes a `## Components` block from the workspace manifests at the project root, in `components.proposal`.
Prism never writes the proposal to any file; `setup` shows it to you and adds it only when you approve it, and design reports it as an open question.
The proposal reads these workspace patterns:

| Manifest | Patterns |
|---|---|
| `package.json` | `workspaces`, as a list or as the `packages` of an object |
| `pnpm-workspace.yaml` | `packages` |
| `Cargo.toml` | `members` and `exclude` of `[workspace]` |
| `go.work` | each `use` directive |

In a pattern, `*` matches within one folder name and `**` matches any number of folders, and a pattern that starts with `!` or is listed in `exclude` removes the folders it matches.
Every matched folder that holds a `package.json`, `Cargo.toml`, `go.mod`, or `Package.swift` becomes one proposed component, except a folder inside `node_modules` or inside a folder whose name starts with `.`.
A component is named after its `package.json` `name` after the last `/`, else its Cargo `[package]` `name`, else the last segment of its Go module, else its folder's last segment.
The name is lowercased, each run of other characters than letters, digits, `_`, and `-` becomes `-`, and it is trimmed of leading and trailing `-` and `_` and cut to 64 characters.
A name that ends up empty, equal to the root component's name, or already taken by an earlier folder uses the folder's last segment the same way, and then `-2`, `-3`, and so on.
A component whose `package.json` has a `test` script tests with `<manager> run test`, where the manager is `bun` when the root holds `bun.lock` or `bun.lockb`, `pnpm` for `pnpm-lock.yaml` or `pnpm-workspace.yaml`, `yarn` for `yarn.lock`, and `npm` otherwise.
A component depends, in name order, on every other proposed component that its `package.json` dependencies name, that a `path` dependency of its Cargo `[dependencies]` or `[dev-dependencies]` leads to, or whose Go module its `go.mod` requires; a package name or module that several folders share names the first of them in folder order.
The shared paths are the root lockfiles of the workspace tools whose manifests gave patterns: the package manager's own lockfile for `package.json` or `pnpm-workspace.yaml`, `Cargo.lock` for Cargo, and `go.work.sum` for Go.

The proposal holds `markdown`, the block ready to commit, its `components` in folder order as `{ name, folder, testCommand, dependsOn }`, `sharedPaths`, and `skipped`, each manifest Prism could not read as `{ path, reason }`.
A member folder with a manifest Prism could not read is still proposed under its folder name, without a test command or dependencies.
When the proposed block would be refused, for example because its dependencies form a cycle, `problem` holds the refusal's `code` and `message`, and you change the block before you commit it.

## Dependents

Each slice runs only its own component's tests, so once every leaf of a contract scope is done, the orchestrator runs the scope's dependents' run with `verify_slice` and `dependents` `true`, naming the scope.
A scope is the slice whose design accepted the slice plan, or a leaf that is a scope of its own, such as a root that design gave no slice plan or a part of a split.
Prism refuses a slice that is not a scope with `validation_failed`, and a scope with a leaf that is not done with `scope_unfinished`, listing the leaves it waits for in `waiting`.

The dependents are every component of this repository that depends, directly or through other components, on a component that one of the scope's leaves records, a component of the scope included when it depends on another one of them.
A scope inside one component runs them too, while a leaf without a component, a leaf whose component the declaration no longer holds, and a change under a shared path add none, for the run and for `ship` alike.
When nothing depends on the scope, the result is `no_dependents` with an empty `components`, and nothing is recorded.
A dependency on another repository's component never runs there: Prism reads no other repository's configuration, and the result does not mention it.

Each dependent runs its own `Test command` in its folder, or the `Test command` under `## Stack` in the project root when it declares none, and each distinct command and folder runs once.
The commands run in dependency order, each in the place of the first dependent that uses it.
Before anything is asked, Prism refuses as for a slice's [verification](#verification), naming the first dependent in that order that has no command, a missing folder, or a folder that leads outside the project.

One approval question lists every command and folder that you have not allowed yet, with the components each one tests, and the result is `approval_needed` with `commands`, each `{ command, folder, components }`.
In a cloud session the chat question names the same commands and folders, because Prism asks a new question instead of reusing one that still asks about a command or folder this run does not need.
Allowing it allows each listed command in its folder, as a slice's approval does, so later runs ask only about new commands or folders.
Declining it marks the components of every listed command `declined` for this run, while the commands you allowed earlier still run, and the next run asks again.
An answer with only a note returns `approval_unclear` and runs nothing.
The dependents' runs of one work tree run one at a time, and a call while a scope's run is still going returns that run instead of asking again.
A repeated call with the gate of a finished run that declined commands returns that run too, and its result says to call `verify_slice` with `dependents` and without `approvalGate`, which asks again.
A call with the gate of a finished run whose commands were all allowed runs the dependents again, and any call with another gate or none forgets the declined run, so a later call with its gate asks or runs instead of returning it.

The run is recorded on the scope, and its result has `status` `passed` when every dependent passed and `failed` otherwise, with `components` in run order as `{ name, folder, command, status }`, `blocked` naming each dependent that failed or was declined, and `run`, the record of the run.
A run whose commands change project files fails with reason `tracked_files_changed` and blocks every dependent.
`get_initiative` returns `dependents` keyed by scope with the latest run's `status`, `passed` or `blocked`, `run`, `finishedAt`, and `blocked`.

`update_roadmap` refuses to `ship` the initiative with `dependents_blocked` while a scope has dependents, by the current declaration, whose latest dependents' run did not pass or did not run each of them.
Its `scopes` lists each such scope as `{ scope, blocked, reason }`, where `reason` is `failed` when that run failed or declined one of them and `not_run` when none ran or a dependent was declared after it.
A later passing run of those dependents lets it ship, and an initiative of a repository that declares no components ships as before.
A leaf that is not done still refuses `ship` with `gate_blocked` first, and an invalid declaration refuses it with its own code.
`get_roadmap` reports such an initiative with `readyToShip` `false` and a `diagnostics` entry, `dependents_blocked` with the same `scopes`, or the code and message of the invalid declaration, so the review browser shows an initiative as ready to ship only once `ship` would succeed.

## Questions and answers

Each question that waits on you is recorded, and the review browser's Attention page lists it with the artifacts to inspect.
You can answer there instead of in the conversation.
See [Review browser](review-browser.md#attention) for how the agent receives the answer.

## Autonomy

`orchestrate` stores decision autonomy per initiative.
Autonomy is `conservative`, `broad`, or `full`.
Conservative autonomy waits for you at every design gate, broad autonomy accepts a design unless it changes requirements, adds an ADR, or reports an open question, and full autonomy accepts every design.
The orchestrator runs triage, ideation, design, each implementation step, and review in fresh child agents, and never in its own context.
In Claude Code, a Prism hook refuses the orchestrating session's own load of those skills and tells it to start a child agent instead.
When no child agent can start, the orchestrator stops and asks you to run it where child agents are available.
An `agentFlow` setting stored by an earlier Prism is dropped when the initiative's coordination state is next read.
Full autonomy turns commits on when you have not set them, while explicit commit, continuation, and push settings always apply.

## Changes you make in the review app

The agent that coordinates an initiative learns of each change you make to its settings or gates in the review app on its next Prism call for that initiative, once per session, with your name, email, and checkout.
That agent is the one that last claimed a scope or started a slice of the initiative in the session, or the session's main agent until one has.
The child agents it starts are not told of the change and keep the settings they started with, and the next child session starts with your value.
The coordinating agent stops waiting on your answer to a question when you change the initiative, and acts on the change at the point its effect names, such as the next child session for a push or commit change.
On Claude Code, Prism tells a child agent's calls apart through its own hook before each Prism tool call; with hooks turned off, every call counts as the main agent's.
A change you make on another machine reaches the agent once the record store syncs it to this machine.
An agent keeps every setting you set: when it tries to write another value, your value stays, and the agent is told which settings it kept.
The review setting decides review marks when a design is accepted: `all` marks every slice for review, `recommended` adds the slices that design recommends, and a design accepted earlier keeps its mark when you change the setting later.

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
- Repository: api
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
A checkout that names a store but no repository is refused on every record operation with `repository_name_missing`, whose message shows the `- Repository: <name>` line to add under `## Workspace`, and Prism writes nothing to the store until the line is committed.
A checkout that names no store needs no `Repository` line.

To sync a path store between machines yourself, make it a Git checkout whose branch has an upstream, and add `- Store sync: on` under `Store`.
Prism then commits record changes a few seconds after each write, merges the upstream without rebasing, and pushes, and a record read fetches in the background when the last fetch is older than 30 seconds.
When two machines change different initiatives or slices of one record, the changes merge.
When they change the same initiative or slice, the first push wins, and the store saves the other version under `.prism-sync/conflicts/`.
Records keep working locally when Git, the network, or the upstream is unavailable, and the review browser shows a small chip when the last sync did not succeed.
Without `Store sync: on`, Prism never runs Git in a path store.
See [Share Prism state across worktrees and machines](shared-records.md) for setup, conflicts, sync status, and cloud sessions.

## Set up a project

`prism:setup` writes `.prism/workflow.md` by asking you one topic at a time, with what it found in the project filled in and a recommended answer, so you mostly confirm.
It covers whether the project is new or existing, the stack and test command, a shared store with this repository's name and the workspace name, components, the tracker and commit conventions, how questions reach you, and project constraints.
In Claude Code the questions use the structured question prompt; elsewhere they are numbered options in the message.

Setup stays the owner of `.prism/workflow.md` after the first run.
Run it again, or the agent runs it for you, when you add a test, lint, or BDD tool, when a project with no tests gets its first test runner, when you bring in another repository, or when Prism reports a setting or record from an earlier version.
During an orchestrated run, the orchestrator runs setup between slices in a child agent and asks you its questions on Attention.
Setup never adds a component declaration, store, or repository name that you did not approve.

## Offer at the start of a conversation

When you start a new conversation, or clear one, Prism tells the agent it is available.
If your first request asks for code that adds or changes behavior your requirements, ADRs, or feature files describe, the agent asks once whether to run it through Prism, and on yes it starts `prism:orchestrate` with your request.
In a project without `.prism/workflow.md`, it offers `prism:setup` instead.
It does not ask about a question on the code, a change that no requirement or ADR covers, such as a color or a typo, or a request that already names a Prism skill.
When questions already wait on you in an initiative, it offers to resume that initiative.
A resumed conversation and a child agent get no offer.
Set `- Session offer: off` under `## Interaction` in `.prism/workflow.md`, or the environment variable `PRISM_SESSION_OFFER=off`, to turn the offer off.
In Codex the offer needs Prism's hooks to be trusted through `/hooks`, like gate answers and run totals.

## Migrate an older setup

Prism no longer reads `.claude/workflow-config.md`, and `prism:setup` migrates its values into `.prism/workflow.md` without changing the old file.
On resume, orchestration imports a legacy `map.puml` into the initiative record.
`prism:setup` proposes a roadmap record from a legacy roadmap and replaces the hand-written roadmap Markdown only after you accept it.
See [Upgrading to managed records](upgrading-to-managed-records.md) for everything that changed in Prism 0.10.0.
