# Reference repositories and libraries in a workspace

Status: Approved
Created: 2026-11-11
Approved: 2026-11-11

## Problem

Design plans against code that the workspace depends on but does not work in, such as a colleague's service whose interface the work calls, a shared library repository, or infrastructure code, and against third-party libraries.
A workspace knows only the repositories whose checkouts use Prism, so there is no place to say which other repositories planning may read, at which version, or which of their components exist.
A dependency on another repository's component is checked only for its form, and the person has no page that shows what a workspace is made of.

## Goals

- Let a person add repositories that do not use Prism to a workspace as read-only reference repositories, with the version Prism reads by default.
- Keep a reference repository's components, and a peer Prism workspace's store, known to the workspace without writing to that repository or copying its content into the store.
- List each component's third-party libraries from its manifests and lockfile without anyone declaring them.
- Give the review app one workspace page where a person sees and changes the workspace's repositories, components, dependencies, and libraries.

## Non-goals

- Searching reference repositories, libraries, or peer workspaces' records, which [reference-search.md](reference-search.md) owns.
- Pinning commits on work items and citing outside facts, which [work-item-pins.md](work-item-pins.md) owns.
- Planning slices, running tests, or writing anything in a reference repository.
- Host tools such as Claude Code or Codex, whose facts come from probes recorded in host profiles.
- Approving test commands for sessions that run without a person, and access held by a hosted Prism service for reference repositories.

## Design questions

- Whether a reference repository and code content of the same remote share one clone on a machine, and how a ref policy narrows a clone that otherwise fetches every branch.
- How each ecosystem's lockfile yields a library's name and version, and how a patched installed copy is told apart.
- Where in the places navigation the workspace page opens.

<a id="1"></a>
## 1. Give each workspace repository a role

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall record each repository of a workspace with one of two roles, worked on or reference, and treat a repository whose checkouts name the workspace's store as worked on unless the person sets otherwise.

Rationale: Michael decided on 9 November 2026 that a workspace's repositories carry a role beside a list of libraries, so one list, one naming scheme, and one component identity cover both kinds of repository.

