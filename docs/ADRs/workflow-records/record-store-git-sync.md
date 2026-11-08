# Sync the record store through Git

Status: Proposed
Created: 2026-11-01

## Requirements

No Approved requirement governs this decision yet.
It records the second increment of the multi-repository roadmap milestone, which the user approved.

## Problem

The [external record store](external-record-store.md) shares records between checkouts on one machine, but colleagues on other machines still see different initiatives.
Asking people to commit, pull, and push the store by hand would let records drift and would lose work when someone forgets.
The user chose one local writer per machine, with cloud sessions reaching the store through their own branch and a merge Action in a later increment.

## Decision

A store that is a Git checkout MAY opt into sync, and Prism MUST NOT run Git in a store that has not opted in.
With sync on, Prism MUST commit record changes after writes, merge the store's upstream, and push, without rebasing, amending, force-pushing, or changing the user's Git configuration.
At most one process MUST sync a store at a time, and a process that finds the store's sync lock held MUST skip and try again later.
A record read MUST NOT wait for the network.
Record reads and writes MUST NOT see a partially written record file while a merge updates the store.
A roadmap or initiative record that changed on both sides since the merge base MUST be merged by its structure, whether or not Git's line merge conflicts, and every other record kind MUST keep Git's line merge.
A structural merge MUST take each unit from the side that changed it, MUST keep the history entries of both sides, and MUST write the result with the serializer of the record's tools.
A structural merge whose unit changed differently on both sides, or whose result fails the record's own validation, MUST fall back to the whole-file rule.
Under the whole-file rule, a merge conflict on a record MUST keep the upstream version in the store and save the local version beside it, and a conflict on any other file MUST leave the store unchanged.
Every Prism server that uses the store MUST report each saved local version once, on its next tool result, so the agent whose change lost learns of it.
A sync problem MUST NOT fail a record operation, and the store MUST report the latest sync outcome for the review browser.

## Rationale

The user's design names the review app as the single writer, but per-record file locks already serialize local writes in any process.
What Git needs is a single syncer per store, so a store-wide sync lock held by whichever Prism server runs replaces a dedicated writer process.
Letting the first push win matches how a stale revision is refused, so no new conflict semantics reach the tools.
Saving the losing version keeps every byte recoverable without blocking either machine.
Every write appends to the record's history at the same place, so a line merge conflicts on unrelated changes, and a clean line merge of JSON can still be wrong or non-canonical, so these records are not trusted to it.
The rules that know a record's shape live beside its validator and serializer, so store sync stays ignorant of record shapes.

## Alternatives

A dedicated writer process would add a daemon and an inter-process protocol without making local writes safer than the existing locks do.
`git merge` in the working tree replaces files in place, so a concurrent reader could see a missing or truncated record.
Rebasing local commits rewrites history that another checkout of the same store may already hold.
Blocking record work on the network would make an offline machine unusable.

## Consequences

Colleagues share initiatives, reviews, and runs once their stores clone one remote and turn sync on.
A pending debounced sync can be lost when a process exits, and the next sync from any process commits the change because it stages everything uncommitted.
A cloud session that attached the store repository with push access pushed to its `main` branch in a test on 2 November 2026, so cloud sessions sync without a merge Action.
A session limited to its own `claude/...` branch would report `push_rejected` and keep its records in its own clone, which a merge Action could later fold in.
Concurrent changes to different initiatives, slices, or proposals of one record both survive, and only the same unit changed on both sides is saved aside.
A merged record is not a conflict and is not reported, so an agent that holds the earlier revision gets `revision_conflict` on its next write and reads again.
Two edits that are valid alone can merge into an invalid record, such as a dependency cycle, and then fall back to the whole-file rule.
A unit merges as a whole, so two edits to different fields of one initiative entry or one slice still conflict.
Other record kinds, such as coordination state, still resolve concurrent edits by Git's line merge and then by first push.
A record written or locked while a merge would replace it keeps the branch where it was, so the next attempt commits the local bytes and resolves them against the upstream as a saved conflict.
A record that stays locked through every attempt delays the merge to a later sync, which the status reports as `merge_failed`.
A leftover Git lock in the store stops syncing with `git_failed` until a person removes it, because Prism never deletes Git's locks.
The sync and the first clone of a remote store use only commands and options that Git 2.25 has, and on an older Git every record operation of a store that syncs, or of a remote store, fails with `store_unavailable`, naming both versions.
A push MUST NOT send a commit or a tree that the checked fetch of any supported Git release refuses, so the sync applies Git's own commit and tree checks itself, ported from Git's source, rather than relying on how much this machine's Git checks.
Every Git command in a store MUST run with the same settings whatever the user's Git configuration, the variables the server inherits, or the store's local refs say, so a check MUST read the objects that the push sends, and a push MUST send the store's branch and nothing else.
Only settings that choose how Git reaches the remote or who the user is, such as credentials, URL rewriting, the SSH command, and the store's own hooks, stay the user's.
A sync's fetch MUST NOT remove a ref outside the remote's remote-tracking branches, whatever refspecs the user configured, and it MUST remove each remote-tracking branch whose branch the remote deleted, because the push check takes them as the commits the remote holds.
For a remote that Git reaches by a path or a `file://` URL, Git runs the remote's side of a fetch or push on this machine inside that repository and, by design, trusts that repository's own settings.
A sync or a first clone MUST turn off every hook, maintenance run, and configured program of that remote side that Prism knows of.
That narrows what the folder's repository can make Git do but does not remove it: anyone who can write a folder store's repository can still affect what Git does on every machine that syncs with it, so such a folder MUST be writable only by people trusted that far.

