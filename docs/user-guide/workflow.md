# Workflow

Prism delivers an initiative as a tree of slices.
Each slice is designed when it is next, implemented in fresh agent sessions against frozen acceptance tests, and verified by running your tests.

## Stages

| Stage | Skill | Result |
|---|---|---|
| Shape | `prism:ideate` | Approved EARS requirement files and a roadmap entry, or a decision to stop |
| Triage a bug | `prism:triage` | A reproduction and the Approved requirements it breaks, with a defect on the done slice of an unshipped initiative or a roadmap entry, or a hand-off to ideate |
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
In a project with a record store, slice folders, requirements, ADRs, the glossary, and the roadmap view live in the store, as [Requirements, ADRs, and plans in the store](shared-records.md#requirements-adrs-and-plans-in-the-store) describes.
A short resume note records settings, active work, pending questions, next actions, and evidence paths, so an interrupted initiative resumes where it stopped.

Requirements preserve intent, ADRs preserve decisions, and feature files preserve acceptance examples.
Tests and consumed contracts enforce behavior, and code supplies implementation details.

## Artifact formats

Requirement files, ADRs, the glossary, and feature files each have one format with a version, a list of rules, and a complete example that conforms to it.
Each format's reference sits beside the skill that writes the artifact:

| Artifact | Reference | What it requires |
|---|---|---|
| Requirement file | `skills/write-requirements/references/requirement-format.md` | A `# <capability>` title, `Status:`, `Created:`, and `Approved:` lines, the Problem, Goals, Non-goals, and Design questions sections, and numbered sections with anchors and the Pattern, Disposition, Requirement, Rationale, and Related fields, with at most one `Supersedes:` line anywhere after Disposition, and at most one sentence that says `shall` in each `Requirement:` line, so each numbered section states one requirement, where a period after an abbreviation such as `e.g.` or inside a code span ends no sentence |
| ADR | `skills/write-adr/references/adr-format.md` | A `# <decision>` title, `Status:` and `Created:` lines, and the eight sections from Requirements to Decision Log, where only the Decision Log may be empty and every link in Requirements is a relative `.md` link, written as one link to a requirement section per list item |
| Glossary | `skills/workflow/references/glossary-format.md` | A `# <name>` title and a purpose paragraph, then terms, each a `## <term>` heading after an `<a id="<id>"></a>` anchor, a definition whose first sentence stands on its own, and a `Source:` line that links the Approved requirement section or Accepted ADR that introduced it |
| Feature file | `skills/write-feature/references/feature-format.md` | A `Feature:` line, and Rules that each link a requirement and hold examples with Given, one When, and Then steps |

Any required value or section body may be the single word `unknown` when nobody knows it yet, except a title, a status, or an identity.
Only an undecided artifact may leave a value unknown: a requirement file while its status is Draft and an ADR while its status is Proposed, read as the status Prism recorded in a project with a record store.
An `unknown` value in any other artifact, such as an Approved requirement file, an Accepted ADR, a glossary, or a feature file, breaks the format's `unknown` rule, such as `requirements.unknown`.
A glossary term whose sources are a Draft requirement, a Proposed or Declined ADR, or a missing file is reported, and so is a term whose every source was withdrawn or superseded.
So agents add a term to the glossary once its source is decided: when a person approves the requirement file or amendment that introduces it, and when an ADR that introduces it is accepted.

Agents check artifacts with the `check_artifacts` tool.
Without paths it checks every `.md` file other than `README.md` up to four folders below the configured Requirements and ADRs paths, every `.feature` file up to four folders below the Feature files path, and the configured Glossary file.
A path set to `n/a` in `.prism/workflow.md` is not checked.
For each artifact it reports whether it conforms, each broken rule by its id, such as `requirements.fields`, with its line and a message, and each value written as `unknown`.
It also lists each finding that an agent reported for the artifact's current version, with the rule `<type>.reported`, such as `requirements.reported`, so the artifact does not conform until its content changes.
A path that lies under none of the configured paths is refused with `artifact_type_unknown`, and a path that does not exist with `artifact_missing`.

In a project whose `.prism/workflow.md` names a record store, requirement files, ADRs, and glossaries live in the store, and `check_artifacts` reads them from every scope the checkout sees: the workspace, its repository, and that repository's components.
Feature files stay in the checkout and are read there.
Each result names its artifact by path and scope, where the scope is the one `get_artifact` returns, or `null` for a checkout file, and a path that several scopes hold is listed once for each scope.
To check one copy, pass a paths entry as `{ "path": "docs/Glossary.md", "scope": "workspace" }`, with `scope` set to `workspace`, `repository`, or `component` together with `component`.
A path that two scopes hold is refused with `artifact_ambiguous`, listing their scopes, until you name one, and a scope on a feature file, or in a project without a store, is refused with `scope_invalid`.
When the store cannot be used, the check is refused with the store's own refusal, such as `store_unavailable`, and never falls back to copies in the checkout.
A glossary source counts by the status Prism recorded for the requirement or ADR, so a `Status:` line that differs from it is no finding.
Each glossary resolves its sources in its own scope first, then in its repository's scope for a component, then in the workspace, so a glossary has the same findings in every checkout that sees it, and a source that only another scope holds is reported as outside the glossary's scope.
Each scope's glossary is checked on its own, so one term id in two glossaries is no finding.

### Writes that break a format

In a project with a record store, Prism checks every write it makes to a requirement file, ADR, or glossary against the current format, as `check_artifacts` would check the content it leaves.
This covers an agent's `update_artifact` write or edit, a person's approval in the review browser, which rewrites the file's `Status:` and `Approved:` lines, and a ship that sets ADRs Accepted.
A format migration run checks each target it would write, in the store and in the checkout, as a write is checked, with the run's own glossary sources counted as decided.
A write whose content breaks the format is refused with `artifact_nonconforming`, which names each artifact, its scope, and its broken rule ids, and the refused update, approval, or ship changes nothing.
A new requirement file is recorded as Draft whatever its `Status:` line says, so it may hold `unknown` values, while approving a file that still holds one is refused and its question stays open.
Removing a file, moving it to another scope, and the move of a checkout's files into the store keep the bytes as they are and are not checked, so a moved file that breaks its format shows its findings in its new scope.
Plan files, diagrams, the roadmap view, and files an agent writes in the checkout without Prism are not checked by a write.

### Reported findings

An agent that finds a break of a format that `check_artifacts` does not see reports it with the `report_format_finding` tool, giving the artifact, a plain-text message of at most 500 characters on one line, and optionally the line it is on.
Prism records the finding against the artifact's current version and never changes the artifact, and a second report of the same version, line, and message returns the first finding.
`check_artifacts` and Attention list the finding until the artifact's content changes, and the review browser shows its message as plain text.
Reported findings live under `format-findings/` in the record store, whose sync shares them with every checkout, or under `.prism/format-findings/` in a project without a store.

### Work that cites a nonconforming artifact

Prism refuses new work that builds on an artifact that breaks its format, because a contract or plan that cites it would rest on rules nobody can check.
The refusal is `artifact_nonconforming`, and it applies to these requests:

- Creating or splitting an initiative, reporting a defect, or adding a fix with `update_initiative`, for each requirement file the request references.
- Proposing or accepting a design, for each requirement file, ADR, glossary, or feature file that a Markdown link in the scope's or a planned slice's `slice.md` points to, and for each frozen test that is a `.feature` file.
- Adding a roadmap entry with `update_roadmap`, for each requirement file the entry references, and updating one, for each requirement file the update adds to the entry's references.

Prism checks what a request cites before anything else except its arguments, and a refused request changes nothing.
The refusal lists each artifact with its path, its scope, its type, its findings, and `migration`, the state of its format migration run as `check_artifacts` reports it, or null.
Its message names each artifact with its broken rule ids, followed by one sentence on the state of its migration:

| State of the migration | Sentence |
| --- | --- |
| `starting`, `running`, or `continuing` | `Prism is migrating it into its format in the run <run id>.` |
| `asking` | `Its format migration <run id> waits for your answers on Attention.` |
| `waiting-for-host` | `Its format migration <run id> waits for an available host.` |
| `failed` | `Its format migration <run id> failed: <reason> Run it again from Attention.` |
| No run, for a feature file | `Prism does not migrate feature files, so bring it into its format in a change of its own.` |
| No run otherwise | `Prism has not started its format migration yet.` |

The refusal never asks for or offers a migration, since Prism starts the run of a nonconforming requirement file, ADR, or glossary by itself when it checks what the request cites.
Only a file that `check_artifacts` lists as an artifact is cited, so a link to a `README.md`, a diagram, or a file more than four folders below its configured folder refuses nothing.
A value written as `unknown` refuses work that cites a requirement file that is not a Draft or an ADR that is not Proposed, like any other `<type>.unknown` finding, while an `unknown` value in a Draft requirement file or a Proposed ADR refuses nothing.
A cited file that does not exist refuses nothing, and records that already cite a nonconforming artifact still load.

To go on, send the refused request again once the artifact's migration is applied, answer the run's question on Attention when it asks, or bring a feature file into its format in a change of its own.
With a record store, a requirement reference cites every copy that a scope the checkout sees holds at its path, and a link in a `slice.md` cites the copy in that `slice.md`'s scope, else the only copy a seen scope holds, else every copy.
The message then names a store artifact as `<path> in scope <label>`, followed by the state of that copy's migration.

### Format migrations

A format migration converts one artifact that breaks its format into its format.
It is not the move of a checkout's files into a record store.
Prism migrates requirement files, ADRs, and glossaries by itself, in format migration runs, and never migrates a feature file.

Whenever Prism checks a project's artifacts, through `check_artifacts`, Attention, `report_format_finding`, or the check of work that cites an artifact, it starts one run for each new set apart from that check.
A set is the requirement files, ADRs, or glossaries of one type in one scope that break the current version of their format and that no earlier run holds at their current version.
Checking again starts no second run of a set, while an artifact that changes is held by no run at its new version, so the next check starts a run for it.
`check_artifacts` lists, for each artifact, `migration`: the run that holds it at its current version, with its status and its failure or waiting reason, or null.
A run's status is `starting`, `running`, `waiting-for-host`, `asking`, `continuing`, `applied`, or `failed`, and only `applied` and `failed` end it.
A run's `cause` is `format-update` when every artifact of its set conforms to an earlier version of its format, and `findings` otherwise.
Read a run with `get_migration_run`, which lists its set with each artifact's current findings, its format migrations, its question, the person's answers, its result, and its failure.
A run is never a roadmap entry, an initiative, a slice, a claim, or a gate.

Prism launches each new run's session on this computer at once, without asking, as a [launched session](review-browser.md#launched-sessions) of the checkout whose check found the set.
The host and model are the ones that **Prism's own runs** in the review app's [Settings](review-browser.md#layout) chose for this computer.
A host is available when its executable, `claude` or `codex`, is on the `PATH` of the Prism server that started the run.
Without that choice, or with **Any available host**, the run starts with Codex and its `gpt-6-luna` model when Codex is available and lists that model, even when Claude Code is available too.
Prism reads Codex's models for that as the review app reads them, in a Codex app server of its own that starts no session, and a read that fails or takes too long counts as a list without `gpt-6-luna`.
Otherwise the run starts on the first available of Claude Code and Codex with a small model: Claude Code with `haiku`, and Codex with the first model it lists whose name ends in `-luna` or `-mini`, or with its own default model when it lists none.
When the chosen host is not found or the choice cannot be read, the run starts on the first available of Claude Code and Codex with that host's own default model, and says why.
The session's only prompt is `/prism:migrate-artifact <run id>` for Claude Code, or `$prism:migrate-artifact <run id>` for Codex, so no artifact text reaches its command line or prompt.
Once the host started, the run is `running` and `get_migration_run` names the session as `launch` with its id and host, and no second session of the run starts while it runs.
When no host is available, the run waits as `waiting-for-host` with the reason `No host is available on this machine:` and each host's reason, and the next check of the project on a computer where a host is available launches it.
When a run's session ends, by its exit, a host error, or a stop, while the run is still `starting`, `running`, or `continuing`, the run fails with `The run's session ended before the run finished:` and the session's last reason, and applies nothing.
A session that ends after its run asked its question leaves the run `asking`.
Once you answer a run's question, the run is `continuing`: Prism resumes its session with the same prompt, or launches a new one on an available host when it cannot be resumed, and the run waits as `waiting-for-host` when none is available.
Your answer and the move to `continuing` are one write, so a continuation that cannot start fails the run with `The run could not continue after the answer:` and why, and you can run it again, while your answers stay recorded.
Running a failed run again from its page in the review browser starts a new run with the cause `rerun` that holds the artifacts of the failed run's set that still break their format, and a run that is not failed, or that a later run of its set follows, cannot run again.
An artifact has at most one open run: when it changes into a newer version that still breaks its format, its open run fails with a reason that names it, Prism stops that run's session on this computer, and a new run migrates the new version.
A run whose session's supervision was lost, or whose session ended without reporting it, fails with that reason at the next check on the computer that ran it, and a run that never launched its session within 5 minutes fails with `The run's session never started:` and why.
A run's session reads only, because it reads artifact text that others wrote.
It works in an empty folder of its own outside the checkout and reads no file of the checkout, so it cannot copy a file such as `.env` or `.git/config` into the record store.
It takes the target format's reference from the run, as the Prism that checks its proposals holds it, so it reads the same format wherever its host keeps the plugin.
Claude Code gets no built-in tool, so it reads no file, and only Prism's scoped server, with no other MCP server or claude.ai connector, and runs no shell command, and Codex runs in its read-only sandbox, readable beside its own folder only in Prism's own folder and Codex's plugin cache, and never asks to run a command outside it.
Of Prism's tools, the session can call only the run's own: reading the run, with the project's configured paths and each source's Git history, reading the run's artifacts and other files of their type under the same configured path, never a dot-file or a dot-folder, in the record store or the checkout, proposing the run's format migrations, and finishing or failing the run.
Prism refuses every other tool, such as changing an artifact, the roadmap, an initiative, or a review, to that session, so nothing written into an artifact can make the session change them.
No Prism tool that an agent calls starts, continues, or runs again a run's session.

The session of a run follows the `migrate-artifact` skill and proposes one format migration for each artifact of the set with `propose_migration`, passing the run, the type, the source and the target, the whole migrated content, a summary of what changes and why, and leftovers: each statement of the source that the content does not keep, with a proposed home such as the project instructions.
The target lies under the type's configured path, and equals the source for a format migration in place, and a source that is no artifact of the run's set is refused with `invalid_input`.
A checkout source or target whose path passes through a symbolic link is refused with `artifact_outside`, and one that is no regular file with `invalid_path`, when it is proposed and again when the run applies, so a format migration never touches a file outside the project.
Prism splits the source into statements, each sentence of a paragraph, list item, blockquote line, or table cell and each fenced code block, and refuses a proposal with `migration_unaccounted` when a statement appears in neither the content, a leftover, nor a conflict.
It refuses with `migration_invented` a statement of the content that is no statement of the source or the target, compared whole, so a sentence cut short counts as invented, while the format's structure, its default values, `unknown`, links, the pattern of a section split out of a requirement section, and dates from the source's Git history count as no statements.
It refuses with `migration_misplaced` a statement that the content moves to a section that does not correspond to the one it came from, as the format reference's corresponding sections list them.
A requirement file's numbered section that holds several requirements is split, not merged: the section keeps its first requirement, number, and anchor, and each further requirement becomes a new numbered section at the end of the file under the section's title, with its own pattern, the section's rationale, and a Related link back to the section.
A statement may land in such a new section, whose number the source does not use, only while the content keeps the section it came from under its number and title, beginning with its first requirement, so a split that moves that first requirement, renumbers a section, or lands under another section's title is refused with `migration_misplaced`.
A value that neither the source nor its Git history gives is written as `unknown`, and content that breaks its format other than through `unknown` values is refused with `artifact_nonconforming`.
A status or a Created, Approved, or Accepted date counts only when it is the type's new status, the source or the target states it in that same field, or the date comes from the source's Git history.
When the source or the target is Approved or Accepted, content that changes its status, its Created or Approved date, or drops an identity, such as a requirement section number or a glossary term id, is refused with `migration_changes_decision`.
A target that already exists keeps each of its entries, a requirement section, a glossary term, or a feature Rule, unchanged: the source's differing version of an entry goes under `conflicts`, and content that changes a target entry is refused with `migration_conflict`.
A target that another open run's proposal holds, or that another source's proposal in the same run writes, is refused with `migration_pending`, and a new proposal of a source replaces the run's earlier proposal of it.
Within one run a file is never both migrated into and migrated away: a target that another proposal moves elsewhere and removes, or a separate source that another proposal writes into, is refused with `migration_pending`, so no chain of moves can leave a statement in no file.

Each proposal lists its points: each leftover, each source entry that the target holds with other text, and Prism's own points, one for each `unknown` value of the content, one for each conflict, and one for removing a separate source.
The proposal settles a leftover or such an entry under `settled`, with the reason it loses nothing, or asks the person under `asked`, with its recommendation, and Prism's own points are always asked.
A point that is neither settled nor asked refuses the proposal with `migration_unsettled`, which lists the points, after every other check.
An `unknown` point says whether the target may keep the value unknown, which only a Draft requirement file or a Proposed ADR may.

Once every artifact of the set has a proposal, the session calls `finish_migration_run`.
When nothing was asked, Prism applies the run without a person.
Otherwise it asks the person once, with every asked point of the run and each recommendation, and the run waits as `asking` until you answer it on the run's page in the review browser, as [Format migration runs](review-browser.md#format-migration-runs) describes.
A run that asked once and still holds an unanswered point when it finishes again fails with `The run asked again after the person answered.`
A run that cannot migrate its set is failed with `fail_migration_run` and a reason.

A run applies all its format migrations or none.
It writes each migration's content with the person's chosen values and entries and with the migration's id after each glossary `Source: migration`, so the term's source is the run's format migration, and removes a separate source, since the answer gives every leftover a home before the source goes.
A source or target that changed since its proposal, a target that the write check refuses, or a target that cannot be written fails the run with that reason and changes nothing, so a failed run applies nothing, and a checkout file the run wrote before a later step failed is put back.
The write check of a run is strict: `unknown` stays only in a target that will be a Draft requirement file or a Proposed ADR.
A run's record that changed after its proposals were checked, or whose paths leave the project, is refused with `record_invalid` or `invalid_input` and applies nothing.
A checkout file that a run writes or removes is left uncommitted in the working tree, for you to commit.
Applying drops the reported findings of each artifact the run wrote.

In a project whose `.prism/workflow.md` names a record store, a requirement, ADR, or glossary target is a store artifact, and a source under a store artifact path is one too, while feature files and every other file stay in the checkout.
A store target's `Status:` line must equal the status Prism recorded for it, or for a new one the recorded status of a store source of the same type, else `Draft` for a requirement and `Proposed` for an ADR.
A run writes every store target and removes every store source it removes in one checked store update, so their comments, recorded statuses, and identities stay as `update_artifact` keeps them.
An Approved or Accepted store artifact keeps its status, and its migrated bytes become its accepted version, which `get_artifact` attributes to the run as `acceptedFrom`.
In a store that is a Git checkout, the run's store change is a commit of its own, `prism: format migration <run id>`, made without a person after the store's earlier changes; with store sync on, the sync pushes it.
With store sync on, a new run is confirmed with the store's remote, so a run of the same set that another machine recorded first is the one that stands, and an unreachable remote starts no run until the next check.
Prism keeps each run under `format-migrations/`, in the store when one is configured, where its sync shares it, and under `.prism/format-migrations/` otherwise, where it stays on this machine and Git ignores it.

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
Delete an initiative's refs only after the initiative is shipped, or after it is superseded and `remove_records` has removed its records in every checkout that shares this Git repository, because until then any slice of it may still run and read them, a deferred slice included.
Delete a single slice's refs only when you will set that slice back to `not-started`.
A removed checkout's refs are harmless to keep, so leave them until you can delete their initiative's refs.
A passing run counts only while the project's source, tests, and configuration stay as they were when it ran, so a later edit needs a new run.
When the design requires review, an independent reviewer also reviews the verified result, and a later change needs a new run and a new review.
A finding that a contract clause itself causes sends the slice back to design instead of into another fix.
After two review waves for one accepted design, Prism asks you the review loop decision before each further wave, and the agent waits for your answer instead of asking its own question.
The question shows the unresolved findings by severity, a table of the findings each wave raised and closed, and the files that findings named in more than one wave.
It offers these options:

- **Continue the review**: the implementer fixes the open findings, and one more review wave runs with fresh reviewers.
- **Return the slice to design**: the slice is blocked, and design revises its contract with every unresolved finding as a contract defect.
- **Accept with deferred low findings**: offered only while every unresolved finding is low severity; the review wave is accepted, and each low finding stays on record as deferred with a follow-up.

Prism recommends accepting with deferred low findings whenever it offers that option.
Otherwise it recommends returning the slice to design when the latest wave raised at least as many findings above low severity as the wave before it, and continuing the review when it raised fewer.
When you accept with deferred low findings, the agent files one follow-up per finding in the tracker that `## Tracker` in `.prism/workflow.md` names, or adds it to the roadmap's open questions when no tracker is named.
A deferred finding has status `DEFERRED`, keeps the decision and its follow-up reference, counts as resolved, and no longer changes; `get_review` lists the deferred findings, and the slice page shows them apart from the unresolved ones.
The slice page in the review browser shows the latest run with its command and exit code, and a failed run also names the failing tests that Prism found anywhere in the output.
Each run writes its whole output to a log in Prism's plugin data on the machine that ran it, and the run record keeps the last 4,000 characters of the output and names where that log is, with the home folder written as `~`.
Verification runs need a git work tree, and `PRISM_VERIFY_TIMEOUT_MINUTES` changes the 30-minute default timeout.

Each run record names the slice's files by their Git blob hashes and never holds their bytes.
Its `files` lists `{ path, blob }`, sorted by path, for every path whose content differs between the slice's start content and the content the run tested, plus each frozen test, with `blob` null for a removed path.
`filesFrom` is `start-content`, or `frozen-tests` for a slice without start content that Git can read, which lists its frozen tests only.
A run lists at most 2000 files and sets `filesTruncated` to `true` when more changed, and a run that stops at changed frozen tests lists none.
The run's `checkout` names the repository, `origin` remote, branch, head commit, whether the work tree was dirty, and `host`, this machine's host name up to its first `.`.

When you `ship` an initiative, Prism first fetches `origin` in the shipping checkout, and goes on with what it has when the fetch fails.
The decision then records `slices` with `{ repository, verified, shipped }` for each done leaf slice that has a passing run: `verified` is the head commit of the slice's latest passing run, and `shipped` is the oldest of the 1000 newest commits on the first-parent history of the default branch, leaving out those the verified commit was built on, whose tree holds every file the run listed and none of its removed paths.
A file counts as held at the blob the run listed or at a later version that a commit descending from the verified commit gives it, so a squash merge of a branch whose later slices or fixes changed the file still records the squash commit.
Those later versions come from the refs of the shipping checkout, such as the slice's branch, so ship from a checkout that still has that branch, locally or on origin.
The default branch is `origin/HEAD`, else `origin/main`, else `origin/master`, so a squash merge or a force push that keeps the verified files still leads to them.
`shipped` is null when the run was in another repository, when the run listed no files, or when no commit qualifies, as when you ship before the slice's branch merges, and the `ship` result lists those slices under `noShipCommit`.
`get_roadmap` lists `initiatives` with each one's `id` and `decision`, so a shipped initiative's `slices` read without the whole record.
`get_roadmap` with `initiative` returns only that entry, its decision, and its derived state, without the other entries or the record's history, and refuses an id the roadmap does not hold with `unknown_initiative`.
`update_roadmap` answers with the new revision, `touched` with the ids its operations named, and only those entries, beside its ship results, so read the whole roadmap with `get_roadmap`.
`update_coordination_state` answers with the new revision, the opened gates, and the state without the person's history and setting marks and without each pending gate's context and artifacts, which `get_coordination_state` returns.

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
When that latest run started before a leaf of the scope last passed `verify_slice`, as after a fix slice changed the scope, `reason` is `stale` for every dependent and `run` names the stale run's record path, so run the dependents again.
A later passing run of those dependents lets it ship, and an initiative of a repository that declares no components ships as before.
A leaf that is not done still refuses `ship` with `gate_blocked` first, and an invalid declaration refuses it with its own code.
`get_roadmap` reports such an initiative with `readyToShip` `false` and a `diagnostics` entry, `dependents_blocked` with the same `scopes`, or the code and message of the invalid declaration, so the review browser shows an initiative as ready to ship only once no slice, declaration, or dependent stops it.

## Ship an initiative

When every slice of an initiative is done, the orchestrator ships it with the `ship` operation of `update_roadmap`, which records the decision on the roadmap.
`ship` refuses with `gate_blocked` while a slice is not done, and with `dependents_blocked` while [dependents](#dependents) block it.
In a project with a record store, a ship also needs your confirmation: the orchestrator asks you a correctness review of the finished initiative, and only Approve in the review browser confirms it, while an answer in the conversation does not.
The review confirms the initiative as you saw it, so the orchestrator asks it after the latest passing verification run of every slice and once the initiative's `slice.md` files and the ADRs they link no longer change.
When a slice passed verification again, a `slice.md` or such an ADR changed, or the repositories that a slice's links resolve in changed after the question was asked, `ship` refuses with `ship_unconfirmed`, naming what changed, and the orchestrator asks you again.
Asking you a new correctness review closes each earlier one you already answered, and the review browser shows it as closed with a reason that names the new one, so it no longer waits in Attention or stops the ship.
An earlier correctness review you have not answered stays open until the orchestrator withdraws it.
A ship then sets to `Accepted` each ADR whose recorded status is `Proposed` and that a Markdown link in a `slice.md` of the initiative names, and records with it the review you approved and the slice, repository, and commit of each slice's latest passing verification run.
A link counts only as Markdown reads it, so a path in a code span, a code block, an HTML comment, or after an escaped bracket names nothing.
A link in a slice's `slice.md` names an ADR of the workspace scope or of that slice's own repository and its components, whichever repository's checkout ships.
When two or more of those scopes hold an ADR at the linked path, the one in the scope of that `slice.md` counts, and when none of them is that scope, `ship` refuses with `adr_ambiguous`, naming the path and the scopes, and changes nothing.
While a linked Proposed ADR waits for your answer to an approval, `ship` refuses with `adr_pending`, naming each such ADR and its question, and changes nothing, so a ship never closes a question you have not answered.
A Proposed ADR that cites one of the initiative's requirement files in a Markdown link, and that no `slice.md` of the initiative links, would stay Proposed after the ship without you seeing it at the review.
So `ship` refuses with `adr_unlinked`, naming each such ADR and the requirement files it cites, and `get_roadmap` reports `readyToShip` `false` with an `adr_unlinked` diagnostic, until an agent links the ADR from the `slice.md` that relies on it and asks you a new correctness review.
An ADR that a `slice.md` of another plan links belongs to that initiative and does not stop this ship.
A `slice.md` that Prism cannot read for its links, because it holds more than 1 MiB or nests its Markdown deeper than Prism reads, refuses the ship with `artifact_too_large` until an agent shortens it.
The result lists the accepted ADRs under `acceptedAdrs` with their path, scope, and the verified commits, an ADR with another recorded status stays as it is, and `get_artifact` returns an accepted ADR's acceptance.
So a ready-to-ship initiative of a project with a record store still waits for your correctness review, and its ship can still be refused for the reasons above.
In a project without a record store, `ship` needs no review, and the orchestrator accepts the Proposed ADRs of each slice as it lands.

## Shipping

`update_roadmap` refuses to `ship` an initiative that already has a decision with `validation_failed`, and then refuses with `open_work` while any of its work is still open.
Open work is a pending question in the initiative's coordination state, answered or not, a slice with a live claim, or a pending design proposal.
An answered question counts because no agent can resolve it once the initiative is history.
The correctness review that a ship names in `afterGate` is the one exception, with or without a record store, and the ship closes it.
For `readyToShip`, a project with a record store takes the newest pending correctness review as the one the ship will name, so an older pending one is open work.
The refusal lists `gates` as `{ id, slice, question, answered }`, `claims` as `{ slice, label, activity, expiresAt }`, and `proposals` as scope names, and its message names each one.
This check runs before the leaf and [dependents](#dependents) checks, so `gate_blocked` and `dependents_blocked` come after it.
`get_roadmap` reports such an initiative with `readyToShip` `false` and an `open_work` diagnostic with the same `gates`, `claims`, and `proposals`.

A shipped initiative's roadmap entry keeps its title, intent, requirements, and required initiatives.
`update_initiative` and `set_requires` naming it refuse with `initiative_shipped`, with its `initiative` and its ship time in `shippedAt`, and change nothing.
`place` still refuses because a shipped initiative keeps its place in history, and another initiative may still require it.
A request that would change an initiative's state while the roadmap record exists but cannot be read or parsed is refused with `invalid_roadmap`, because Prism cannot tell whether the initiative shipped.
Start new work on a shipped initiative as a new initiative that references it.

### Shipped history

A shipped initiative's state is history: its contracts, slice documents, frozen tests, and reviews record finished work, and current intent lives only in Approved requirements, Accepted ADRs, the glossary, and feature files.
Ship writes this history mark into every slice document of the initiative, under its first-line title, or at the top of a document without one:

```markdown
> Shipped history: initiative `reports` shipped on 2026-11-03, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.
```

A document that already holds a mark is not marked again.
Ship also records each document's path and the SHA-256 of its content without the mark in the roadmap decision, as `documents`, with `documentsRecordedAt` and `documentsFrom` `ship`.
The `ship` result lists the marked paths under `historyMarks`, and a document it cannot read or write under `historyMarkProblems` as `{ path, reason }`, and ship still succeeds.
In a project without a record store, commit the marked documents.
In a project with one, the marked documents live in the record store, which shares them with every checkout, so there is nothing to commit.

An initiative that shipped before Prism recorded documents is handled at its first read: the first `get_initiative`, `get_coordination_state`, `get_review`, or `get_roadmap` that reaches it records its slice documents with `documentsFrom` `first-read` and marks each one.
That read lists the marked paths under `marked`, or under `markedHistory` for `get_roadmap`, and adds a text line that asks you to commit them in a commit of their own, apart from the task's changes, or, for documents in the record store, says that they are already shared and need no commit.
An initiative with no slice document in the checkout records nothing until a read finds one.

`get_initiative`, `get_coordination_state`, and `get_review` of a shipped initiative, also one without an initiative record, return `shippedHistory` with `initiative`, `shippedAt`, a `message` that says the state is history, `documents`, and `changedAfterShip`.
`get_coordination_state` also shows the message as a line of its text.
`documents` lists the recorded slice documents in path order.
`changedAfterShip` lists `{ path, change }` for each recorded document whose content differs, ignoring the mark, as `changed`, for each one that no longer exists as `removed`, and for a slice document in a folder that had none recorded as `added`.
A copy of a document without the mark, as on a branch from before the ship commit, is not a change.

A shipped initiative's records stay, and every request to change its state is refused with `initiative_shipped` before every check except argument validation and the check of what the request cites, naming the initiative and its ship time in `shippedAt`.
The refusal covers every `update_initiative` operation, `remove_records` included, as well as `update_coordination_state`, `checkpoint_pause`, `update_review`, `verify_slice` with `contractDefects` or `dependents` too, `update_design_view`, and `update_change_map`, and it changes no record and no project file.
Start new work on a shipped initiative as a new initiative that references it.
`remove_records` still removes the records of a superseded initiative.

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
Under full autonomy, a run also decides each undoable step by itself and does not ask you.
An undoable step is a band or park change of a roadmap entry, a removal or change of a Draft requirement or Proposed ADR in the record store, or a tracker issue that the run files.
A push, a ship, an approval, and a removal outside the record store are never undoable steps, and a commit follows the commit setting.
The run keeps each such choice as a closed decision question in the initiative's coordination state, with its options, the option it chose, and its reason.
The review browser shows that decision with the other closed questions, so you can read what the run chose and undo it.
Under conservative or broad autonomy, Prism refuses such a decision, and the run asks you instead.

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

`prism:triage` reproduces a reported defect, finds the Approved requirements it breaks, and routes the fix by where the broken work lies.
A defect in done work of an initiative that has not shipped joins that initiative: triage reports it on the done slice with `report_defect` and returns the initiative, the slice, and the defect id, and orchestration designs and runs the fix slice before the initiative ships.
A defect in a shipped initiative's work becomes a new initiative whose `corrects` names the shipped initiative and each slice whose work the fix corrects.
Any other defect becomes a new initiative with the broken requirements, and a report that no Approved requirement covers goes to `prism:ideate`.
Triage, design, implementation, and review sessions take current intent only from Approved requirements, Accepted ADRs, the glossary, and feature files, and cite a shipped initiative's contracts, slice documents, frozen tests, and reviews only as history.

A defect in a done slice of an initiative that has not shipped is fixed inside that initiative as new work.
Report it with `update_initiative` `report_defect` `{ slug, requirements, summary }` on the done slice, which records it as `d1`, `d2`, and so on, and refuses a slice that is not done with `validation_failed`.
The done slice stays done, and its status, accepted design, frozen tests, verification runs, and review are unchanged.
`set_status` refuses to set a done slice to another status with `slice_done`.
Design claims the done slice with `claim` and proposes one fix slice with `propose_design`: one `add_fix` `{ slug, defects, fix: { slug, title, outcome, requirements } }` naming the done slice, optional `set_dependencies` and `update_slice` on the fix slug, and one `accept_design` of the fix slug.
Prism refuses any other operation on a done scope, a defect the slice does not hold or that another fix slice already fixes, and a slug already in use, all with `validation_failed`.
Accepting the proposal adds the fix as a new `not-started` slice below the done slice, with `fixes: { slice, defects }`, and its `slice.md` sits in its own folder under the initiative's plans folder.
A fix slice is a leaf of the initiative: it counts toward progress, it cannot split, it starts only when the done slice's dependencies and those of its ancestors are done, and slices that depend on the done slice wait for it.
`get_initiative` lists each fix slice under the done slice in `derived.children` and in `derived.fixes`, and lists each defect whose fix is missing or not done under `derived.unfinishedFixes` as `{ slice, defect, fix, status }`.
While any is listed, `readyToShip` is `false`, `get_roadmap` reports a `fixes_unfinished` diagnostic, and ship refuses with `fixes_unfinished`, naming each one.

A fix to the work of a shipped initiative is a new initiative, because a shipped initiative's state is history.
Add it with `update_roadmap` `add_initiative`, or later with `update_initiative`, and give it `corrects: { initiative, slices }` with the shipped initiative and each of its slices whose work the fix corrects.
The roadmap Markdown shows it on the new entry as ``Corrects `reports`: `download`, `audit`.``
Prism refuses `corrects` with `validation_failed` for an initiative that has not shipped, an unknown initiative, the entry's own id, an empty `slices` list, and a slice that the shipped initiative's record does not hold, which is every slice when that record is missing.
Fix done work of an initiative that has not shipped inside that initiative instead, by reporting the defect on the done slice with `report_defect`, as described above.
Every read of the shipped initiative that carries `shippedHistory` lists the initiatives that correct it under `laterFixes`, each as `{ initiative, title, state, slices }` with its current lifecycle state, in roadmap order.

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

With a record store, the requirements, architecture decisions, slice designs, roadmap view, and glossary live in the store at these paths, while feature files and user documentation stay in the project.

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
The result of the tool call that made the move lists the moved records and the conflicts, and a move made on a review browser request is listed instead by the next Prism tool call from that checkout, in any agent session on the machine.
Record files that other checkouts still hold under `.prism` are then ignored, and you can delete them.
Every checkout whose configuration names the same store reads and writes the same records.

`Repository` names the repository to its store, so one store can hold the records of several repositories, and record operations ignore it without `Store`, where it only names the repository's [components](#components).
A name has 1 to 64 lowercase letters, digits, hyphens, or underscores, starts and ends with a letter or digit, and is no Windows device name, `con`, `prn`, `aux`, `nul`, `com0` to `com9`, or `lpt0` to `lpt9`, or every record operation fails with `repository_name_invalid`, whose message proposes a name the store accepts.
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
How questions reach you, the review browser, whether it opens at session start, and whether a new conversation offers Prism are your [personal settings](#personal-settings), so setup saves them for you on this machine and writes no `## Interaction` section into `.prism/workflow.md`.
In Claude Code the questions use the structured question prompt; elsewhere they are numbered options in the message.

Setup stays the owner of `.prism/workflow.md` after the first run.
Run it again, or the agent runs it for you, when you add a test, lint, or BDD tool, when a project with no tests gets its first test runner, when you bring in another repository, or when Prism reports a setting or record from an earlier version.
During an orchestrated run, the orchestrator runs setup between slices in a child agent and asks you its questions on Attention.
Setup never adds a component declaration, store, or repository name that you did not approve.

## Personal settings

Four settings belong to you rather than to a project, and apply to every project and to both Claude Code and Codex on this machine:

| Setting | Values | Default |
| --- | --- | --- |
| `interactionStyle` | `structured` asks with the host's question prompt, and `plain-text` with numbered options in the message | `structured` |
| `reviewBrowser` | `auto`, `internal`, or `external`, as [Review browser](review-browser.md) explains | `auto` |
| `reviewBrowserOnStart` | `on` opens the review browser when a session starts, and `off` does not | `on` |
| `sessionOffer` | `ask` offers Prism at the start of a new conversation, and `off` does not | `ask` |

Prism keeps them in its application folder, beside the machine's checkout list, as [Share Prism state across worktrees and machines](shared-records.md) describes, and never in a project, a repository's configuration, or a record store, so a change reaches no one else.
Ask the agent to change one, or answer setup's Interaction question, and it saves your answer with Prism's `update_personal_settings` tool; agents read them with `get_personal_settings`.

A project set up by an earlier Prism may still record these values under `## Interaction` in `.prism/workflow.md`, as `- Interaction style:`, `- Review browser:`, `- Review browser on start:`, and `- Session offer:` lines.
While you have no value of your own for a setting, Prism uses the project's line, and the first session or tool call for that project adopts it as your own, so from then on it applies to every project and a later change to that line no longer does.
A value of your own always wins over a project's line.
The environment variables `PRISM_SESSION_OFFER=off` and `PRISM_REVIEW_BROWSER_ON_START=off` still turn the offer and the review browser at start off for every process that has them, whatever your settings say.

## Offer at the start of a conversation

When you start a new conversation, or clear one, Prism tells the agent it is available.
If your first request asks for code that adds or changes behavior your requirements, ADRs, or feature files describe, the agent asks once whether to run it through Prism, and on yes it starts `prism:orchestrate` with your request.
In a project without `.prism/workflow.md`, it offers `prism:setup` instead.
It does not ask about a question on the code, a change that no requirement or ADR covers, such as a color or a typo, or a request that already names a Prism skill.
When questions already wait on you in an initiative, it offers to resume that initiative.
A resumed conversation and a child agent get no offer.
Set your [personal setting](#personal-settings) `sessionOffer` to `off`, or the environment variable `PRISM_SESSION_OFFER=off`, to turn the offer off.
In Codex the offer needs Prism's hooks to be trusted through `/hooks`, like gate answers and run totals.

## Migrate an older setup

Prism no longer reads `.claude/workflow-config.md`, and `prism:setup` migrates its values into `.prism/workflow.md` without changing the old file.
On resume, orchestration imports a legacy `map.puml` into the initiative record.
`prism:setup` proposes a roadmap record from a legacy roadmap and replaces the hand-written roadmap Markdown only after you accept it.
An initiative that the legacy roadmap lists as shipped is recorded as shipped before Prism, without the ship gate, since it has no slices or verification runs to confirm, and the setup report names each one.
The roadmap shows it as shipped before Prism, and its plan documents stay unchanged.
See [Upgrading to managed records](upgrading-to-managed-records.md) for everything that changed in Prism 0.10.0.
