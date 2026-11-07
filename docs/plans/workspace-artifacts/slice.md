# Workspace artifacts in the store

## Outcome

A workspace's descriptive artifacts live in its shared store, scoped to the workspace, a repository, or a component, reviewed in Prism with diffs and comments, and changed in status only at gates, while executable artifacts stay with the code.

## Design questions settled

- Agents read and write store artifacts only through Prism tools, addressed by the project-relative path the checkout's configured paths give them, because writes outside the working folder ask for approval or fail in sandboxed hosts, and only a tool write lets Prism lock, sync, and check status ([store-artifacts ADR](../../ADRs/workflow-records/store-artifacts.md)).
- Configured paths map to fixed kind folders in the store, and a repository's or component's artifacts live in that scope's own folder, so two repositories never share a location, while within what one checkout sees each path names one artifact.
- Concurrent changes to one Markdown artifact merge by Git's line merge, which combines changes to different sentences of a one-sentence-per-line file (probe below), and a line that changed differently on both sides falls back to the whole-file rule that records use.
- Artifact names follow one positive name form instead of a list of dangerous names, so every `.git` variant, Git's short name `git~1`, dotfiles such as `.gitignore`, temporary files, and invisible characters are refused by one rule, at the cost of refusing names with spaces or non-Latin letters.
- Prism's lock and temporary files stay beside the store files they guard, because the ignore file that Prism writes into a store lists `*.lock` and `.*.tmp`, so the store's Git would leave out an artifact with such a name wherever the locks lived; the name form already refuses `.*.tmp`, which begins with `.`, and only the `.lock` ending is reserved besides, in any letter case because a case-insensitive file system makes `x.LOCK` the lock file of `x` (probe below).
- Code repositories keep their configured paths, which stay the artifacts' addresses, and the move reports each tracked file that still names a moved path, so a person updates the instructions instead of Prism rewriting them.
- Status changes at gates are recorded beside the artifact in the store ([artifact status ADR](../../ADRs/workflow-records/artifact-status-at-gates.md)).

## Contract

### Artifact paths and store layout

1. In a checkout whose `.prism/workflow.md` names a store under `## Workspace`, a project-relative path, with its `.` and `..` components resolved, is an artifact path when it equals the configured `Glossary` or `Roadmap` path or lies inside the configured `Requirements`, `ADRs`, or `Plans` folder, lies inside neither the configured `Feature files` nor `User guide` folder, and has a well-formed name; a path names its kind by the longest configured path that contains it, and a key set to `n/a` names no kind.
   A path has a well-formed name when every component of it below its configured folder, and the file name of the configured `Glossary` or `Roadmap` path, begins with an ASCII letter or digit, holds only ASCII letters, digits, `.`, `_`, and `-`, and does not end in `.lock` in any letter case, the name of the lock that store sync takes beside a store file; no listing shows a file whose path has no well-formed name.
2. A store holds artifacts under `artifacts/` in scope folders: the workspace scope at `artifacts/`, a repository at `artifacts/repositories/<repository>/`, and a component at `artifacts/repositories/<repository>/components/<component>/`.
3. Inside a scope folder an artifact lives at `requirements/<rest>`, `adrs/<rest>`, `plans/<rest>`, or `glossary.md`, where `<rest>` is the artifact path below its configured folder, and the roadmap view lives only at `artifacts/roadmap.md`; the artifact's location is its path below `artifacts/`.
4. A scope is reported as `{ kind, label }` with `kind` `workspace`, `repository`, or `component`, `repository` and `component` names where they apply, and `label` `workspace`, `<repository>`, or `<repository>/<component>`.
5. A checkout sees the workspace scope, its repository's scope under its accepted `Repository` name, and the scope of every component folder of its repository that the store holds.
6. A path resolves to the one scope the checkout sees that holds it; when more than one does, a read or update without `scope` is refused with `artifact_ambiguous` and `data.scopes` listing their labels, and a `scope` input picks one.
7. A `scope` input is `"workspace"`, `"repository"`, or `"component"` with a `component` name; a component that the checkout's `## Components` does not declare is refused with `component_unknown`, and any other value with `scope_invalid`.

### Reading artifacts

