# Reference pins and citations on work items

Status: Approved
Created: 2026-11-11
Approved: 2026-11-11

## Problem

A design that reads a colleague's repository reads whatever commit happens to be current, so two slices of one contract can rest on different versions, and nothing records which version the contract was built on.
The outside facts a contract relies on are written only as prose, so when the other repository or a library moves on, nobody can tell which assumptions to check again.
A contract that needs a change in a repository the workspace does not work in has no way to say so, and the ask to the owning team lives outside Prism.
The person can change a work item's orchestration settings in the review app, but has no page that shows what the work item builds on.

## Goals

- Fix the exact commit of each reference repository that a work item reads, for the whole work item, and move it only on request with a report of what changed.
- Record each outside fact a contract relies on as a citation at a commit or version, so later changes can be checked against it.
- Let a contract name a change it needs in a reference repository and hand the person an ask for the owning team.
- Give each work item a settings page beside the workspace page that shows its orchestration settings and its pins.

## Non-goals

- Searching outside sources, which [reference-search.md](reference-search.md) owns.
- Declaring reference repositories and their ref policies, which [reference-repositories.md](reference-repositories.md) owns.
- Sending an ask to another team or tracking its answer in that team's tracker.
- Pinning library versions on work items, which each component's lockfile already pins.

## Design questions

- Which records hold pins, citations, and external dependencies, given that nested work items replace initiatives.
- How a citation names a symbol in a language without a symbol index.

<a id="1"></a>
## 1. Pin a reference repository on its first read

Pattern: Event-driven

Disposition: Active

Requirement: When an agent first reads a reference repository for a work item whose top work item pins no commit of it, Prism shall pin on the top work item the commit that the repository's ref policy gives at that moment, and answer from it.

Rationale: Michael decided on 9 November 2026 that a work item sets the version of each repository it builds on, so a contract and every slice under it read the same code.

