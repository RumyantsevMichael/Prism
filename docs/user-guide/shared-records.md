# Share Prism state across worktrees and machines

Prism keeps its machine records (roadmap, initiatives, slice state, reviews, change maps, design views, frozen tests, and runs) under each checkout's `.prism` folder by default.
Each linked worktree and each clone then holds its own copy, so work started in one checkout is invisible to the others.
A record store moves those records into one folder that every checkout shares, and store sync shares that folder between machines through Git.

## What moves and what stays

Only machine records move into the store.
`.prism/workflow.md`, requirements, ADRs, slice plans, diagrams, generated Markdown views, feature files, and tests stay in the project and travel with its branches as before.
Tools, tool results, review browser links, and stored references keep naming records by their `.prism/...` address, so nothing that agents or people see changes.

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

`Store` is relative to the project root or absolute.
It must not resolve inside the project or contain it, and Prism never creates it.
A missing or misplaced store makes every record operation fail with `store_unavailable`, because silently falling back to `.prism` would split state between checkouts.
The review browser still lists the project's human documents while the store is unavailable.

The first record access from any checkout of a repository moves that checkout's existing records into the store, once per repository.
Prism records the move in the store's `migrations` folder, together with any record whose bytes differed from a copy already in the store, and it leaves both copies of such a record in place.
Record files that other checkouts still hold under `.prism` are ignored from then on, and you can delete them.

## Share records between machines

Make the store a Git checkout whose branch has an upstream, and turn sync on:

```sh
git clone git@github.com:you/prism-store.git ../prism-store
```

```markdown
## Workspace
- Store: ../prism-store
- Store sync: on
```

Prism then keeps the store in step with its upstream without you running Git in it:

- A few seconds after a record write, Prism commits the change, merges the upstream, and pushes.
- A record read starts a background fetch when the last one is older than 30 seconds, and it never waits for the network.
- Only one Prism process syncs a store at a time, and Prism never rebases, amends, force-pushes, or edits your Git configuration.
- Records keep working locally when Git, the network, or the upstream is unavailable.

Without `Store sync: on`, Prism never runs Git in the store, and you can commit and push it yourself.
Merging requires Git 2.38 or later.
SSH runs in batch mode unless you configured an SSH command, so a remote that needs a passphrase prompt fails the sync instead of hanging it.

## When two people change the same record

Until records become append-only, the first push wins.
The machine whose push lost keeps the upstream version and saves its own version under `.prism-sync/conflicts/<time>/` in the store, so no bytes are lost.
Compare the saved file with the current record, and redo the change through Prism's tools if it still matters.
Prism never replaces a record that changed while a merge was running: it leaves the branch where it was and resolves the change on the next sync.

## Sync status

The review browser shows a small chip when the last sync did not succeed, and `.prism-sync/status.json` in the store holds the details.

| State | Meaning | What to do |
| --- | --- | --- |
| `ok` | The last sync committed, merged, and pushed. | Nothing. |
| `conflicts` | A record changed on both sides; the local version is saved under `.prism-sync/conflicts/`. | Review the saved file. |
| `no_upstream` | The store's branch has no upstream, so Prism only commits locally. | Set an upstream with `git branch --set-upstream-to`. |
| `not_a_repository` | Sync is on, but the store is not the top of a Git checkout. | Clone the store, or turn sync off. |
| `fetch_failed` or `push_rejected` | The remote could not be reached, refused the push, or kept moving for three attempts. | Check access to the remote; Prism retries on the next write or read. |
| `merge_failed` | A file other than a record conflicted, a record stayed locked through every attempt, or Git is older than 2.38. | Read the status message; a busy record clears on its own. |
| `git_failed` | Git failed for another reason, such as a leftover `.git/index.lock`. | Fix the store with Git; Prism never deletes Git's locks. |

## Cloud sessions

A cloud session clones each of its repositories next to each other under `/home/user/`, so `Store: ../prism-store` finds a store repository that the session also has.
Add the store repository to the project's repositories so cloud sessions clone it.
A cloud session that attached the store repository with push access could push to the store's `main` branch in a test on 2 November 2026, so sync works there without changes.
A session that may push only its own `claude/...` branch reports `push_rejected` and keeps its records in its own clone until a person merges them.

## How it works

The [external record store](../ADRs/workflow-records/external-record-store.md) and [Git sync](../ADRs/workflow-records/record-store-git-sync.md) decisions define the rules, and [record-store-architecture.puml](../ADRs/workflow-records/record-store-architecture.puml) shows how checkouts, the store, and the remote fit together.
