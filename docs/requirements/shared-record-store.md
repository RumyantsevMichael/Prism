# Shared record store

Status: Draft
Created: 2026-11-02
Approved: n/a

## Problem

Prism keeps its machine records under each checkout's `.prism` folder, so work started in one linked worktree, clone, colleague's machine, or cloud session is invisible to every other checkout.
Records committed with a branch reach others only when the branch merges, which is too late for people who work on one initiative together.
Michael and his colleagues use Prism across many repositories and machines, so a shared, affordable state that any Git workflow can host is the prerequisite for collaboration and for later multi-repository work.

## Goals

- Let every checkout of a project read and write one set of machine records.
- Share those records between machines through an ordinary Git repository, without anyone running Git in it by hand.
- Never lose record bytes to a sync, a migration, or a concurrent change, and tell the agent whose change did not land.
- Keep unrelated concurrent changes, such as two people working on different initiatives or slices, from colliding.
- Keep two agents from working on the same slice, while independent slices of one initiative stay open to parallel work.
- Show, for each verified slice, which repository, branch, and commit its result came from, now that records no longer travel with a branch.

## Non-goals

- A hosted server or API for records.
- Moving feature files, tests, or other artifacts that code or verification consumes out of the project repository.
- Contracts or slices that span several repositories.
- Pull request numbers or any other data that needs access to a Git host's API.
- Real-time sync between machines.

## Design questions

- Whether draft human documents, such as Proposed ADRs and Draft requirements, live in the store and move into the project when accepted.
- Which committed identity names a repository once one store serves several repositories.
- Whether append-only event records replace whole-record merges if merge units prove too coarse in use.
- How a cloud session that may push only its own branch shares its records.

<a id="1"></a>
## 1. Use the configured record store

Pattern: Optional feature

Disposition: Active

Requirement: Where a project's workflow configuration names a record store, Prism shall read and write the project's machine records in that store for every checkout whose configuration names it.

Rationale: One store per project is what makes work in one checkout visible in every other.

Related: [external-record-store.md](../ADRs/workflow-records/external-record-store.md)

<a id="2"></a>
## 2. Refuse an unusable store

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the record store path that the configuration names is missing, is not a folder, lies inside the project, or contains the project, then Prism shall refuse every record operation with an error that names the configured and resolved locations, without creating the store or using the project's `.prism` folder instead.

Rationale: A silent fallback or a store created from a typo would split state between checkouts without notice.

