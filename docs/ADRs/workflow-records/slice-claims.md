# Claim a slice before working on it

Status: Proposed
Created: 2026-11-03

## Requirements

No Approved requirement governs this decision yet.
The Draft [shared record store requirements](../../requirements/shared-record-store.md) §19-§28 describe the behavior it implements.
It records the fifth increment of the multi-repository roadmap milestone, which the user approved.

## Problem

Two agents, in one checkout, in two worktrees, or on two machines that share a [record store](external-record-store.md), can start the same slice, and neither learns of the other until their changes meet.
The [structural merge](record-store-git-sync.md) makes the race silent: two machines that set the same slice `in-progress` make the same change, so the merge takes it and both agents believe they started the slice.
Two agents must still be able to work on two independent slices of one initiative at once.
The coordination state's active operations refuse a second start, but the orchestrator does not use them, so they are not where work starts.
A claim checked only when work starts does not stop work that never started that way: an agent whose claim lapsed or was released keeps reviewing, verifying, or redesigning the slice, and a review, design, or implementation run on its own takes no claim at all.

## Decision

A slice MUST have at most one holder at a time across every checkout and machine that shares its initiative's records.
A holder MUST be one host session, named by a digest of the session identifier the host gives the Prism server, or, when the host gives none, one Prism server process, named by a random identifier.
A tool call's host session MUST be read from its metadata as `sessionId`, or, where an older Codex sends only that, as `session_id` of `x-codex-turn-metadata`, before the server's environment, and never from `threadId`, which names a sub-agent's own thread.
A holder MUST be labeled for people with the Git user name of the folder that holds the records, when set, and the host name without its domain.
A server MUST renew a live claim of its own holder that it finds on an initiative read or update and does not renew yet.
Each claim MUST be a record of its own beside the initiative record, one per claimed slice, and MUST record the slice, its holder, label, activity (`design` or `implementation`), when it was claimed, when it was last renewed, when it expires, and a random nonce of the attempt that took it.
A claim MAY record the name of the harness its holder runs in, such as Claude Code or Codex, which Prism MUST only show to people and MUST NOT use to decide whether a claim blocks, renews, or ends.
A claim reader MUST leave out a field it does not know instead of refusing the claim, so a field that a later release adds never hides a claim.
A new optional claim field MUST be read in one release and written only from a later one, because releases up to 0.20 refuse a claim with an unknown field, ignore the whole claim, and can take the slice it covers.
Claim records MUST NOT have a structural merge: two machines that write the same claim record conflict, the upstream version wins, and the first push holds the slice.
Starting a slice MUST take an implementation claim, and design MUST take a design claim on its scope before it starts.
A `claim` of a slice that is `in-progress` MUST take an implementation claim, and of any other slice a design claim.
An agent's tool call that works on a slice MUST be refused with `claim_required`, before it changes anything, unless a live claim of the caller's holder is on the slice or an ancestor: proposing or accepting a design, restoring frozen tests, reporting contract defects, moving a slice out of `in-progress`, verifying a slice, and writing its review, change map, or design view.
The refusal MUST say whether the caller's own claim expired or no claim covers the slice, and MUST name the claim operation that takes it.
Any other agent tool call that changes a slice MUST be refused with `slice_claimed` while another holder's live claim covers the slice.
Creating an initiative, taking or releasing a claim, and a dependents' run, which checks a scope whose leaves are all done, MUST NOT need a claim, and an operation MAY work on a slice that an earlier operation of the same update claims or starts.
A slug that only a pending design proposal creates MUST be judged by its scope's claim.
The check MUST read the local records when the call starts and MUST NOT wait for a sync.
A claim MUST cover the slice's descendants, so a claim MUST be refused while another holder's live claim is on the slice, an ancestor, or a descendant, and the refusal MUST name that claim's label, activity, and expiry.
An expired claim MUST be replaced, and the result MUST name its holder.
An update that takes or releases claims MUST be checked as a whole before anything is written, and then MUST write its claim records before any other change.
Where store sync is on, that update MUST wait for a sync of its own and MUST confirm that each claim record still holds its attempt's nonce, or that each released claim record is still absent.
When another holder won, the update MUST be refused with `slice_claimed` naming the winner; when the remote cannot be reached, it MUST be refused with `claim_unconfirmed`; a refusal MUST undo only this attempt's claim records and MUST apply nothing else.
Without sync or without an upstream, a claim MUST be confirmed locally.
After confirmation the rest of the update MUST be written with the caller's revision, and a failure there MUST undo the update's claim records.
The holder MUST renew its claims every 10 minutes while it runs, without any agent action, by rewriting only each claim record while the claim is live and still holds its nonce.
An expired, released, or replaced claim MUST NOT be renewed, and the holder MUST report it as lost on its next tool result for that initiative.
A claim MUST end when its slice leaves `in-progress`, when its scope's design proposal is accepted, or when anyone releases it, and a release MUST record in the initiative's history who released whose claim.
Lease checks MUST use the local clock of the machine that makes them.
Initiative records MUST keep their shape, so records written before claims read and write as before.

