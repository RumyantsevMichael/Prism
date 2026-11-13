# Workspace view in the review app

Status: Approved
Created: 2026-11-10
Approved: 2026-11-10

## Problem

The review app's unit is one checkout folder, and every page reads that checkout's files.
Checkouts that share a record store merge into one "Shared records" entry in the project switcher, but opening it still opens one checkout and shows only what that checkout holds.
Store records such as the roadmap, initiatives, slices, claims, runs, and gates are already one set per store, and descriptive artifacts are moving into the store under workspace, repository, and component scopes, yet the app and agents see only the workspace scope and the scopes of the checkout they run in.
A person who wants to follow a workspace must first clone one of its code repositories, although the store alone holds the workspace's shared state.
An agent working in one repository cannot see a requirement that a teammate scoped to another repository of the same workspace.
Code-repository content, such as feature files, step definitions, frozen tests, user documentation, and source, is visible only in a checkout or on a Git host.
The app forgets idle projects past its recent-use limit, and the SSH and HTTPS spellings of one store remote give two separate clones.
Michael asked on 10 November 2026 for "an option to add a workspace to the app with no cloning any workspace repos but just using the workspace state repo URL", and that the "app should combine all artifacts from all components in the workspace" with no context selector between components or repositories.

## Goals

- Make the workspace, one record store, the review app's unit, with a project without a store as a workspace of one.
- Show every scope's artifacts of a workspace together, each labelled with its scope and narrowed only by a filter.
- Let agents read every scope's artifacts, while new artifacts keep their writer's scope.
- Add a workspace to the app from its store URL alone, cloning only the store.
- Show code-repository content inside Prism from every pushed branch, labelled by branch, without depending on any Git host.
- Keep a slice's verified files visible after a squash merge or force push, with no file bytes in records.
- Keep a store-only workspace in sync without an agent session.

## Non-goals

- A context selector that switches the app between repositories, components, checkouts, or branches.
- A second navigation beside the review app's places.
- Showing the content of unpushed or uncommitted work.
- Links to a Git host's pages in place of content shown in Prism.
- A code index or code search for a component that has no prepared index on this machine.
- Removing the frozen-test file bytes that frozen-test records hold today, which issue #176 tracks.
- Changing which artifacts live in the store and which stay in code repositories.

## Design questions

- Where the app reads a workspace's component declarations from when it holds no checkout, such as a registration in the store or each code clone's `.prism/workflow.md`, given that cross-repository runs need the same registration.
- How often the app fetches a workspace on its timer, and how it backs off while the store is unreachable.
- Which Git identity the app's own store commits for gate answers, comments, and approvals carry when no checkout names one.
- What listing size the artifact index must serve, and within what time, for the scale requirement to be testable.
- Where Prism keeps the code clones, how a person turns one on and off, and how much disk they may use.
- How an agent's read names a scope label, and which form the error takes when an unlabelled name matches several scopes.
- How Prism maps another scope's artifact into a checkout when that checkout configures no folder for the artifact's kind.
- How Prism finds a slice's squash commit at ship, and what it shows when neither the verified commit nor a squash commit exists.
- How the existing "Shared records" entries and checkout-keyed tab URLs move to workspaces and store identities in one step.
- How the app's last-synced copy for an unreachable store relates to [workspace-artifacts.md§15](workspace-artifacts.md#15), which refuses artifact operations when the configured store is unavailable.
- How a store whose artifacts have not yet moved into scope folders appears in the combined view.

<a id="1"></a>
## 1. List workspaces in the switcher

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall list in its project switcher one entry for each workspace, counting every checkout and added store that names one record store as one workspace and each project without a record store as a workspace of its own.