Related: [§1](#1), [§17](#17)

<a id="3"></a>
## 3. Keep record addresses stable

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall name each machine record by the same `.prism` address in tool inputs, tool results, stored references, and review browser links, whether or not a record store holds it.

Rationale: Stable addresses keep tools, gates, and links working when a project starts or stops using a store.

Related: [§1](#1)

<a id="4"></a>
## 4. Move existing records into the store once

Pattern: Event-driven

Disposition: Active

Requirement: When a checkout first accesses a record store, Prism shall move into the store each of the checkout's existing records that no earlier checkout has moved, and report the moved records in that tool result.

Rationale: Records that existed before the store must join it, and each record must join only once.

Related: [§5](#5), [§6](#6)

<a id="5"></a>
## 5. Keep removed records removed

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a record that a checkout once moved into the store has since been removed from it, then Prism shall not copy that record into the store again from any checkout, including shallow clones and forks.

Rationale: Committed records exist in every checkout, so repeating a move would bring back initiatives that people removed.

Related: [§4](#4)

<a id="6"></a>
## 6. Keep both copies of a differing record

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a checkout's existing record differs from the store's record at the same address, then Prism shall keep the store's record, leave the checkout's copy in place, and report the conflict.

Rationale: A migration must never overwrite shared work.

Related: [§4](#4)

<a id="7"></a>
## 7. Sync record changes after a write

Pattern: Optional feature

Disposition: Active

Requirement: Where store sync is on and the store is a Git checkout with an upstream, when a record write completes, Prism shall commit the change, merge the upstream, and push within seconds, without rewriting the store's history or changing the user's Git configuration.

Rationale: Colleagues see each other's records without running Git by hand, and nothing they already pushed is rewritten.

Related: [record-store-git-sync.md](../ADRs/workflow-records/record-store-git-sync.md)

<a id="8"></a>
## 8. Pull changes without delaying reads

Pattern: Optional feature

Disposition: Active

Requirement: Where store sync is on, when a record is read and the store last fetched its upstream more than 30 seconds earlier, Prism shall fetch and merge the upstream in the background without delaying the read.

Rationale: Records from other machines arrive while an agent only reads, and a slow network never blocks local work.

Related: [§7](#7)

<a id="9"></a>
## 9. Keep working when sync fails

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Git, the network, or the upstream is unavailable during a sync, then Prism shall keep record reads and writes working locally and record why the sync failed.

Rationale: A sync problem must never stop or corrupt local work.

Related: [§10](#10)

<a id="10"></a>
## 10. Show an unsuccessful sync

Pattern: State-driven

Disposition: Active

Requirement: While the store's last sync did not succeed, the review browser shall show the sync state.

Rationale: People need to notice records that stay local or changes that were set aside.

Related: [§9](#9), [§13](#13)

<a id="11"></a>
## 11. Merge unrelated concurrent changes

Pattern: Event-driven

Disposition: Active

Requirement: When a sync finds that the local store and its upstream changed different initiatives of the roadmap, or different slices or proposals of one initiative, Prism shall keep both changes and the history of both.

Rationale: Two people working on different parts of one record must not set each other's work aside.

Related: [§12](#12)

<a id="12"></a>
## 12. Keep the first pushed version of an overlapping change

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a sync finds that the local store and its upstream changed the same initiative, slice, or other merge unit differently, or that the merged record would be invalid, then Prism shall keep the upstream record and save the local record's bytes in the store.

Rationale: The first push wins as a stale revision does, and no bytes are lost.

Related: [§11](#11), [§13](#13)

<a id="13"></a>
## 13. Tell the agent whose change was set aside

Pattern: Event-driven

Disposition: Active

Requirement: When a sync saves a local record's bytes because the upstream changed the same record, Prism shall name the record and the saved copy once in the next tool result of each Prism server that uses the store.

Rationale: The agent that made the change can redo it, instead of believing it landed.

Related: [§12](#12)

<a id="14"></a>
## 14. Record where verified code lives

Pattern: Event-driven

Disposition: Active

Requirement: When Prism records a verification run or a contract defect, Prism shall record the checkout's repository, origin remote, branch, head commit, and whether its work tree had uncommitted changes, and record each value it cannot determine as unknown.

Rationale: Records in a shared store no longer travel with a branch, so a reader needs another way to find the code a result describes.

Related: [code-links.md](../ADRs/workflow-records/code-links.md)

<a id="15"></a>
## 15. Never store remote credentials

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall record only the scheme, host, and path of a checkout's network remote, and no user name, password, token, query, fragment, or local path.

Rationale: The shared store is read by everyone who can clone it.

Related: [§14](#14)

<a id="16"></a>
## 16. Show the latest passing code location

Pattern: Event-driven

Disposition: Active

Requirement: When a person or agent reads an initiative or opens a slice in the review browser, Prism shall show the repository, branch, and commit of each slice's latest passing verification run.

Rationale: The code location is useful only where people already look at slice results.

Related: [§14](#14)

<a id="17"></a>
## 17. Clone a store named by its remote

Pattern: Optional feature

Disposition: Active

Requirement: Where a project's workflow configuration names the record store by a Git remote, when a record access finds no clone of that remote on the machine, Prism shall clone it once into the host's plugin data directory, share that clone with every checkout on the machine whose configuration names the same remote, and sync it unless store sync is off.

Rationale: No checkout then has to agree on a store folder or clone it by hand, and every machine and cloud session finds the same records from the configuration alone.

Related: [§1](#1), [§7](#7), [§18](#18)

<a id="18"></a>
## 18. Refuse an unusable remote store

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a store named by its remote has no plugin data directory to live in, cannot be cloned, or finds another repository's clone at its clone path, then Prism shall refuse every record operation with an error that names the remote without its user information, leave no partial clone, and leave a folder it did not create unchanged.

Rationale: A failed or misdirected clone must neither split state between checkouts nor touch a folder that holds someone else's work.

Related: [§2](#2), [§15](#15), [§17](#17)

<a id="19"></a>
## 19. Claim a slice before work starts

Pattern: Event-driven

Disposition: Active

Requirement: When an agent starts a slice or starts the design of a scope, Prism shall record for that slice, apart from the initiative record, a claim that names the Prism server holding it, a label with the store's Git user name and the host name, the activity, and its expiry.

Rationale: A claim in the records that every checkout shares is what lets every other agent see that the slice is taken, and keeping it apart from the initiative record keeps its renewals from colliding with other changes to the slice.

Related: [slice-claims.md](../ADRs/workflow-records/slice-claims.md), [§20](#20)

<a id="20"></a>
## 20. Refuse a start that another holder's claim covers

Pattern: Unwanted behavior

Disposition: Active

Requirement: If another holder's live claim is on the slice, one of its ancestors, or one of its descendants, then Prism shall refuse the start before changing anything and name that claim's label, activity, and expiry.

Rationale: Work must stop before it begins, and the person needs to know whom to ask.

Related: [§19](#19)

<a id="21"></a>
## 21. Confirm a claim with the store's remote

Pattern: Optional feature

Disposition: Active

Requirement: Where store sync is on and the store has an upstream, when an update takes or releases a claim, Prism shall sync the claim before it applies the rest of the update, and refuse the update without applying any of its operations when another machine's claim or renewal won that sync.

Rationale: Two machines that both believe they started a slice are the failure that claims exist to prevent.

Related: [§12](#12), [§22](#22)

<a id="22"></a>
## 22. Refuse a claim that cannot be confirmed

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the store's remote cannot be reached while a claim is confirmed, then Prism shall refuse the update, withdraw the claim, and apply none of the update's other operations.

Rationale: A claim that no other machine can see would let two machines start the same slice.

Related: [§9](#9), [§21](#21)

<a id="23"></a>
## 23. Keep a claim while its holder runs

Pattern: State-driven

Disposition: Active

Requirement: While a Prism server holds a live claim, Prism shall renew the claim every 10 minutes, treat it as expired 30 minutes after its last renewal by the local clock, never renew a claim that expired or that another holder replaced or released, and name the expired holder when another holder replaces it.

Rationale: A slice whose agent stopped becomes free without a person's help, a running agent never loses its slice, and a machine that slept through its lease never takes back a slice that someone else took.

Related: [§19](#19)

<a id="24"></a>
## 24. End a claim

Pattern: Event-driven

Disposition: Active

Requirement: When a claimed slice leaves `in-progress`, its scope's design proposal is accepted, or anyone releases the claim, Prism shall end the claim, and for a release record who released whose claim.

Rationale: Finished or abandoned work frees its slice, and a person can free a slice by hand with a trace of who did.

Related: [§19](#19)

<a id="25"></a>
## 25. Show live claims

Pattern: Event-driven

Disposition: Active

Requirement: When a person or agent reads an initiative, Prism shall show each live claim's label, activity, and expiry, and tell the server that lost a claim since its last read of the initiative that the claim was lost.

Rationale: People and agents choose other work by seeing who works on what, and an agent whose claim lapsed or was released learns that it no longer holds the slice.

Related: [§19](#19)