## Rationale

A claim record of its own changes only when a claim does, so renewals never touch the initiative record: other machines' edits of a claimed slice merge as before, and agents get no `revision_conflict` from a renewal.
Without a structural merge, two claims of one slice conflict as whole files and the upstream wins, which is exactly first push wins; two claims of independent slices are different files and both survive.
A claim that returned before the sync would let both machines start work and only later learn that one lost, which is the race the claim exists to prevent, so the claiming update pays one round trip to the remote.
Writing the claim records first, and the rest only after confirmation, means a refusal has nothing to roll back but the claim records it wrote, so a refused update never leaves a slice half started or frozen tests out of place.
The nonce tells this attempt's claim from an earlier claim of the same holder and from another machine's claim, so a lost claim is never mistaken for a confirmed one and an undo never removes someone else's claim.
A claim that cannot be confirmed is refused rather than kept as a local claim, because a claim that no other machine sees would let both start the same slice.
Checking the claim on each call that works on a slice, rather than only at its start, is what makes the claim mean that its holder is the one doing the work, and the refusal itself tells the agent how to get the claim, so no skill has to.
The check reads local records without a sync, so work calls stay as fast as before, and the race between machines stays guarded where it matters, when a claim is taken.
A dependents' run needs no claim because every leaf of its scope is done, so no work in progress could collide with it.
The lease is long enough that a renewal missed by a short suspension or network outage does not lose the slice, and short enough that a slice whose holder died waits at most half an hour; renewing every 10 minutes leaves two missed renewals of margin.
Never reviving an expired claim keeps a machine that slept through its lease from taking back a slice that someone else took meanwhile.
The holder is the host session or the server process rather than the person or the machine, because two worktrees of one person on one machine are exactly the agents that must not share a slice, and they run in two sessions.
A host restarts its server within one session, for example between turns of a cloud session or after a plugin reinstall, so a per-process holder would lock the session out of its own slices until the claims expired.
The record keeps a digest of the session identifier, because records may be pushed to a shared store.

## Alternatives

A claim field on the slice in the initiative record would make every renewal a change to the slice, so other machines' edits of a claimed slice would conflict and be set aside, and agents would see routine `revision_conflict`.
Claims in the coordination state would need another merge-aware record kind and would leave the start operation itself unprotected.
A lock service or a Git host API would give stronger exclusion, but the store is an ordinary Git repository with no server.
Keeping a claim taken offline would let work continue on a plane, but two offline machines would both hold the slice and collide later, which is the problem this decision removes.
Refusing only the claim and keeping the rest of the update would leave a started slice without a holder.

## Consequences

