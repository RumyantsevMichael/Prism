# Share Prism state across worktrees and machines

Prism keeps its machine records (roadmap, initiatives, slice state, reviews, change maps, design views, frozen tests, and runs) under each checkout's `.prism` folder by default.
Each linked worktree and each clone then holds its own copy, so work started in one checkout is invisible to the others.
A record store moves those records into one folder that every checkout shares, and store sync shares that folder between machines through Git.
Name the store by its Git remote to share records between machines, or by a folder path to share them between checkouts on one machine.

## What moves and what stays

Only machine records move into the store.
`.prism/workflow.md`, requirements, ADRs, slice plans, diagrams, generated Markdown views, feature files, and tests stay in the project and travel with its branches as before.
Tools, tool results, review browser links, and stored references keep naming records by their `.prism/...` address, so nothing that agents or people see changes.
Each verified slice records where its code lives, the repository, branch, and commit of its latest passing run, and the review browser shows it on the slice page and beside each slice on the initiative page.
On GitHub, GitLab, and Bitbucket the branch, commit, and repository link to their web pages.
The review browser's project menu lists every checkout that shares one record store under that store as one workspace, named after the store, whichever repository each checkout belongs to, and lists projects in name order.
Choosing the workspace there opens its records, which every checkout shares.

## Share records between machines

1. Create an empty repository for the store on your Git host, for example `you/prism-store`, and give everyone who works on the project push access to it.

2. Add a `Workspace` section to `.prism/workflow.md` that names the store's remote and this repository:

   ```markdown
   ## Workspace
   - Store: git@github.com:you/prism-store.git
   - Repository: api
   ```

3. Commit the configuration, so every checkout of the project names the same store and the same repository.

`Store` names a remote when it is a URL with the scheme `https`, `http`, `ssh`, `git`, or `file`, or the scp form `user@host:path`.
On the first record access that finds no clone of it, Prism clones the remote into its application folder, under `stores/<id>`, where `<id>` is derived from the remote.
The application folder is `~/Library/Application Support/Prism` on macOS, `%LOCALAPPDATA%\Prism` on Windows, and `$XDG_STATE_HOME/prism` or `~/.local/state/prism` elsewhere, and `PRISM_REVIEW_APP_DIR` overrides it.
The access waits for the clone, and every later access on the machine uses it.
Every checkout, worktree, and host on the machine whose configuration names the same remote shares that one clone, even when they spell it differently, such as with or without a trailing `.git` or `/`, so Claude Code and Codex read and write the same clone.
A clone that Prism 0.16 made under a host's plugin data directory moves to the application folder on the first record access, with any commit it has not pushed yet.
Store sync is on by default for a remote store, so Prism keeps the clone in step with the remote without you running Git in it:

- A few seconds after a record write, Prism commits the change, merges the remote's branch, and pushes.
- A record read starts a background fetch when the last one is older than 30 seconds, and it never waits for the network.
- An empty remote starts an empty store, and the first sync pushes its branch.
- Only one Prism process syncs a store at a time, and Prism never rebases, amends, force-pushes, or edits your Git configuration.
- Records keep working locally when Git, the network, or the remote is unavailable.

`- Store sync: off` keeps the clone but never fetches, commits, or pushes after the first clone.
Prism never deletes, replaces, or rewrites the history of a clone it made.
Merging requires Git 2.38 or later.
SSH runs in batch mode unless you configured an SSH command, and Git never prompts, so a remote that needs a passphrase or password prompt fails instead of hanging.
Use an SSH agent or a Git credential helper for a remote that needs credentials, because a token in the URL stays in the clone's Git configuration, although Prism leaves it out of every message and status.

These problems make every record operation fail with `store_unavailable`, and the message names the remote without any user name or token:

- The clone failed, for example because the remote cannot be reached; Prism leaves no partial clone behind and tries again on the next access.
- A folder already sits at the clone path with another origin; Prism leaves it untouched, so move it away.

The first record access from a checkout moves its existing records into the store, as described below.

## Share records between checkouts on one machine

1. Create a folder outside the project, for example next to it:

   ```sh
   mkdir ../prism-store
   ```

2. Add a `Workspace` section to `.prism/workflow.md`:

   ```markdown
   ## Workspace
   - Store: ../prism-store
   - Repository: api
   ```

3. Commit the configuration, so every checkout of the project names the same store and the same repository.