8. `get_artifact` with `path` naming a file returns `path`, `scope`, `kind`, `version` (`sha256:` and the hex SHA-256 of the file's bytes), `bytes`, `totalLines`, `offset`, `content`, and `nextOffset`, which is null on the last page.
9. A read returns the text of whole lines from `offset` (1-based, default 1), with their line endings, up to `limit` lines (default 2000) and at most 64 KiB, and always at least one line, so the pages of a long file joined in order give its text.
10. `get_artifact` without `path`, or with `path` naming a folder, lists every artifact the checkout sees below it as `artifacts` entries of `path`, `scope`, `kind`, `version`, and `bytes`, sorted by path and then scope label, at most 2000 entries with `truncated` true when more exist.
11. A path no seen scope holds is refused with `artifact_not_found`, and a file that is not UTF-8 text with `artifact_not_text`.

### Writing artifacts

12. `update_artifact` takes `operations`, at most 50, each one of `write` (`path`, `content`, `expectedVersion`, optional `scope`), `edit` (`path`, `expectedVersion`, `edits` of `oldText` and `newText`), `remove` (`path`, `expectedVersion`), and `move_scope` (`path`, `expectedVersion`, `scope`, optional `component`), and returns `artifacts` with each touched artifact's `path`, `scope`, and new `version`, or `removed` true.
13. `expectedVersion` is the version last read, or null to create; any other mismatch with the store is refused with `version_conflict` and `data.version` holding the current version or null.
14. A created artifact takes the given scope, else the scope of its nearest ancestor folder that one seen scope holds, else the workspace scope, and creating a path that another seen scope already holds is refused with `artifact_exists` and `data.scope`.
15. Each `edit` replaces one occurrence of `oldText` that occurs exactly once in the text as earlier edits left it, and is refused with `edit_not_applied` and `data.edit` holding its index otherwise.
16. Content is UTF-8 text of at most 1 MiB, refused with `artifact_too_large` above it.
17. Prism checks every operation of an update before it changes any file, and a refused update changes no file.

### Where artifacts are kept

18. Feature files, step definitions, frozen tests, executable contracts, and user documentation are not artifact paths: `get_artifact` and `update_artifact` refuse them, and every other path outside the artifact paths, with `not_an_artifact`, whose message says the file stays in the checkout.
   A path that would be an artifact path but for its name is refused by every read and operation of both tools with `artifact_name_invalid`, whose `data.invalidName` holds the first component that breaks the name form and whose message states the form, an ASCII letter or digit first, then only ASCII letters, digits, `.`, `_`, and `-`, and no `.lock` ending, and does not mention the checkout, so the agent picks another name rather than writing the file into the checkout.
19. `accept_design` refuses a frozen test file that is an artifact path with `frozen_test_in_store`.
20. In a project whose configuration names no store, `get_artifact` and `update_artifact` refuse with `store_not_configured`, and Prism keeps every artifact in the checkout as before.
21. When the configured store is unavailable or the checkout's repository name is refused, `get_artifact` and `update_artifact` refuse with the store's own refusal code, such as `store_unavailable`, whose message names the store as configured, and read or write no checkout file.
22. With a store, Prism reads and writes the artifacts it uses itself in the store and never in the checkout: `slice.md` and PlantUML files at design proposal and acceptance, `slice.md` in `update_design_view`, the `recovery.md` that `checkpoint_pause` writes, and the generated `initiative.md`, `review.md`, and roadmap views, each generated view in the scope that holds its folder, else the workspace scope.
   Because a plan folder is named by initiative and slice slugs, `update_initiative` with a store refuses a `create`, `import_map`, or `split` that names a slug beginning with `-` or `_` with `artifact_name_invalid` and changes no record, and for such a slug that a record already holds Prism reads and writes none of its plan files: its design proposal and acceptance are refused with `artifact_name_invalid`, and no generated view is written for it.
23. With a store, the review browser lists the artifacts the checkout sees by path in `/api/index`, gives each one's scope label in `artifactScopes`, and serves its store bytes from `/api/artifact`.

### Sync and concurrent changes

24. Where store sync is on, an `update_artifact` that changed a file schedules the store sync that a record write schedules, so the change is committed and pushed without a further call.
25. A sync merges an artifact that changed on both sides with Git's line merge, and when that conflicts it keeps the upstream artifact, saves the local bytes under the store's sync folder, and names the artifact's path, scope label, and saved copy in the next tool result of each Prism server that uses the store.

### Moving existing artifacts

26. On a checkout's first access to its store in a server process, before the access proceeds, Prism moves every file under the checkout's artifact paths into its repository's scope, except a frozen test of an accepted design and the record files that the record move takes, removes each moved file from the checkout, and writes one ledger file under `artifact-migrations/` naming the repository, each move, and each kept file.
27. A path that a ledger file already lists for the repository is never moved again.
28. A checkout file whose store location already holds the same bytes is removed and reported as moved; one whose location holds other bytes, whose path the workspace scope holds, or whose ledger-listed artifact the store no longer holds stays in the checkout, and the report names both locations and the reason `differs`, `workspace_holds`, or `removed_in_store`.
   A checkout file inside a configured `Requirements`, `ADRs`, or `Plans` folder, or at the configured `Glossary` or `Roadmap` path, whose path has no well-formed name is never moved or removed: it stays in the checkout, the ledger lists it as kept, and the report names its checkout path and the reason `name_invalid`.
29. The tool result of that access reports the moved files from checkout path to store location, the kept files, and each tracked file left in the checkout, by `git ls-files`, whose text names a moved file's former path or the configured folder of a kind that lost files, as `<file>:<line>` with its line numbers separated by commas, listing at most 200 such files and the count of the rest.

### Status at gates

30. A requirement's or ADR's written status is the text after `Status:` on the first line beginning with `Status:` before its first `## ` heading.
31. Prism records each requirement's and ADR's status in the store: `Draft` for a new requirement, `Proposed` for a new ADR, the written status for a moved file, and afterwards only what a gate answer sets.
32. `get_artifact` and the `artifacts` entries return a requirement's or ADR's recorded status as `status`, and when the written status differs, `get_artifact` and the artifact's entry in the `update_artifact` result that wrote it return `statusMismatch` with `written`, `recorded`, and a message that names the gate that changes it; neither refuses, and the review browser shows the recorded status.
33. `update_artifact` operation `ask_approval` (`path`, optional `status`, default `Approved`, `question`, `context`) records a pending approval gate on a requirement or ADR at its current version and returns its id as `gate` in the artifact's entry of the result; it is refused with `status_by_ship` for `Accepted` on an ADR, with `nothing_to_approve` when the status equals the recorded one and the bytes equal the accepted version, and with `not_a_status_artifact` for any other file.
34. The review browser's Attention lists each pending approval gate of the artifacts the checkout sees under `needsYou` as an item of `type` `gate` and `kind` `approval` with its `id`, `question`, `context`, and `artifact` holding its `path` and `scope`, and `/api/gates/answer` takes `{ artifact, scope, id, choice, note }` with choice `approve` or `request-changes`.
35. Approving rewrites the artifact's `Status:` line to the gate's status and, for `Approved`, its `Approved:` line to the answer's date, adding one after the `Status:` line when it has none, then records the status, the accepted version, and `approval` with the gate, the time, and who approved as `by` with the checkout's Git `user.name` as `name` and the machine's host name as `host`, which `get_artifact` returns.
36. An answer is refused with `409` and code `artifact_changed` when the artifact changed since the gate was asked, and with `author_unknown` when Git has no `user.name`.
37. `wait_for_user_gate` takes `artifact` (and optional `scope`) in place of `initiative` and waits for that artifact's approval gates as it waits for an initiative's.
38. The accepted version of an artifact is its bytes at its latest approval, at the `accept_proposal` that accepted designs of the slices whose folders hold it, or at the ship that accepted it; `get_artifact` returns `acceptedVersion` and `changedSinceAccepted`, and with `accepted` true reads the accepted bytes.

### Review in the browser

39. `/api/artifact` for a store artifact also returns `artifact` with `scope`, `version`, `accepted` (`version` and `content`, or null), `changed`, and `comments`, and the browser shows the changed lines against the accepted version, or the whole file as added when it has none.
40. `POST /api/artifact/comments` with JSON `{ path, scope, version, line, text }` from the review page stores one new file per comment under `artifact-comments/<location>/` holding `location`, `version`, `line`, `text`, `author` with the checkout's Git `user.name` as `name` and the host name as `host`, and `at`, and returns it with `path` and `scope` added and status `201`.
41. A comment is refused with `403` when it is not JSON from the review page's own origin, `404` for an artifact the checkout does not see, `400` for text that is empty or above 4000 characters, and `409` `author_unknown` when Git has no `user.name`.
42. Every reader of an artifact, in the browser through `/api/artifact` and in `get_artifact`, gets its comments, oldest first, including comments that a sync brought from other machines.

### Accepting ADRs at ship

43. With a store, `ship` takes `afterGate`, a `correctness` gate of the initiative that the review browser answered `approve`, and is refused with `ship_unconfirmed` without one.
44. On ship, each ADR whose recorded status is `Proposed` and that a Markdown link in any `slice.md` of the initiative names becomes `Accepted`: Prism rewrites its `Status:` line, records the status with the gate, and records `acceptance` with the gate and `verifiedBy`, the `slice`, `repository`, and `commit` of each leaf slice's latest passing verification run, which `get_artifact` returns; the ship result lists the accepted ADRs under `acceptedAdrs` with `path`, `scope`, and `verifiedBy`, and a cited ADR with another recorded status stays as it is.

### Guidance

45. The workflow skills tell agents in a project with a store to read and write descriptive artifacts only through `get_artifact` and `update_artifact`, to leave status lines to gates, to ask requirement approval through `ask_approval`, and to ship after a `correctness` gate, while a project without a store keeps editing them in the checkout.

## Assumptions

- Probed: every requirement and ADR in this repository states its status on a `Status:` line before its first level-two heading, so §30 reads all of them (`node docs/plans/workspace-artifacts/probes/status-lines.mjs .`, observed 47 files, statuses Approved 13, Draft 4, Declined 1, Proposed 22, Accepted 7, none missing).
- Probed: Git's tree-level merge, which store sync uses, combines edits to different lines of a one-sentence-per-line Markdown file and reports edits of one line as a conflict, so §25 needs no Markdown merge of its own (`node docs/plans/workspace-artifacts/probes/markdown-merge.mjs <scratch folder>` with Git 2.43, observed exit 0 with both edits merged, and exit 1 naming the file).
- Probed: moving this repository's descriptive artifacts would move 102 tracked files and leave 37 tracked files outside them that name a moved file's path, mostly tests and fixtures naming `docs/roadmap.md`, and 42 more that name only a moved folder, so §29 lists both and caps the list (`node docs/plans/workspace-artifacts/probes/references.mjs .`).
- Probed: `git add -A`, which store sync's commit runs, fails with exit 128 for the whole store when a path has a component `.git` in another letter case, `.git.`, `.git `, `git~1`, `GIT~1`, or `.git::$INDEX_ALLOCATION`, or, with `core.protectHFS` on as macOS sets it, `.g` U+200C `it`, and silently leaves out a `.git` folder, while it adds `.gitignore`, `.gitattributes`, and `.gitmodules`, which Git then applies to the whole store; it adds every name the §1 name form admits, such as `a.`, `x...y`, `a-`, `aux`, and `v1.0-draft.md`, and the ignore file that Prism writes into a store makes it leave out a file whose name ends in `.lock`, every file of a folder whose name does, and a `.<name>.<pid>.<hex>.tmp` file, so §1 admits only the name form, which no `.git` variant or dotfile meets, and reserves the `.lock` ending (`node docs/plans/workspace-artifacts/probes/git-path-names.mjs <scratch folder>` with Git 2.43, observed exit 128 for each listed name, exit 0 with nothing added for `.git`, exit 0 with the file added for `.git~1`, `.gitx`, `.gitignore`, `.gitmodules`, `my.git`, and `digit`, exit 0 with 8 of 8 admitted names added, and exit 0 with 0 of 3 lock and temporary files added under the store's ignore file).
- Probed: no file under this repository's configured `Requirements`, `ADRs`, and `Plans` folders, `docs/Glossary.md`, or `docs/roadmap.md` breaks the §1 name form, so §28's `name_invalid` keeps none of them, and no initiative or slice slug in its store begins with `-` or `_` (a check of the §1 form and the `.lock` ending over `find docs/requirements docs/ADRs docs/plans`, observed 180 paths and none refused, and `get_roadmap` and `get_initiative`, observed 7 initiatives, 3 of them with records holding 28 slices).
- Probed: repository and component names, which name scope folders, are lowercase letters, digits, `-`, and `_` that begin and end with a letter or digit, and kind folders are fixed names, so no scope or kind folder breaks the §1 name form (`REPOSITORY_NAME` and `COMPONENT_NAME` in `src/server/workflow/repository-names.mjs` and `components.mjs`), while slugs may begin with `-` or `_` (`SLUG_PATTERN` in `src/server/workflow/initiative-graph.mjs`), which §22 refuses with a store.
- Probed: the largest descriptive artifact in this repository is 32 KiB, well inside one 64 KiB page (`wc -c` over `docs/requirements`, `docs/ADRs`, and `docs/plans`).
- Unprobed: how large a tool result each host accepts; §9 pages a read at 64 KiB, below the 25,000-token default of Claude Code, and a longer file needs more pages rather than a truncated result.
- Unprobed: whether every machine sets Git's `user.name`; §36 and §41 refuse an answer or comment without one rather than store an anonymous one.
- Unprobed: Markdown links whose target leaves its scope folder; links are kept byte for byte, and one that crossed configured folders that were not siblings in the checkout no longer resolves in the browser, which shows it as a missing file.

