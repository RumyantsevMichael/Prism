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

## Share records between machines

1. Create an empty repository for the store on your Git host, for example `you/prism-store`, and give everyone who works on the project push access to it.

2. Add a `Workspace` section to `.prism/workflow.md` that names the store's remote:

   ```markdown
   ## Workspace
   - Store: git@github.com:you/prism-store.git
   ```

3. Commit the configuration, so every checkout of the project names the same store.

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
   ```

3. Commit the configuration, so every checkout of the project names the same store.

A `Store` path is relative to the project root or absolute.
It must not resolve inside the project or contain it, and Prism never creates it.
A missing or misplaced store makes every record operation fail with `store_unavailable`, because silently falling back to `.prism` would split state between checkouts.
The review browser still lists the project's human documents while the store is unavailable.

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
- Store sync: on
```

Prism then syncs it as it syncs a remote store.
Without `Store sync: on`, Prism never runs Git in a path store, and you can commit and push it yourself.

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

## Sync status

The review browser's status bar names the record store and when it last synced, and `.prism-sync/status.json` in the store holds the details.
When the last sync did not succeed, clicking the sync state opens its message, its time, and every saved conflict.
Each saved conflict shows the saved local copy against the current record as a diff, so you can ask an agent to redo the change that lost.

| State | Meaning | What to do |
| --- | --- | --- |
| `ok` | The last sync committed, merged, and pushed. | Nothing. |
| `conflicts` | A record changed on both sides in a way that does not merge; the local version is saved under `.prism-sync/conflicts/`. | Review the saved file. |
| `no_upstream` | A path store's branch has no upstream, so Prism only commits locally; a remote store sets its upstream on its first sync instead. | Set an upstream with `git branch --set-upstream-to`. |
| `not_a_repository` | Sync is on, but the store is not the top of a Git checkout. | Clone the store, or turn sync off. |
| `fetch_failed` or `push_rejected` | The remote could not be reached, refused the push, or kept moving for three attempts. | Check access to the remote; Prism retries on the next write or read. |
| `merge_failed` | A file other than a record conflicted, a record stayed locked through every attempt, or Git is older than 2.38. | Read the status message; a busy record clears on its own. |
| `git_failed` | Git failed for another reason, such as a leftover `.git/index.lock`. | Fix the store with Git; Prism never deletes Git's locks. |

## Cloud sessions

A cloud session clones a remote store into its own application folder on its first record access, like any other machine.
The session needs read and push access to the store repository, so add the store repository to the project's repositories, or otherwise let the session reach it with push access.
A cloud session that attached the store repository with push access could push to the store's `main` branch in a test on 2 November 2026, so sync works there without changes.
A session that may push only its own `claude/...` branch reports `push_rejected` and keeps its records in its own clone until a person merges them.
A path store such as `Store: ../prism-store` still works in a cloud session, because the session clones each of its repositories next to each other under `/home/user/`.

## How it works

The [external record store](../ADRs/workflow-records/external-record-store.md) and [Git sync](../ADRs/workflow-records/record-store-git-sync.md) decisions define the rules, and [record-store-architecture.puml](../ADRs/workflow-records/record-store-architecture.puml) shows how checkouts, the store, and the remote fit together.