A `Store` path is relative to the project root or absolute.
It must not resolve inside the project or contain it, and Prism never creates it.
A missing or misplaced store makes every record operation fail with `store_unavailable`, because silently falling back to `.prism` would split state between checkouts.
While the store is unavailable, the review browser opens without the project's requirements, ADRs, plans, glossary, and roadmap view, which live in the store, and never shows the checkout's copies of them in their place.
It names the store as the reason, and opening one of those files answers with the same reason.

The first record access from a checkout moves its existing records into the store, and each record moves only once, from whichever checkout brings it first.
Prism lists every moved record in the store's `migrations` folder, together with any record whose bytes differed from a copy already in the store, and it leaves both copies of such a record in place.
Copies of those records that other checkouts still hold under `.prism` are ignored from then on, so a record you removed from the store stays removed, and you can delete the copies.

### Sync a path store yourself

A path store can also be a Git checkout that you cloned, whose branch has an upstream, with sync turned on:

```sh
git clone git@github.com:you/prism-store.git ../prism-store
```

```markdown
## Workspace
- Store: ../prism-store
- Repository: api
- Store sync: on
```

Prism then syncs it as it syncs a remote store.
Without `Store sync: on`, Prism never runs Git in a path store, and you can commit and push it yourself.

## Name the workspace

The checkouts that share one store form one workspace, and the store keeps its name, so every checkout, repository, and machine shows the same name.
Ask the agent to name the workspace, and it records the name with the `set_workspace_name` operation of `update_roadmap`.
A name is one line of at most 64 characters, and an empty name clears it.
The name is kept in the store's roadmap record and appears as a `Workspace:` line at the top of the generated roadmap Markdown.
Until a name is set, the review browser names the workspace after the store's folder, or after its repository for a remote store, such as `prism-store`.

## Name each repository

One store can hold the records of several repositories, so each repository that uses a store must name itself with a `Repository` line under `## Workspace`, beside `Store`.
Every clone, shallow clone, fork, worktree, and machine reads the same committed name.
Without a `Store` line, record operations need no `Repository` line and ignore one, which then only names the repository's components.

A name has 1 to 64 lowercase letters, digits, hyphens, or underscores, and starts and ends with a letter or digit.
Any other value makes every record operation fail with `repository_name_invalid`, and the message proposes a valid name.

The first record operation that uses a name registers it in the store's `repositories/<name>.json`, with the checkout's `origin` remote, shown without any user name, token, query, or fragment, and the repository's first root commit.
A checkout without a network remote, because it has no `origin` or its `origin` is a local path or a `file://` URL, registers the name without a remote.
A shallow clone, or a repository before its first commit, registers the name without a root commit, and the first full checkout whose remote matches adds it.
Prism checks the name before every record operation, before it reads, writes, or moves any record, and a refused checkout leaves the store and its own records untouched.
A change to the `Repository` line or the `origin` remote applies to a running server within 5 seconds.

A registered name accepts a checkout in three cases:

- Its remote matches a registered remote.
  Two remotes match when their host, ignoring case and port, and their path, ignoring surrounding `/` and a trailing `.git`, are equal, so `git@github.com:acme/api.git` and `https://github.com/acme/api` are one remote, while `Acme/API` is another path than `acme/api`.
- It has no network remote, and the name was registered without one.
- Its root commit equals the registered one, as in a repository moved on its host or a fork of it, and no other name lists its remote; its remote then joins the registration.
  A checkout whose root commit matches but whose remote another name lists, such as a fork's checkout that names the original, is refused with `repository_remote_registered`.

These refusals make every record operation of the checkout fail, and each error's data holds the proposed name as `proposed`:

| Code | Meaning | What to do |
| --- | --- | --- |
| `repository_name_missing` | The configuration names a store but no repository. The message shows the `- Repository: <name>` line to add under `## Workspace`. | Add the proposed line to `.prism/workflow.md` and commit it. |
| `repository_name_invalid` | The name breaks the naming rules. | Use the proposed name. |
| `repository_name_taken` | The name is registered for other remotes, and the checkout's history cannot prove it is the same repository. The message names both remotes and why, such as a shallow clone. | For the same repository moved on its host, run `git fetch --unshallow` in a shallow clone; otherwise use the proposed name. |
| `repository_remote_registered` | The checkout's remote is already registered under another name. | Use the name it is registered under. |
| `repository_unconfirmed` | Store sync is on, and the sync that confirms a new registration failed, for example because the store's remote cannot be reached, so the registration was withdrawn; or, whatever the checkout's own store sync setting, another check's new registration that decides this check is still being confirmed. The message names the sync state, and `proposed` is the name itself. | Try again once the remote is reachable, or in a moment while a registration is being confirmed. |