## Slices

| Slug | Outcome | Component | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- | --- |
| `artifact-tools` | Agents read, list, and write store artifacts by path and scope through Prism tools, executable files stay in the checkout, and an unavailable store refuses. | `prism` | `workspace-artifacts.md§1`, `§2`, `§3`, `§4`, `§15` | | `test/server/fixtures/workspace-artifacts.mjs`, `test/server/workspace-artifacts-tools.test.mjs` | required: path input decides which files are written outside the project |
| `artifact-consumers` | Prism's own design, pause, and view files, and the review browser's listing, use the store. | `prism` | `workspace-artifacts.md§1`, `§2`, `§4`, `§15` | `artifact-tools` | `test/server/workspace-artifacts-consumers.test.mjs` | none |
| `artifact-sync` | Artifact writes sync like records, and a concurrent change is kept aside and reported. | `prism` | `workspace-artifacts.md§13`, `§14` | `artifact-tools` | `test/server/workspace-artifacts-sync.test.mjs` | required: a merge mistake loses a person's change |
| `artifact-status` | Requirement and ADR status changes only at approval gates answered in the browser, with accepted versions recorded. | `prism` | `workspace-artifacts.md§10`, `§11` | `artifact-consumers` | `test/server/workspace-artifacts-status.test.mjs` | required: only a person's answer may change a status |
| `artifact-migration` | A checkout's existing descriptive artifacts move into its repository's scope once, keeping differing copies and reporting references. | `prism` | `workspace-artifacts.md§2`, `§5`, `§6`, `§7` | `artifact-status` | `test/server/workspace-artifacts-migration.test.mjs` | required: it deletes files from checkouts |
| `artifact-review` | People see artifacts by scope, their changes against the accepted version, and comments that travel through the store. | `prism` | `workspace-artifacts.md§4`, `§8`, `§9` | `artifact-status` | `test/server/workspace-artifacts-review.test.mjs` | required: the browser accepts comments from the page |
| `adr-acceptance` | Shipping after a person's confirmation accepts the initiative's Proposed ADRs with their commits. | `prism` | `workspace-artifacts.md§12` | `artifact-status` | `test/server/workspace-artifacts-ship.test.mjs` | required: only a person's answer may change a status |
| `artifact-guidance` | The workflow skills and user guide tell agents and people how store artifacts are read, written, approved, and shipped. | `prism` | `workspace-artifacts.md§1`, `§10`, `§11`, `§12` | `artifact-migration`, `artifact-review`, `adr-acceptance` | `test/server/workspace-artifacts-guidance.test.mjs` | none |

The overview is [overview.puml](overview.puml).