Related: [repository-names.md§3](repository-names.md#3), [workspace-view.md§2](workspace-view.md#2)

<a id="2"></a>
## 2. Add a reference repository by its remote

Pattern: Event-driven

Disposition: Active

Requirement: When a person adds a reference repository to a workspace by an HTTPS, SSH, or folder URL and a name, Prism shall record in the workspace's store a reference repository with that name, the remote, a ref policy, and the person's note on why planning needs it.

Rationale: A reference repository has no Prism configuration of its own, because the workspace does not own it, so its entry has to live in the shared store where every colleague sees the same workspace.

Related: [workspace-view.md§11](workspace-view.md#11)

<a id="3"></a>
## 3. Refuse a reference URL that carries credentials

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a URL that a person enters for a reference repository contains a user name, password, or token, then Prism shall refuse it before recording or fetching anything and say that credentials come from the machine's Git configuration.

Rationale: The entry is shared through the store, so a credential in it would reach every colleague and every clone of the store.

Related: [workspace-view.md§12](workspace-view.md#12)

<a id="4"></a>
## 4. Refuse a reference name that another repository holds

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a person adds a reference repository under a name that the workspace's store already registers with a different remote, then Prism shall refuse the entry and name the registered remote without user information.

Rationale: Components, citations, and pins name a repository by its workspace name, so one name must mean one repository.

Related: [repository-names.md§4](repository-names.md#4), [repository-names.md§5](repository-names.md#5)

<a id="5"></a>
## 5. Resolve the default commit from the ref policy

Pattern: Event-driven

Disposition: Active

Requirement: When Prism needs a reference repository's default commit, Prism shall resolve it from the entry's ref policy, which follows the remote's default branch unless the entry names a tag pattern, whose newest matching tag it follows, or a fixed ref.

Rationale: Michael decided on 9 November 2026 that the version a work item builds on is pinned on the work item, so the ref policy only chooses the commit read outside work items and the first pin, and following the default branch needs no upkeep while a tag pattern or fixed ref covers teams that release from tags.

Related: [reference-search.md§4](reference-search.md#4), [work-item-pins.md§1](work-item-pins.md#1)

<a id="6"></a>
## 6. Fetch a reference repository with the machine's credentials

Pattern: Event-driven

Disposition: Active

Requirement: When Prism needs a commit of a reference repository that its clone on this machine lacks, Prism shall fetch it from the remote with the machine's Git credentials into a clone that Prism keeps outside every checkout.

Rationale: Colleagues may hold different access to a private repository, so access must come from each person's own Git setup, and a clone outside checkouts keeps reference code out of the project's own files.

Related: [workspace-view.md§24](workspace-view.md#24)

<a id="7"></a>
## 7. Show a reference repository this machine cannot fetch

Pattern: Unwanted behavior

Disposition: Active

Requirement: If this machine cannot fetch a reference repository, then Prism shall mark that repository unavailable on this machine with Git's reason, every credential removed, and keep its entry and its last fetched commit.

Rationale: An entry is shared while access is per machine, so one colleague's missing access must show as unavailable for them rather than as an empty or removed repository.

Related: [reference-search.md§13](reference-search.md#13), [workspace-view.md§38](workspace-view.md#38)

<a id="8"></a>
## 8. Never write to a reference repository

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall not commit, push, tag, or create any branch or pull request in a reference repository.

Rationale: The workspace does not own a reference repository, and its team may not use Prism at all.

Related: n/a

<a id="9"></a>
## 9. Refuse a slice in a reference repository

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a design plans a slice whose component belongs to a reference repository, then Prism shall refuse the design before it is recorded and name the reference repository.

Rationale: Work that needs a change in a reference repository becomes an external dependency with an ask to its team, or the repository becomes worked on first.

Related: [work-item-pins.md§11](work-item-pins.md#11)

<a id="10"></a>
## 10. Keep reference content out of the store

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall record in the workspace's store no file content or index of a reference repository, only its name, remote, ref policy, note, components, and commit identifiers.

Rationale: The other team may not want its code copied into another team's store, and the store would grow with every reference repository's size.

Related: [reference-search.md§9](reference-search.md#9)

<a id="11"></a>
## 11. Propose a reference repository's components

Pattern: Event-driven

Disposition: Active

Requirement: When a person adds a reference repository whose root manifests list workspace members, Prism shall propose components derived from them, and record them in the store only after the person accepts the proposal.

Rationale: A reference repository commits no Prism declaration, so its components are an explicit second source beside each worked-on repository's committed declaration, and an unreviewed proposal must not become a boundary.

Related: [components.md§4](components.md#4)

<a id="12"></a>
## 12. Treat a reference repository without components as one component

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall treat a reference repository with no accepted components as one component named after the repository.

Rationale: A repository without workspace manifests, such as infrastructure code, still needs an identity that dependencies and citations can name.

Related: [components.md§4](components.md#4)

<a id="13"></a>
## 13. Check a dependency on a reference component

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a worked-on repository's component declaration depends on `<repository>/<component>` where the repository is a reference repository of the workspace and has no such component, then Prism shall refuse the declaration and name that repository's components.

Rationale: A reference entry makes the other repository's components known in the store, so a misspelled or removed dependency can be caught where today only its form is checked.

Related: [components.md§3](components.md#3)

<a id="14"></a>
## 14. Keep identity when a role changes

Pattern: Event-driven

Disposition: Active

Requirement: When a person changes a repository's role, Prism shall keep the repository's name and every pin, citation, and record that names it.

Rationale: A team that adopts Prism, or a repository the workspace starts working in, must not lose the history that already names it.

Related: [work-item-pins.md§1](work-item-pins.md#1)

<a id="15"></a>
## 15. Refuse to make a repository with unfinished work a reference

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a person changes a repository with an unfinished slice of an unshipped work item to the reference role, then Prism shall refuse the change and name those work items.

Rationale: A reference repository can hold no slices, so the change would strand work in progress.

Related: n/a

<a id="16"></a>
## 16. Refuse to remove a pinned reference repository

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a person removes a reference repository that an unshipped work item pins, then Prism shall refuse the removal and name those work items.

Rationale: The pinned work item's contract was planned against that repository and still needs to read it.

Related: [work-item-pins.md§1](work-item-pins.md#1)

<a id="17"></a>
## 17. Keep shipped citations readable after a removal

Pattern: Event-driven

Disposition: Active

Requirement: When a person removes a reference repository that no unshipped work item pins, Prism shall remove its entry and keep every shipped work item's pins and citations of it with their repository name, commit, and path.

Rationale: Shipped work is immutable history, and its citations must keep saying what it was built on.

Related: [shipped-history.md](shipped-history.md)

<a id="18"></a>
## 18. Recognize a peer Prism workspace

Pattern: Event-driven

Disposition: Active

Requirement: When a person adds a reference repository whose content is a Prism record store, Prism shall record it as a peer workspace and show it by the workspace name its roadmap records.

Rationale: Michael decided on 9 November 2026 that a peer team's store is read as an ordinary reference entry, without a separate federation feature, and its records are searched apart from its code.

Related: [reference-search.md§15](reference-search.md#15)

<a id="19"></a>
## 19. List each component's libraries

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall list for each component of a worked-on repository the third-party libraries its manifests depend on directly, each with the version its lockfile pins, derived from the committed files at the commit being read.

Rationale: Libraries are already declared by manifests and pinned by lockfiles, so deriving them needs no upkeep and always matches the version each component resolves.

Related: [reference-search.md§3](reference-search.md#3)

<a id="20"></a>
## 20. Mark a library its lockfile does not pin

Pattern: Unwanted behavior

Disposition: Active

Requirement: If no committed lockfile pins a version of a component's direct library, then Prism shall list that library as unpinned with the range its manifest gives.

Rationale: A version range does not say which code the component runs, so planning must see that the version is unknown.

Related: [work-item-pins.md§8](work-item-pins.md#8)

<a id="21"></a>
## 21. Show the workspace's repositories

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens a workspace's repositories page in the review app, the review app shall list each repository with its name, role, remote, and ref policy, and label as this machine's its fetched commit, last fetch time, access, and index status.

Rationale: Michael asked on 9 November 2026 for a workspace management view, and labelling per-machine state keeps a colleague from reading another machine's access or indexes as their own.

Related: [workspace-view.md§2](workspace-view.md#2), [workspace-view.md§39](workspace-view.md#39)

<a id="22"></a>
## 22. Show where each component is declared

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens a repository on the workspace page, the review app shall list its components and say for each whether it comes from that repository's committed configuration, naming the branch, or from the workspace's store.

Rationale: Worked-on repositories declare components in committed configuration and reference repositories in the store, so the page must say which source each component has.

Related: [workspace-view.md§25](workspace-view.md#25)

<a id="23"></a>
## 23. Show dependencies across repositories

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens the workspace page's dependencies, the review app shall show which component depends on which across every repository of the workspace, reference repositories included.

Rationale: Planning a change in a platform needs to see which components of other repositories use the interfaces it touches, and which it uses.

Related: [components.md§3](components.md#3)

<a id="24"></a>
## 24. Show libraries and their versions

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens the workspace page's libraries, the review app shall list each library with the components that use it and their pinned versions, and mark each library that components of the workspace pin at different versions.

Rationale: Two versions of one library in one workspace often explain a behavior difference, and a search answers each component from its own version.

Related: [reference-search.md§3](reference-search.md#3)

<a id="25"></a>
## 25. Change reference entries from the workspace page

Pattern: Event-driven

Disposition: Active

Requirement: When a person adds, edits, or removes a reference repository, its ref policy, note, components, or role on the workspace page, the review app shall apply the change through the review app's actions and write it to the workspace's store.

Rationale: The store owns reference entries, so the page can change them directly, and the generic actions keep each change revision-checked and visible to agents.

Related: [review-app-actions.md§1](review-app-actions.md#1)

<a id="26"></a>
## 26. Propose changes to a worked-on repository's declaration

Pattern: Event-driven

Disposition: Active

Requirement: When a person edits a worked-on repository's name or components on the workspace page, the review app shall show the change as an edit of that repository's `.prism/workflow.md` for the person to commit, and shall write it neither to the store nor to any checkout.

Rationale: Michael agreed on 9 November 2026 that what describes a repository's code stays committed with that code, so each branch and every agent reads the declaration that matches its commit.

Related: [components.md§3](components.md#3), [repository-names.md§1](repository-names.md#1)