The proposed name is the registered name that would accept the checkout, or else the last part of its remote's path without `.git`, or its folder name without a network remote, made valid and given a suffix such as `-2` when another repository holds it.
The review browser hides the records and artifacts of a refused checkout as it does for an unavailable store, and shows the refusal's message as the reason.

Each machine remembers where its checkouts of each named repository are, in `checkouts.json` in Prism's application folder, beside the store clones.
A server lists its checkout once its name is first accepted: at start when the host names the project, as Claude Code does, or else at its first tool call, as in Codex.
A refused or unnamed checkout is not listed, and a listed folder that no longer names the same store and repository leaves the list when another checkout of that repository is listed.
The list never leaves the machine, and no checkout path is written to the store.

With store sync on, the operation that registers a new name waits for one sync before it continues, so two machines that register one name at the same time end with one registration.
Until that sync settles, the registration is pending, and any other check that it would decide, by any checkout that shares the store folder, whatever its own store sync setting, is refused with `repository_unconfirmed` without waiting, so no operation records anything under a registration that may still be withdrawn.
The registration pushed first stays, and the other machine's checkout is then accepted or refused against it, as if it had been in the store all along.
The registration that lost is saved under `.prism-sync/conflicts/` like a record, but neither the sync status nor a tool result lists it, because the acceptance or refusal already tells the agent.
A remote or root commit added to an existing registration does not wait: the next sync pushes it, and the next check that needs it adds it again if a sync lost it.
Each name is a file of its own, so two machines that register one remote under two different names at the same time both keep their registrations, because `repository_remote_registered` refuses a second name for a remote only once the store holds the first.

A checkout whose configuration names a store but no repository is refused with `repository_name_missing` on every record operation, registers nothing, and writes nothing to the store, while the records it holds under `.prism` stay where they are until the name is committed and its first record operation moves them.
A verification run or contract-defect report of a named checkout records the name as its repository, while a checkout without a store keeps recording the root commit.
Naming a repository changes no record, migration entry, or run that the store already holds, and a store's migration marker from before Prism listed moved records keeps covering the repository after it is named.

## When two people change the same record

Changes to different initiatives in the roadmap, or to different slices or proposals of one initiative, merge, and both history entries are kept.
A roadmap reordered on one machine keeps that order, and an initiative added on the other machine lands after the initiative it followed there.
Two changes collide when they change the same initiative or slice differently, reorder the roadmap differently, or merge into a record that fails validation, such as a dependency cycle between two slices.
Other records, such as coordination state, collide whenever Git cannot merge their lines.
In a collision the first push wins.
The machine whose push lost keeps the upstream version and saves its own version under `.prism-sync/conflicts/<time>/` in the store, so no bytes are lost.
The next Prism tool result on that machine names the record and the saved file, so the agent that made the change learns of it.
Compare the saved file with the current record, and redo the change through Prism's tools if it still matters.
Prism never replaces a record that changed while a merge was running: it leaves the branch where it was and resolves the change on the next sync.

## When two people change the same artifact

With store sync on, each `update_artifact` that changes a file, and each plan file or view that Prism writes into the store, is committed and pushed by the next sync without a further call.
Changes to different lines of one artifact on two machines merge, so in a file with one sentence per line, edits to different sentences both survive.
When both machines change the same line differently, or one machine makes a file where the other made a folder of the same name, the first push wins.
The machine whose push lost keeps the upstream artifact and saves its own files under `.prism-sync/conflicts/<time>/artifacts/` in the store, so no bytes are lost.
An artifact that one machine moved, to another scope or by removing it and writing similar text at another path, merges as a removal at its old path and a new file at its new path, so a change the other machine made at the old path is saved, and a file it added to a moved folder stays where it was written.
The next tool result of each running Prism server on that machine that uses the store names the artifact's path, its scope, and the saved copy.
Read the artifact again with `get_artifact`, and redo the change with `update_artifact` if it still matters.
A sync that starts while an artifact update is still writing leaves that update to the next sync, so it never merges the upstream over a change in progress.

## Who works on a slice

Starting a slice, or starting the design of a scope, claims it for the agent session that does the work, so no other agent in any checkout or on any machine that shares the records starts it at the same time.
A claim covers the parts inside its slice, so a design claim on a scope also blocks a start of any slice inside it, and the reverse.
Two agents can still work on two independent slices of one initiative at once.
Another agent's start of a claimed slice is refused with `slice_claimed`, which names who holds it, for design or implementation, and until when, and that agent moves on to another slice.
A claim names its holder by the store's Git `user.name` and the host name, such as `Michael Rumyantsev on MacBookPro`, or by the host name alone when the store has no `user.name`.
`get_initiative` lists each live claim under `claims`.
The review browser shows each claim's holder, activity, and time left on the slice board, the slice list, and the slice page, and marks the slices inside a scope that a design claim covers.
A claim that lapsed without a release shows as expired until someone claims or releases the slice.