Rationale: Michael agreed on 10 November 2026 that the app's unit is the workspace, one store, and that standalone projects keep working as workspaces of one.
This amends [single-review-app.md§3](single-review-app.md#3), whose switcher lists projects and opens one project's review context.

Related: [single-review-app.md§3](single-review-app.md#3), [single-review-app.md§2](single-review-app.md#2), [shared-record-store.md§17](shared-record-store.md#17)

<a id="2"></a>
## 2. Show repositories and checkouts only as information

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show a workspace's repositories and this machine's checkouts of them as information about the workspace, without offering to open a repository, component, or checkout as a separate context.

Rationale: Michael said on 10 November 2026 that a context selector "should not allow to switch between workspace components/repos because it does not make sense", and agreed that the switcher lists workspaces only.

Related: [workspace-view.md§1](#1), [repository-names.md§9](repository-names.md#9)

<a id="3"></a>
## 3. Combine every scope's artifacts

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show the artifacts of every scope of a workspace, the workspace, each repository, and each component, together in one store tree, and label each artifact with its scope.

Rationale: Michael asked on 10 November 2026 that the app combine all artifacts from all components in the workspace, and agreed that store artifacts are one shared tree that carries scope labels and no branch labels.
This supersedes, for the review browser, [workspace-artifacts.md§4](workspace-artifacts.md#4), which shows only the workspace scope and the opening checkout's repository and component scopes; the workspace-artifacts thread agreed to ship as designed and amend it here.

Related: [workspace-artifacts.md§3](workspace-artifacts.md#3), [workspace-artifacts.md§4](workspace-artifacts.md#4)

<a id="4"></a>
## 4. Filter artifacts by scope

Pattern: Event-driven

Disposition: Active

Requirement: When a person selects scopes in the review app's scope filter, the review app shall show only the artifacts of the selected scopes until the person changes the filter, without changing the workspace it shows.

Rationale: Michael agreed on 10 November 2026 that scopes narrow the view as a filter and never as a context.

Related: [workspace-view.md§3](#3)

<a id="5"></a>
## 5. Address artifacts by store location

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall identify each store artifact in its pages, links, and URLs by its store location of scope, kind, and the rest of its path, and never by a checkout's path.

Rationale: Michael agreed on 10 November 2026 that artifacts are addressed by store identity, because a store-only workspace has no checkout and two checkouts place one artifact at different paths.

Related: [workspace-artifacts.md§9](workspace-artifacts.md#9), [shared-record-store.md§3](shared-record-store.md#3)

<a id="6"></a>
## 6. Let agents read every scope

Pattern: Event-driven

Disposition: Active

Requirement: When an agent lists or searches a workspace's store artifacts from any checkout, Prism shall include the artifacts of every scope of the workspace, each labelled with its scope.

Rationale: Michael agreed on 10 November 2026 that agents see every scope without a scope filter, because a frontend agent needs requirements that a backend developer scoped to the backend repository.
This supersedes, for agents, [workspace-artifacts.md§4](workspace-artifacts.md#4), which lists only the workspace scope and the checkout's own repository and component scopes.

Related: [workspace-artifacts.md§4](workspace-artifacts.md#4), [workspace-view.md§3](#3)

<a id="7"></a>
## 7. Keep the writer's scope for new artifacts

Pattern: Event-driven

Disposition: Active

Requirement: When an agent creates a store artifact without naming a scope, Prism shall give the artifact the scope of the agent's own checkout, as the artifact's kind defines it.

Rationale: Michael agreed on 10 November 2026 that reading every scope does not change where new artifacts go, so a slice plan still belongs to the repository that writes it.

Related: [workspace-artifacts.md§3](workspace-artifacts.md#3), [workspace-view.md§6](#6)

<a id="8"></a>
## 8. Read an artifact by scope label

Pattern: Event-driven

Disposition: Active

Requirement: When an agent reads a store artifact and names a scope label, Prism shall return the artifact at that location in the named scope.

Rationale: Michael agreed on 10 November 2026 that reads accept a scope label, because same-name artifacts in several repositories, such as two repositories' `plans/<initiative>/slice.md`, become common once agents see every scope.

Related: [workspace-view.md§6](#6), [workspace-view.md§9](#9)

<a id="9"></a>
## 9. Refuse an ambiguous artifact read

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an agent reads a store artifact without a scope label and more than one scope holds an artifact at that kind and path, then Prism shall refuse the read and name each matching scope.

Rationale: A silent choice between two repositories' same-name artifacts would let an agent design against the wrong one.

Related: [workspace-view.md§8](#8)

<a id="10"></a>
## 10. Map another scope's artifact into a checkout

Pattern: Event-driven

Disposition: Active

Requirement: When Prism reports a store artifact of another scope to an agent as a checkout path, Prism shall form that path from the artifact's kind and the rest of its store location through the folder that the agent's checkout configures for that kind.

Rationale: Michael agreed on 10 November 2026 that another scope's artifacts map into an agent's checkout paths by kind and rest through that checkout's configured folders, so each agent keeps the paths its own configuration names.

Related: [workspace-view.md§5](#5), [workspace-view.md§6](#6)

<a id="11"></a>
## 11. Add a workspace from its store URL

Pattern: Event-driven

Disposition: Active

Requirement: When a person adds a workspace to the review app by an HTTPS, SSH, or folder URL of its record store, the review app shall clone only the store, with the machine's Git credentials, into the managed clone folder that checkouts naming the same store share, and list the workspace in the switcher.

Rationale: Michael asked on 10 November 2026 for an option to add a workspace without cloning any workspace repository, using only the store URL, and agreed that the clone is the one checkouts of the same store already use.

Related: [shared-record-store.md§17](shared-record-store.md#17), [workspace-view.md§1](#1)

<a id="12"></a>
## 12. Refuse a store URL that carries credentials

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a store URL that a person enters to add a workspace contains a user name, password, or token, then the review app shall refuse it before cloning and say that credentials come from the machine's Git configuration.

Rationale: Michael agreed on 10 November 2026 to refuse such URLs, so no credential reaches the app's records, logs, or the managed clone's remote.

Related: [shared-record-store.md§15](shared-record-store.md#15)

<a id="13"></a>
## 13. Keep nothing from a failed clone

Pattern: Unwanted behavior

Disposition: Active

Requirement: If cloning an added workspace's store fails, then the review app shall show Git's reason with every credential removed, keep no clone folder or workspace entry, and leave a folder it did not create unchanged.

Rationale: Michael agreed on 10 November 2026 that a failure shows Git's reason and keeps nothing, so a person can correct the URL or their access and retry.

Related: [shared-record-store.md§18](shared-record-store.md#18)

<a id="14"></a>
## 14. Confirm a new workspace from an empty store

Pattern: Event-driven

Disposition: Active

Requirement: When the store repository of an added workspace holds no commits, the review app shall list it as a new workspace only after the person confirms that they want to start one there.

Rationale: Michael agreed on 10 November 2026 that an empty repository becomes a new workspace only after confirmation, because a mistyped URL to an empty repository should not start a workspace silently.

Related: [workspace-view.md§11](#11)

<a id="15"></a>
## 15. Name an added workspace from its store

Pattern: Event-driven

Disposition: Active

Requirement: When the review app lists an added workspace, the review app shall name it by the workspace name that the store's roadmap records, or by the store repository's name when the roadmap records none.

Rationale: Michael agreed on 10 November 2026 that the name comes from the store, so every machine shows the same workspace name.

Related: [workspace-view.md§1](#1)

<a id="16"></a>
## 16. Keep an added workspace until it is removed

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall keep each added workspace in its switcher until the person removes it, regardless of how long ago it was last used.

Rationale: Michael agreed on 10 November 2026 that an added workspace is never dropped by recency, because no session registers a store-only workspace again.

Related: [single-review-app.md§3](single-review-app.md#3)

<a id="17"></a>
## 17. Remove an added workspace safely

Pattern: Event-driven

Disposition: Active

Requirement: When a person removes an added workspace, the review app shall delete the store clone only when no checkout on this machine names that store and the clone holds no unpushed change, and otherwise remove only the workspace entry and say why the clone stays.

Rationale: Michael agreed on 10 November 2026 that removal deletes the clone only when nothing else on the machine uses it and no work would be lost.

Related: [repository-names.md§9](repository-names.md#9), [shared-record-store.md§17](shared-record-store.md#17)

<a id="18"></a>
## 18. Treat SSH and HTTPS spellings as one store

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall identify a record store named by a network URL by its host and path, so that its SSH and HTTPS spellings share one clone and one workspace entry.

Rationale: Michael agreed on 10 November 2026 that one store spelled by SSH and by HTTPS is one store; today the managed clone folder's name hashes the whole URL including its scheme, so the two spellings give two clones.

Related: [shared-record-store.md§17](shared-record-store.md#17), [workspace-view.md§1](#1)

<a id="19"></a>
## 19. Match an SSH host alias by root commit

Pattern: Event-driven

Disposition: Active

Requirement: When a newly cloned store has the same root commit as a store that Prism already keeps on this machine under another host, Prism shall reuse the existing clone, remove the new one, and list both URLs under one workspace.

Rationale: Michael agreed on 10 November 2026 that SSH host aliases from the user's SSH configuration are matched by the store's root commit after the clone, because the alias hides the real host.

Related: [workspace-view.md§18](#18), [repository-names.md§4](repository-names.md#4)

<a id="20"></a>
## 20. Fetch a workspace without a session

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens a workspace in the review app, and again on a timer while it stays open, the review app shall fetch and merge the store's upstream.

Rationale: Michael agreed on 10 November 2026 that the app syncs a workspace by itself, because a store-only workspace has no agent session whose reads would fetch it.

Related: [shared-record-store.md§8](shared-record-store.md#8)

<a id="21"></a>
## 21. Push the app's own writes

Pattern: Event-driven

Disposition: Active

Requirement: When the review app writes a gate answer, comment, or approval to a workspace's store, the review app shall commit and push it as Prism does for a record write.

Rationale: Michael agreed on 10 November 2026 that the app pushes its own writes, so teammates and agents see a person's answer without waiting for an agent session on this machine.

Related: [shared-record-store.md§7](shared-record-store.md#7), [workspace-artifacts.md§13](workspace-artifacts.md#13)

<a id="22"></a>
## 22. Show the last synced copy of an unreachable store

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a workspace's store upstream cannot be reached, then the review app shall show the workspace from its last synced copy together with the time of that sync.

Rationale: Michael agreed on 10 November 2026 that an unreachable store shows the last synced copy with its time, so a person can still read the workspace offline and knows how current it is.

Related: [shared-record-store.md§9](shared-record-store.md#9), [shared-record-store.md§10](shared-record-store.md#10), [workspace-artifacts.md§15](workspace-artifacts.md#15)

<a id="23"></a>
## 23. Show code-repository content in Prism

Pattern: Optional feature

Disposition: Active

Requirement: Where a person has turned on code content for a repository of a workspace, the review app shall show that repository's feature files, step definitions, frozen tests, user documentation, and source in its own pages, from a clone that Prism keeps, without linking to or depending on any Git host's pages.

Rationale: Michael agreed on 10 November 2026 that code-repository content is shown in Prism itself and relies on nothing host-specific, so the view works for every Git host and for store-only workspaces.

Related: [workspace-artifacts.md§2](workspace-artifacts.md#2)

<a id="24"></a>
## 24. Keep a full-history code clone per repository

Pattern: Optional feature

Disposition: Active

Requirement: Where a person has turned on code content for a repository, Prism shall keep one clone of that repository on the machine with its full history and every remote branch, fetching a file's contents only when someone opens it.

Rationale: Michael agreed on 10 November 2026 to one blobless clone per repository, turned on per repository, so history and branches are complete while disk use stays proportional to what people open.

Related: [workspace-view.md§23](#23)

<a id="25"></a>
## 25. Label code content by branch

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository's code content is turned on, the review app shall show its files and component declarations from every pushed branch, each labelled with its branch, without asking the person to choose a branch.

Rationale: Michael agreed on 10 November 2026 that branches are labelled, not chosen, and said "I don't want prism to only show one branch's state".

Related: [workspace-view.md§24](#24), [components.md§3](components.md#3)

<a id="26"></a>
## 26. Drop a removed branch's component declarations

Pattern: Event-driven

Disposition: Active

Requirement: When a fetch finds that a branch has left a repository's remote, Prism shall stop showing the component declarations that only that branch held.

Rationale: Michael agreed on 10 November 2026 that a branch's component declarations are dropped once the branch leaves the remote, so merged or abandoned branches do not leave phantom components.

Related: [workspace-view.md§25](#25)

<a id="27"></a>
## 27. Record each verified file's blob hash

Pattern: Event-driven

Disposition: Active

Requirement: When Prism records a slice's verification run, Prism shall record the Git blob hash of each file of the slice, and no file bytes, beside the verified commit.

Rationale: Michael agreed on 10 November 2026 that verification records blob hashes rather than bytes and that no file bytes go into state; the frozen-test bytes that frozen-test records already hold stay as they are under issue #176.

Related: [shared-record-store.md§14](shared-record-store.md#14), [workspace-view.md§28](#28)

<a id="28"></a>
## 28. Show a slice's files at its verified commit

Pattern: State-driven

Disposition: Active

Requirement: While a slice's verified commit exists in its repository's code clone, the review app shall show the slice's files at that commit.

Rationale: Michael agreed on 10 November 2026 that a slice's files are shown at its verified commit while it exists, so a reviewer sees exactly what passed verification.

Related: [shared-record-store.md§16](shared-record-store.md#16), [workspace-view.md§24](#24)

<a id="29"></a>
## 29. Record the squash commit at ship

Pattern: Event-driven

Disposition: Active

Requirement: When an initiative ships, Prism shall record for each slice the commit of its repository's default branch that holds the slice's verified files.

Rationale: Michael agreed on 10 November 2026 that Prism records the squash commit at ship, because a squash merge or force push removes the verified commit from the remote.

Related: [workspace-view.md§30](#30), [workspace-artifacts.md§12](workspace-artifacts.md#12)

<a id="30"></a>
## 30. Fall back to the squash commit

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a slice's verified commit no longer exists in its repository's code clone, then the review app shall show the slice's files at the commit recorded at ship.

Rationale: Michael agreed on 10 November 2026 that the file is shown at the squash commit when the verified commit is gone.

Related: [workspace-view.md§28](#28), [workspace-view.md§29](#29)

<a id="31"></a>
## 31. Say whether a file still matches verification

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens a slice in the review app, the review app shall mark each slice file it shows as "same as verified" when its blob hash equals the recorded one, and as "changed after verification" otherwise.

Rationale: Michael agreed on 10 November 2026 that the slice page states whether each file is the verified one, which the blob hashes prove without file bytes.

Related: [workspace-view.md§27](#27), [workspace-view.md§30](#30)

<a id="32"></a>
## 32. Show unpushed work only as presence

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show work that is unpushed or uncommitted only as its presence, naming its branch and host from claims and verification runs, and never its content.

Rationale: Michael agreed on 10 November 2026 that such work appears only as, for example, "in progress in feature-x on <host>, not pushed", because its content exists only on the machine that holds it.

Related: [shared-record-store.md§25](shared-record-store.md#25), [shared-record-store.md§14](shared-record-store.md#14)

<a id="33"></a>
## 33. Search the whole workspace in Knowledge

Pattern: Event-driven

Disposition: Active

Requirement: When a person searches in the review app's Knowledge place, the review app shall search the store artifacts of every scope and the code of each component that has a prepared index on this machine, and name each component that the search left out.

Rationale: Michael agreed on 10 November 2026 that code index and search stay per checkout and per component, while workspace search covers store artifacts everywhere and says which components it left out.

Related: [components.md§20](components.md#20), [components.md§26](components.md#26)

<a id="34"></a>
## 34. Offer checkout actions only with a checkout

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall offer an action that needs a checkout, such as an index rebuild or a verification, only for a repository that has a checkout on this machine.

Rationale: Michael agreed on 10 November 2026 that checkout-only actions appear only where a checkout exists, so a store-only workspace offers no action it cannot run.

Related: [repository-names.md§9](repository-names.md#9)

<a id="35"></a>
## 35. Resolve Markdown links by store location

Pattern: Event-driven

Disposition: Active

Requirement: When the review app renders a store artifact's Markdown, the review app shall resolve each relative link against the artifact's store location and report each link that resolves to no artifact or file.

Rationale: Michael agreed on 10 November 2026 that links resolve against the artifact's store location, because no checkout path exists in a store-only workspace, and that unresolved links are reported.

Related: [workspace-view.md§5](#5)

<a id="36"></a>
## 36. Move open tabs to store identities once

Pattern: Event-driven

Disposition: Active

Requirement: When the review app first opens after this capability ships, the review app shall move each open tab and saved URL that names a checkout's artifact to the artifact's store identity, once.

Rationale: Michael agreed on 10 November 2026 that open tabs and URLs move once to store identities, so a person keeps their place across the change.

Related: [workspace-view.md§5](#5)

<a id="37"></a>
## 37. List artifacts without walking the store

Pattern: Event-driven

Disposition: Active

Requirement: When a person or agent lists a workspace's artifacts, Prism shall answer from an index that it refreshes at each sync, without reading every artifact in the store for that request.

Rationale: Michael agreed on 10 November 2026 that listing must scale through an index per sync, because combining every scope makes a per-request walk of the store grow with the whole workspace.

Related: [workspace-view.md§3](#3), [workspace-view.md§6](#6)

<a id="38"></a>
## 38. Accept store access without code access

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a person can read a workspace's store but cannot fetch one of its code repositories, then the review app shall show the workspace's store content and name each repository whose code it cannot reach.

Rationale: Michael agreed on 10 November 2026 that store access without code access is accepted, so a reviewer can follow requirements and progress without access to every repository.

Related: [workspace-view.md§23](#23)

<a id="39"></a>
## 39. Build on the places navigation and the UI kit

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall present every workspace page within its places navigation, such as Work, Attention, Roadmap, and Knowledge, and compose it from the review app's UI kit elements and design values.

Rationale: The approved places navigation is the app's only navigation, and Michael's rule of 10 November 2026 is that review app UI uses and extends the UI kit.

Related: [review-app-ui-kit.md](review-app-ui-kit.md)
