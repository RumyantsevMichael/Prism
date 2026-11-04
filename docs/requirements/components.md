# Components in one repository

Status: Draft
Created: 2026-11-04
Approved: n/a

## Problem

A monorepo holds many packages with their own tests, but Prism treats a repository as one unit, so every slice runs the whole repository's test command and nothing keeps a slice inside the package it was planned for.
A change in one package can break the packages that use it, and today nothing runs their tests when the work that changed it finishes.
Prism prepares one native index for the whole repository, and issue #14 reports that a large monorepo reaches its limits of 30 minutes of preparation, a 512 MiB index file, and 100,000 fragments, while a preparation that times out publishes nothing, so each retry starts again from zero.
Lumen, a Bun and TypeScript monorepo with about 60 packages, holds about 21 MB of indexable source and about 45,000 fragments, right at today's practical limit, with its largest areas, `docs/` and `packages/lumend`, at about 8,800 and 8,300 fragments.
Prism 0.17.0 also only warns a checkout whose configuration names a record store but no repository name, and Michael decided on 3 November 2026 that a later release refuses it.

## Goals

- Let a repository declare its components, each a folder with an optional test command and the components of the same repository it depends on.
- Keep each planned leaf slice inside one component, while a contract scope may span several.
- Verify each slice with its component's test command, and run the tests of the components that depend on the changed ones when a scope that spans components finishes.
- Prepare the native index per component, only for the components a tool needs, so a large monorepo fits within the native limits.
- Keep every repository that declares no components, and every slice recorded before components existed, working as today.
- Refuse a checkout whose configuration names a record store but no repository name.
- Prove it with one real Lumen initiative that changes two or more packages and runs end to end, with each slice verified by its package's test command, the dependents' tests run at scope end, and every needed package indexed within the limits.

## Non-goals

- Dependencies on components in another repository.
- Running or verifying a slice in another repository's checkout.
- Read-only clones of other repositories.
- The workspace view by repository and component in the review browser.
- The dogfood issues #88 to #91 and #95 to #98.

## Design questions

- Where the component list lives in the parsed configuration and how its entries are spelled, including the folder form, a component name's allowed characters, and the name of the root component.
- What a repository's single component is named when its configuration names no record store and so has no repository name.
- How design plans a slice that creates the folder of a newly declared component, and whether a declared folder that does not exist yet is refused.
- How Prism determines a slice's actual changes for the component check at verification, for example from the slice's commits or from the work tree against the slice's start.
- Whether a verified change that leaves the slice's component refuses the run or only flags it for review, since Michael's scope allows either.
- Whether a change under a shared path, such as a lockfile, counts as changing every component for the dependents' run at scope end.
- Whether the dependents' run at scope end happens inside the last slice's `verify_slice` call or in a separate step, and how the orchestrator waits for its approval gates.
- How a native index per component is keyed, reused across source changes, and counted against the number of earlier indexes Prism keeps.
- How merged results from several component indexes are ranked so that scores stay comparable.

<a id="1"></a>
## 1. Refuse a checkout without a repository name

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a project's workflow configuration names a record store but no repository name, then Prism shall refuse every record operation with an error that shows the `- Repository: <name>` line to add under `## Workspace` and proposes a name that the store would accept for this checkout.

Rationale: Michael decided on 3 November 2026 that a name is required whenever a store is configured and that checkouts are warned first and refused in a later release, and on 4 November 2026 he agreed that this milestone is that release, so components can rely on every checkout of a store having a name.