A second start of a claimed slice is refused before any frozen test goes in place, in any checkout that shares the records.
Starting or releasing a slice or a design takes as long as one sync of the store, and it is refused while the remote cannot be reached; turning store sync off restores local-only claims.
A refused claim's local claim record is reported in the refusal, and a renewal or release that lost to the upstream is reported as a lost claim or a refusal, never as a saved record.
An update that took its claims can still fail when the sync brought another change of the initiative record, and the caller then gets `revision_conflict` and reads again.
A refused attempt's claim record may reach the remote before the attempt removes it, so other machines see it for one debounced sync.
A server that the host restarts in the same session keeps its holder, and resumes renewing its claims on its first read or update of their initiative; a server whose host gives no session identifier gets a new holder, so its own earlier claim blocks it until the claim expires or someone releases it.
Two processes of one session, such as one session resumed in two terminals at once, share a holder, so claims do not keep them apart.
A claim survives the slice's dependencies and design changes, and only leaving `in-progress`, accepting the proposal, expiry, or release ends it.
A claim that ends because its slice left `in-progress` is removed after the initiative write without waiting for a sync, so a holder's renewal pushed meanwhile can bring it back until it expires.
No operation withdraws a pending design proposal, so a design that is abandoned keeps its claim until release or expiry.
Anyone can release a claim, which relies on people and agents releasing only claims whose holder stopped; the holder learns of it on its next tool result for the initiative.
Two machines whose clocks disagree judge expiry differently by that difference.
Claims cover one initiative's slices; a review is work on its slice and runs under the slice's implementation claim, while roadmap edits and work across repositories are not claimed.
An agent whose claim lapsed, or that runs a review, design, or implementation outside orchestration, is refused until it claims the slice, and gets it back when nobody else took it meanwhile.
A call that works on a slice reads the claims once when it starts, so a claim another machine took and has not yet synced does not refuse it; the claim itself, confirmed with the remote, keeps two agents from starting one slice.
A Codex sub-agent runs its own Prism server process, so a claim it takes is renewed only while that sub-agent runs, while the claims the orchestrator takes are renewed by the orchestrator's server.
The review app's actions are the person's and never pass through the agent tools, so they need no claim.

## Mechanism

A claim record lives beside its initiative record and moves into a record store, syncs, and is locked like any other record.
An update that takes or releases claims holds the initiative's claims lock while it reads the initiative record and every claim record, checks the caller's revision, applies the whole update to a copy without touching the work tree, and checks claim overlaps and expiry.
Still under that lock it writes a claim record with a fresh nonce for each claim it takes and removes the record of each claim it releases, and it changes nothing else.
In a synced store it then cancels the debounced sync, waits for a running sync and for another process's sync lock, and runs a sync of its own.
The sync's outcome decides: `ok` or `conflicts` with every claim record holding its nonce, no overlapping live claim of another holder, and every released record absent confirm the claims; the same outcomes otherwise refuse the update with the winning claim; `no_upstream` and a store that is not a Git checkout confirm locally; every other outcome refuses the update as unconfirmed.
Git's merge of a claim record changed on both sides, including one side removing it, keeps the upstream version, so a removal never silently undoes a renewal or a new claim pushed first, and the reverse.
An undo removes a claim record that still holds the attempt's nonce, or restores the holder's own earlier live claim it replaced, and puts back a released record that is still absent.
After confirmation the update is written through the initiative's ordinary write path with the caller's revision; taking a claim adds no history entry, while replacing an expired claim and releasing a claim do.
After that write, the records of claims the update ended are removed when they still hold the nonce seen during the write.
Each confirmed claim joins the server's renewal list with its nonce, whose timer never keeps the process alive and stops when the server shuts down.
Every initiative read and update compares the server's held claims for that initiative with their records and reports each one released, replaced, or expired once.

## Decision Log

2026-11-04: Made the host session the holder when the host gives the server a session identifier, so a restarted server in the same session keeps its claims.
2026-11-05: Read the session identifier from each tool call's metadata when the host names it there, as Codex does, before the server's environment, so Codex sessions keep their claims across server restarts too.
2026-11-09: Added the optional harness name, read and shown in one release and written from the next, and made readers leave out unknown fields, because releases up to 0.20 refuse a claim with an unknown field and would then let another agent take a slice that is claimed.
2026-11-10: Required the caller's live claim for every agent call that works on a slice, and another holder's claim refuses any other change to it, because agents reviewed and redesigned slices whose claim had lapsed or that they never claimed; `claim` takes the activity from the slice's status, and the holder falls back to Codex's turn metadata, because older Codex releases name the session only there.