With store sync on, a start or a release waits for one sync before anything else in the update is written, so two machines never both believe they started the same slice.
The machine whose sync loses is refused with `slice_claimed`, none of that update applies, and its store shows the other machine's claim.
A release that loses to the holder's renewal pushed first is refused the same way.
A start while the store's remote cannot be reached is refused with `claim_unconfirmed` and leaves no claim; start the slice again when the remote is back.
Without store sync, a claim protects the slice between every checkout that shares the store folder.

The server renews its claims every 10 minutes while it runs, and a claim expires 30 minutes after its last renewal, judged by each machine's clock.
A slice whose session ended without finishing frees itself that way, and the next start names the holder whose claim expired.
A server never renews a claim that expired, for example while its laptop slept, or that someone released or took over; its next `get_initiative` or `update_initiative` result for the initiative lists the claim under `lostClaims`.
Claims are kept apart from the initiative record, so renewals never collide with someone else's edit of the slice.
A claim ends when its slice is done, blocked, or back to not started, or when the design proposal of its scope is accepted.
In Claude Code and Codex a claim belongs to the session, so a server that the host restarts in the same session keeps its claims and renews them again after its first initiative read or update.
Claude Code names the session in the server's environment, and Codex names it in each tool call, so sub-agents in Codex share their session's claims as subagents in Claude Code do.
On a host that gives the server no session identifier, a claim belongs to the server process, and a restarted server gets a new holder.
To free a slice sooner, for example after such a restart, ask your agent to send `update_initiative` with a `release_claim` operation for the slice.
Anyone may release any claim, and the initiative's history records who released whose claim.

## Sync status

The review browser's status bar names the record store and when it last synced, and `.prism-sync/status.json` in the store holds the details.
When the last sync did not succeed, clicking the sync state opens its message, its time, and every saved conflict.
Each saved conflict shows the saved local copy against the current record as a diff, so you can ask an agent to redo the change that lost.
The list shows saved records, while a saved artifact is named in the next tool result as described above.

| State | Meaning | What to do |
| --- | --- | --- |
| `ok` | The last sync committed, merged, and pushed. | Nothing. |
| `conflicts` | A record or an artifact changed on both sides in a way that does not merge; the local version is saved under `.prism-sync/conflicts/`. | Review the saved file. |
| `no_upstream` | A path store's branch has no upstream, so Prism only commits locally; a remote store sets its upstream on its first sync instead. | Set an upstream with `git branch --set-upstream-to`. |
| `not_a_repository` | Sync is on, but the store is not the top of a Git checkout. | Clone the store, or turn sync off. |
| `fetch_failed` or `push_rejected` | The remote could not be reached, sent an object that fails Git's object checks, refused the push, or kept moving for three attempts. | Check access to the remote; Prism retries on the next write or read, and a commit whose objects fail the checks needs removing from the remote's history. |
| `merge_failed` | A file other than a record or an artifact conflicted, a record or an artifact stayed locked through every attempt, the upstream holds a path that leads outside the store's files, such as one with a `..` part, or Git is older than 2.38. | Read the status message; a busy record clears on its own, and a path outside the store needs the commit that added it removed from the remote's history. |
| `git_failed` | Git failed for another reason, such as a leftover `.git/index.lock`. | Fix the store with Git; Prism never deletes Git's locks. |

## Cloud sessions

A cloud session clones a remote store into its own application folder on its first record access, like any other machine.
The session needs read and push access to the store repository, so add the store repository to the project's repositories, or otherwise let the session reach it with push access.
A cloud session that attached the store repository with push access could push to the store's `main` branch in a test on 2 November 2026, so sync works there without changes.
A session that may push only its own `claude/...` branch reports `push_rejected` and keeps its records in its own clone until a person merges them.
A path store such as `Store: ../prism-store` still works in a cloud session, because the session clones each of its repositories next to each other under `/home/user/`.

## How it works

The [external record store](../ADRs/workflow-records/external-record-store.md) and [Git sync](../ADRs/workflow-records/record-store-git-sync.md) decisions define the rules, and [record-store-architecture.puml](../ADRs/workflow-records/record-store-architecture.puml) shows how checkouts, the store, and the remote fit together.
The [slice claims](../ADRs/workflow-records/slice-claims.md) decision defines who may work on a slice.