Supersedes: [repository-names.md§2](repository-names.md#2)

Related: [repository-names.md§1](repository-names.md#1), [repository-names.md§7](repository-names.md#7)

<a id="2"></a>
## 2. Keep projects without a record store unchanged

Pattern: Optional feature

Disposition: Active

Requirement: Where a project's workflow configuration names no record store, Prism shall serve record operations without a repository name.

Rationale: A repository name only tells repositories that share a store apart, so a project with its records in its own checkout needs none, and the refusal must not reach it.

Related: [§1](#1)

<a id="3"></a>
## 3. Read declared components

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository's committed `.prism/workflow.md` lists components under `## Components`, Prism shall treat each listed component as the folder it names, with its own `Test command` and its `Depends on` components when the entry gives them.

Rationale: The team that owns a repository knows its packages and their tests, and a committed declaration is the same in every checkout.

Related: [§4](#4), [§5](#5)

<a id="4"></a>
## 4. Treat a repository without components as one component

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository's workflow configuration declares no components, Prism shall treat the whole repository as one component named after the repository.

Rationale: Michael decided on 3 November 2026 that a repository that declares no components is one component, so every existing repository keeps working without a change.

Related: [§3](#3), [§10](#10)

<a id="5"></a>
## 5. Assign undeclared files to the root component

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository declares components, Prism shall assign every file outside all declared component folders to the repository's root component.

Rationale: Root configuration, CI files, and documentation belong to no package but still need an owner, so every file belongs to exactly one component.

Related: [§3](#3), [§9](#9)

<a id="6"></a>
## 6. Refuse overlapping component folders

Pattern: Unwanted behavior

Disposition: Active

Requirement: If two declared components name the same folder or one component's folder lies inside another's, then Prism shall refuse every operation that reads the repository's components with an error that names both components and their folders.

Rationale: A file must belong to one component for the slice boundary to mean anything, and Michael accepted refusing overlapping or nested folders as a default on 4 November 2026, which he can revisit.

Related: [§3](#3), [§5](#5)

<a id="7"></a>
## 7. Refuse a dependency on an undeclared component

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a component's `Depends on` entry names a component that its repository does not declare, then Prism shall refuse every operation that reads the repository's components with an error that names the component and the unknown dependency.

Rationale: A misspelled or cross-repository dependency would otherwise be ignored silently, so a breaking change would skip its dependents' tests, and dependencies on other repositories are out of scope for this milestone.

Related: [§3](#3), [§17](#17)

<a id="8"></a>
## 8. Refuse a dependency cycle

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the `Depends on` entries of a repository's components form a cycle, then Prism shall refuse every operation that reads the repository's components with an error that names the components in the cycle.

Rationale: Michael accepted refusing dependency cycles as a default on 4 November 2026, which he can revisit, because a cycle makes the order of dependents' runs undefined.

Related: [§3](#3), [§17](#17)

<a id="9"></a>
## 9. Let any slice change a shared path

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository's workflow configuration lists shared paths, Prism shall treat a change to a file under a shared path as inside the component of every leaf slice.

Rationale: Lockfiles and similar files change with almost any package change, so without this every such slice would cross the root component, and Michael accepted a short per-repository list as a default on 4 November 2026, which he can revisit.

Related: [§12](#12), [§15](#15)

<a id="10"></a>
## 10. Keep slices recorded before components valid

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall read, start, and verify every slice recorded without a component as it did before components existed.

Rationale: Initiative records already hold accepted slices without components, and Michael's standing rule is that format changes are non-breaking or ship a migration.

Related: [§4](#4), [repository-names.md§7](repository-names.md#7)

<a id="11"></a>
## 11. Record one component on each planned leaf slice

Pattern: Event-driven

Disposition: Active

Requirement: When an orchestrator accepts a design proposal, Prism shall record on each planned leaf slice the one component that the design names for it, or the repository's only component when the repository declares none.

Rationale: The slice's component decides its boundary, its test command, and the index it needs, so it must be fixed when the design is accepted.

Related: [§12](#12), [§13](#13), [§14](#14)

<a id="12"></a>
## 12. Refuse a leaf slice that crosses its component

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a path in a leaf slice's `slice.md` Changes or one of its frozen tests lies outside the slice's component and outside every shared path, then Prism shall refuse the design proposal with `component_boundary`, naming the slice, its component, and each crossing path.

Rationale: Michael decided on 3 November 2026 that a leaf slice may not span components, so each slice is verified by one component's tests and never needs another component's checkout or index.

Related: [§9](#9), [§11](#11), [§14](#14)

<a id="13"></a>
## 13. Refuse a leaf slice without a valid component

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a leaf slice in a design proposal for a repository that declares components names no component of that repository, then Prism shall refuse the design proposal with an error that names the slice and the repository's components.

Rationale: A slice without a component could not be checked against a boundary or verified with a component's test command.

Related: [§11](#11)

<a id="14"></a>
## 14. Let a contract scope span components

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall accept a contract scope whose leaf slices belong to different components of one repository.

Rationale: Michael decided on 3 November 2026 that the scope's contract is the boundary contract between the components its slices change.

Related: [§12](#12), [§17](#17)

<a id="15"></a>
## 15. Verify a slice with its component's test command

Pattern: Event-driven

Disposition: Active

Requirement: When an implementer verifies a leaf slice through `verify_slice`, Prism shall run the test command of the slice's component, or the repository's `Test command` when the component declares none.

Rationale: A package's own tests prove its slice faster and more precisely than the whole repository's tests.

Related: [§3](#3), [§19](#19)

<a id="16"></a>
## 16. Report verified changes outside the slice's component

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a slice's verified changes include a file outside its component and outside every shared path, then Prism shall name each such file in the `verify_slice` result and on the slice's verification run.

Rationale: The design-time check covers only planned paths, so an implementation that strays into another component would otherwise go unnoticed by that component's tests.

Related: [§12](#12), [§15](#15)

<a id="17"></a>
## 17. Run dependents' tests when a spanning scope finishes

Pattern: Event-driven

Disposition: Active

Requirement: When the last leaf slice of a contract scope whose leaf slices belong to two or more components is done, Prism shall run the test command of each component that depends on a component that the scope's slices changed.

Rationale: Each slice runs only its own component's tests, so a change that breaks a component depending on it shows only when the dependents run, and running them once per spanning scope keeps each slice's verification short.

Related: [§14](#14), [§18](#18), [§19](#19)

<a id="18"></a>
## 18. Block a spanning scope with a red dependent

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a dependent component's test command fails or is declined in the run at the end of a contract scope, then Prism shall report the scope as blocked, naming each such component, and refuse to ship its initiative until a later run of those test commands passes.

Rationale: The scope's work is not finished while it leaves a component that depends on it broken, or unproven because its tests did not run.

Related: [§17](#17)

<a id="19"></a>
## 19. Ask once for each distinct test command

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall ask the user to allow each distinct test command, including each component's and each dependent's, before it first runs that command.

Rationale: Running a command on the user's machine needs their consent, and Michael accepted that each distinct command needs its own approval as a default on 4 November 2026, which he can revisit.

Related: [§15](#15), [§17](#17)

<a id="20"></a>
## 20. Prepare the native index per component

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository declares components, Prism shall prepare a separate native index for each component that holds only that component's files.

Rationale: Issue #14 shows that one index of a large monorepo reaches the native limits, while each Lumen package and area is far below them, and Michael accepted on 4 November 2026 that an index holds no copies of the components it depends on, so structural reports see each component alone, as a default he can revisit.

Related: [§21](#21), [§22](#22)

<a id="21"></a>
## 21. Prepare only the indexes a tool needs

Pattern: Event-driven

Disposition: Active

Requirement: When a Prism tool needs native index evidence for some components of a repository, Prism shall prepare only those components' indexes that are missing or out of date.

Rationale: A slice or a path-scoped search touches a few packages, so preparing the whole monorepo first would spend the time and space that issue #14 runs out of.

Related: [§20](#20), [§24](#24)

<a id="22"></a>
## 22. Keep prepared component indexes after a failure

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the preparation of one component's native index fails or exceeds a native limit, then Prism shall keep serving every other component index that it prepared, and name the failed component and the limit it reached.

Rationale: Issue #14 reports that a timed-out preparation publishes nothing, so retries restart from zero, and one oversized package must not take every other package's evidence with it.

Related: [§20](#20), [§21](#21)

<a id="23"></a>
## 23. Keep one index for a repository without components

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository declares no components, Prism shall prepare one native index for the whole repository.

Rationale: Repositories that declare no components keep today's behavior, evidence, and cache.

Related: [§4](#4), [§20](#20)

<a id="24"></a>
## 24. Answer path-scoped queries from matching components

Pattern: Event-driven

Disposition: Active

Requirement: When a tool call scopes a native index query to paths in a repository that declares components, Prism shall answer it from the indexes of the components that contain those paths.

Rationale: A query about one package needs only that package's index, so it can start as soon as that one is prepared.

Related: [§21](#21)

<a id="25"></a>
## 25. Merge unscoped semantic queries across prepared indexes

Pattern: Event-driven

Disposition: Active

Requirement: When a tool call makes a semantic query without a path scope in a repository that declares components, Prism shall merge the results of every prepared component index into one result list.

Rationale: A search for reuse across the whole repository must still find candidates in every package that is indexed.

Related: [§26](#26)

<a id="26"></a>
## 26. Disclose components missing from a merged result

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a semantic query without a path scope runs while some component indexes are not prepared, then Prism shall name each component whose index the result does not include.

Rationale: Prism's evidence discloses incomplete coverage, so a missing candidate in an unprepared package is never read as proof that no such code exists.

Related: [§25](#25)

<a id="27"></a>
## 27. Show each slice's component in the review browser

Pattern: Event-driven

Disposition: Active

Requirement: When the review browser shows a slice that has a component, Prism shall show the component's name as a small label on the slice.

Rationale: A reviewer of a scope that spans packages needs to see which package each slice changes, and Michael accepted a small label as a default on 4 November 2026, which he can revisit, while the workspace view stays out of scope.

Related: [§11](#11)