## Mechanism

[record-store-architecture.puml](record-store-architecture.puml) shows the checkouts, the store, the syncer, and the remote.

The `Workspace` section's `Store sync` key turns sync on.
A write or append schedules a debounced sync, and a read starts a background sync when the last fetch is older than the pull interval.
A sync takes the store-wide sync lock, stages everything except the sync folder and ignored files, commits, fetches the upstream, merges, and pushes, and it repeats fetch, merge, and push up to three times when another machine pushed first.
The merge runs in Git's object store without touching the working tree, and a record conflict takes the upstream entry while the local blob is saved under the sync folder.
Before the merge commit is built, every record path that changed on both sides since `git merge-base` is looked up in a small registry, which names the record module that owns the path and imports it only when a merge needs it.
That module parses the base, local, and upstream versions, treating a record absent at the base as the empty record, and merges them unit by unit.
A roadmap merges each scalar, the open questions as a whole, each initiative entry by id, and the relative order of the ids that all three versions hold, where only one side's reordering is taken and an added id follows its nearest preceding id.
An initiative merges each scalar, each slice by slug, and each proposal by scope, so a split and an edit of the same slice conflict.
History keeps the base entries both sides still hold, then the entries one side added in time order with local first on a tie, and then its last 500 entries.
A merged record passes its kind's validation, including the initiative graph analysis, and its blob replaces Git's line merge in a temporary index, from which the merge tree is written.
A record removed on either side keeps Git's whole-file handling.
The merge step then marks the working tree as changing, takes the record lock of every changed file, and checks that each file still holds the previous commit's bytes.
Only then does it replace each file by an atomic rename and check that each holds the merged bytes, and only after both checks does the branch move.
When a check fails or a lock stays held, the branch stays at the pre-merge commit, the next attempt commits what the working tree holds, and the merge runs again, so an upstream change is never reverted silently.
Record reads and writes in every process wait, for at most ten seconds, while that mark is held by a live process, and the atomic rename means a reader that started earlier still sees a whole old or new file.
The branch and index move to the merge commit while the locks are still held, then the locks and the mark are released.
A write scheduled while a sync runs starts another sync after it, because the running sync may have committed before the write.
SSH runs in batch mode unless the user configured an SSH command, so no prompt can hold the sync lock.
The fetch maps `refs/heads/*` to `refs/remotes/<remote>/*` on its command line, so it prunes only that folder, and Git still updates any other remote-tracking ref that the user's refspecs map from the branches it fetched.
For a remote whose fetch URL, or any push URL, Git reaches by its local transport, as Git's own rule for a URL decides, the fetch, the push, and the first clone pass `--upload-pack` or `--receive-pack` naming Git with `core.hooksPath` set to an empty folder in Prism's application folder, `core.alternateRefsCommand` set to `exit 0;`, `core.alternateRefsPrefixes` empty, and `receive.denyCurrentBranch=refuse`.
The helper also gets `receive.autogc=false`, `gc.auto=0`, `gc.autoPackLimit=0`, and `maintenance.auto=false`, so a push starts no maintenance, whose commands read programs such as `gc.recentObjectsHook` from the remote's configuration, and an empty `core.fsmonitor`.
Git 2.54 and later also run hooks that `hook.<name>.command` and `hook.<name>.event` settings configure, which `core.hooksPath` does not reach.
The helper turns off every hook event that Git documents with `hook.<event>.enabled=false`, which Git 2.55 and later honor while no `hook.<event>.command` or `hook.<event>.parallel` makes that name a hook's own, and it turns off by name, with `hook.<name>.enabled=false`, each hook that the remote repository's configuration sets up when the fetch or push starts, since Git 2.54 has no event switch.
A hook whose name holds an equals sign cannot be named in a `-c` setting, so a sync with such a remote fails with `git_failed`, and a first clone with `store_unavailable`, naming the hook.
A push to such a remote sends no push certificate, because `receive-pack` checks one with the `gpg.program` the remote's configuration names and only the remote's hooks, which never run, read the result.
Hooks and settings that the remote's configuration adds after the fetch or push started its helper, and programs that a future Git adds, are not covered, which is why the folder's write access is a matter of trust.
An empty `core.alternateRefsCommand` would also run nothing, but every push's connectivity check would then print that it cannot run it.
Git drops every `-c` setting before it starts a local transport's helper, so only the helper's own command line reaches it, and Git runs that command through the shell, so each setting is quoted for it.
Every one of those settings except `maintenance.auto` and the `hook.*` switches exists in Git 2.25, and an older Git ignores a setting it does not know.
An SSH server or a Git daemon would take that command as the service to run and refuse it, and HTTP ignores it, so no other transport gets it.
A `remote.<name>.uploadpack` or `remote.<name>.receivepack` that the user set in the store is a transport setting of the user's, so it runs as set.
Every sync writes its outcome, ahead and behind counts, and saved conflicts to a status file in the ignored sync folder, and the review index includes it.
A sync that saves local versions, of records or of a store file it had withheld, first writes a pending notice for that save under `.prism-sync/notices/`, then moves the copies to `.prism-sync/conflicts/`.
Each server remembers the stores it synced or pulled, and the next tool result it writes to its host names each saved version that it has not named yet and that was saved since it started or still has a pending notice.
Writing that result clears the notices it carried, so a server started later names a version only when no written result has named it, and a result that is never written, such as a cancelled call's, clears nothing.
A call that the host cancels before its result is written gets no response, as MCP asks of a cancelled request, so it takes no notes and clears nothing.