Related: [reference-search.md§3](reference-search.md#3), [reference-repositories.md§5](reference-repositories.md#5)

<a id="2"></a>
## 2. Answer a whole work item tree from its top pins

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall answer every work item of a tree from the pins of its top work item and refuse a pin on any other work item of the tree.

Rationale: Two parts of one piece of work that read different versions of one repository would plan against each other without anyone noticing.

Related: n/a

<a id="3"></a>
## 3. Pin any commit the remote holds

Pattern: Event-driven

Disposition: Active

Requirement: When the person or the orchestrator pins a reference repository on a top work item at a named commit, Prism shall accept any commit reachable from the repository's remote, including one on a branch that its ref policy does not follow.

Rationale: Work often builds on an interface the other team is still finishing on a branch, and a commit is the same code on any branch.

Related: [reference-search.md§14](reference-search.md#14)

<a id="4"></a>
## 4. Move a pin only on request

Pattern: Event-driven

Disposition: Active

Requirement: When the person or the orchestrator moves a work item's pin to another commit, Prism shall record the old commit, the new commit, who moved it, and when, and shall never move a pin otherwise.

Rationale: A pin that followed the remote on its own would change the code under a contract while it is being built.

Related: n/a

<a id="5"></a>
## 5. Report what changed under the citations when a pin moves

Pattern: Event-driven

Disposition: Active

Requirement: When a work item's pin moves, Prism shall report in the same result each of the work item's citations of that repository whose file changed between the old and the new commit.

Rationale: The citations say which outside facts the contract relies on, so moving the pin is the moment to see which of them need checking again.

Related: [reference-search.md§12](reference-search.md#12)

<a id="6"></a>
## 6. Keep a shipped work item's pins

Pattern: Unwanted behavior

Disposition: Active

Requirement: If anyone sets or moves a pin of a shipped work item, then Prism shall refuse the change.

Rationale: A shipped work item is immutable history, and its pins must keep saying what it was built on.

Related: [shipped-history.md](shipped-history.md)

<a id="7"></a>
## 7. Record a citation of an outside fact

Pattern: Event-driven

Disposition: Active

Requirement: When an agent records that a work item's contract relies on a fact from a reference repository or a library, Prism shall record on the work item a citation that names the source, its commit or version, the path, and the symbol.

Rationale: A citation is a fact Prism witnesses at the moment a design relies on outside code, which no later similarity search can recover, and it is what the pin-move report and later checks compare against.

Related: [reference-search.md§5](reference-search.md#5)

<a id="8"></a>
## 8. Refuse a citation at an unknown version

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a citation names a reference repository commit other than the work item's pin, or a library that the citing component's lockfile does not pin, then Prism shall refuse the citation and name the pinned commit or say that the library is unpinned.

Rationale: A fact recorded against a version the work item does not build on, or against no known version, cannot be checked again when that version moves.

Related: [reference-repositories.md§20](reference-repositories.md#20)

<a id="9"></a>
## 9. Flag citations of a library whose version changed

Pattern: Event-driven

Disposition: Active

Requirement: When a component's lockfile pins a different version of a library that an unshipped work item cites, Prism shall show on that work item's attention each citation of the earlier version as needing a check.

Rationale: Libraries move through lockfile updates rather than pin moves, and the citation tells the person exactly which assumption the update may break.

Related: [reference-repositories.md§19](reference-repositories.md#19)

<a id="10"></a>
## 10. Show a work item's citations

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens a work item in the review app, the review app shall list its citations grouped by source, each with its commit or version, path, and symbol.

Rationale: The person reviewing a contract needs to see which outside code it rests on beside the contract itself.

Related: [review-app-places.md§26](review-app-places.md#26)

<a id="11"></a>
## 11. Record a change needed in a reference repository

Pattern: Event-driven

Disposition: Active

Requirement: When an agent records that a work item's contract needs a change in a reference repository, Prism shall record on the work item an open external dependency that names the repository, the needed change, and the pinned commit it was read at.

Rationale: Prism plans no slice in a reference repository, so the contract has to say what it waits for from the team that owns it.

Related: [reference-repositories.md§9](reference-repositories.md#9)

<a id="12"></a>
## 12. Draft an ask for the owning team

Pattern: Event-driven

Disposition: Active

Requirement: When Prism records an external dependency, Prism shall give the person a draft ask for the owning team that states the needed change, the commit it was read at, and why the work needs it, and shall not send it anywhere.

Rationale: The ask leaves the workspace and goes to people who do not have it, so the person decides whether and where to send it.

Related: n/a

<a id="13"></a>
## 13. Record a sent ask

Pattern: Event-driven

Disposition: Active

Requirement: When the person marks an external dependency's ask as sent and gives a link, Prism shall record the link and the time on the external dependency.

Rationale: The link keeps the dependency traceable to the other team's issue or message after the work item ships.

Related: n/a

<a id="14"></a>
## 14. Refuse to ship with an open external dependency

Pattern: Unwanted behavior

Disposition: Active

Requirement: If someone ships a work item while it has an external dependency that the person has not marked resolved or withdrawn, then Prism shall refuse the ship and name each such dependency.

Rationale: A work item that ships while waiting for another team's change may not work, and only the person knows whether that change has landed.

Related: [shipped-history.md](shipped-history.md)

<a id="15"></a>
## 15. Show a work item's settings page

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens a top work item's settings page in the review app, the review app shall show its orchestration settings and a row for each pin with the repository, the pinned commit, the ref it was taken from, and when it was set.

Rationale: Michael asked on 9 November 2026 for a work item settings view on par with the workspace page, holding the pins as well as the existing autonomy settings.

Related: [initiative-settings.md§1](initiative-settings.md#1), [reference-repositories.md§21](reference-repositories.md#21)

<a id="16"></a>
## 16. Move a pin from the settings page

Pattern: Event-driven

Disposition: Active

Requirement: When a person chooses to move a pin on a work item's settings page, the review app shall show the citations whose files changed between the pinned commit and the new one, and move the pin only after the person confirms.

Rationale: The person decides whether a newer version is safe to build on, and the changed citations are what that decision rests on.

Related: [review-app-actions.md§1](review-app-actions.md#1)

<a id="17"></a>
## 17. Show inherited pins on a part of a work item

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens the settings page of a work item that is not the top of its tree, the review app shall show the top work item's pins as inherited, without an action to change them, and link to the top work item.

Rationale: Pins belong to the whole tree, so a part of it can show what it builds on but cannot change it.

Related: n/a