## Decision Log

2026-11-02: A two-machine test showed that the agent whose change lost was never told and that history appends make every concurrent write to one record conflict; tool results now report saved local versions.
2026-11-02: Roadmap and initiative records that changed on both sides now merge by structure, and only a unit changed differently on both sides or an invalid result falls back to the upstream version.
2026-11-02: A store cloned from an empty remote reported `ok` without pushing, because its upstream branch did not exist yet; a sync now pushes a branch whose upstream the remote lacks, a managed clone without an upstream pushes its branch with the upstream set, and status messages drop the user information of any URL.
2026-11-03: An update that takes or releases a [slice claim](slice-claims.md) syncs at once and waits for the outcome instead of the debounced sync; claim records have no structural merge, so the upstream version wins, and a claim record saved aside is reported through the claim's refusal or its holder's lost-claim notice instead of as a saved record.
2026-11-08: A server that stopped before naming a saved version, or a cancelled call that took the notes it never sent, left that version named by no tool result; saved versions now stay pending under `.prism-sync/notices/` until a result written to the host names them.
2026-11-08: A push from an older Git sent objects that a newer Git's checked fetch refuses, such as a tree entry name over 4096 bytes, and a cancelled call other than a wait still wrote a result that the host ignores; the sync now applies Git's own commit and tree checks itself, and no cancelled call gets a response.
2026-11-08: The user's `push.followTags` made a sync push unchecked tags, a replace ref made the checks read other objects than the push sent, and a push from Git before 2.43 could send a tree nested deeper than later releases walk; every store command now reads the real objects with fixed settings, a push sends only the branch, and the sync refuses a tree nested more than 2048 folders deep.
2026-11-08: A push to a `file://` remote ran the hooks and the `core.alternateRefsCommand` that the remote repository named, on the syncing machine, and the fetch's pruning followed the user's `remote.<name>.fetch`, so a refspec for tags deleted local tags; the helpers of a local transport now run with hooks and those commands off, and the fetch prunes only the remote's remote-tracking branches.
2026-11-08: A push to a `file://` remote still started the remote's automatic maintenance, which ran a `gc.recentObjectsHook` that the remote's configuration named, and Git 2.54's configured hooks bypass `core.hooksPath`; the helpers of a local transport now start no maintenance, turn configured hooks off, and send no push certificate, and the decision now states that Git trusts a folder store's own settings, so its write access is a matter of trust.
