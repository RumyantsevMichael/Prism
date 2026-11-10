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
   A README or a license that the Git host adds is fine, and Prism keeps any other file in Git only, never on disk.

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
Prism shares the regular files at the paths it writes in a store: the records under `initiatives/`, `roadmap.json`, the registrations under `repositories/`, the migration files under `migrations/`, the ledgers of moved artifacts under `artifact-migrations/`, the artifacts under `artifacts/` whose every name follows the artifact name form, the comments on them under `artifact-comments/`, and the store's `.gitignore` and `.gitattributes`.
It also shares a `README`, `README.md`, `README.txt`, `LICENSE`, `LICENSE.md`, `LICENSE.txt`, or `COPYING` at the store's root, spelled exactly so, which Prism never reads.
Prism uses Git in the store only to keep these files' bytes: the clone and every sync write each file as the remote's branch holds it, and every commit holds each file as it is on disk.
So no `.gitignore` or `.gitattributes` line, in the store or in your Git configuration, and no line-ending setting such as `core.autocrlf`, changes what Prism commits, merges, or writes.
Prism runs each Git command in the store with `core.autocrlf=false`, `core.eol=lf`, `core.safecrlf=false`, `core.longpaths=true`, and an empty `core.attributesFile` and `core.excludesFile` for that command only, without changing your Git configuration.
Your Git configuration, the variables Prism's process inherits, and the store's own refs also never change what Prism checks or pushes:

- Every Git command in the store reads the objects themselves, so a replace ref, a `.git/info/grafts` file, a commit-graph file, or a reachability bitmap never makes Prism check other objects than those the push sends.
- A push sends only the store's branch, as `HEAD:<branch>`, so it never sends a tag, whatever `push.followTags` says, never pushes a submodule, and never mirrors, whatever `remote.<name>.mirror` or `remote.<name>.push` say.
- A sync's fetch names the remote's branches and `refs/remotes/<remote>/` on its command line, so it takes no tag and removes no ref outside that folder, such as a tag of yours, whatever `remote.<name>.fetch`, `remote.<name>.tagOpt`, or `fetch.pruneTags` say, and it removes each remote-tracking branch there whose branch the remote deleted, so the push check takes as known only commits the remote still holds.
- Every command walks trees only as deep as Git's default `core.maxTreeDepth` of 2048 folders, and a first clone always names its remote `origin`, whatever `clone.defaultRemoteName` says.
- A variable such as `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ICASE_PATHSPECS`, or `GIT_ATTR_SOURCE` that Prism's process inherits never reaches a store command.

Prism keeps the settings that only choose how Git reaches the remote or who you are, such as credentials, `url.<base>.insteadOf`, `remote.<name>.pushurl`, `core.sshCommand`, proxies, and the store's own hooks, so a push that your own settings or a hook refuse fails with `push_rejected` and Git's message.

A remote that Git reaches by a path or a `file://` URL, such as a bare repository on a shared or synced folder, is different, because Git then runs the remote's side of a push or fetch on your machine, inside that repository and with its configuration.
Git trusts that repository's own settings by design, so Prism runs Git's `receive-pack` and `upload-pack` there with settings of its own, for every sync and the first clone, that turn off every remote-side program Prism knows of:

- `core.hooksPath` names the empty folder `no-hooks` in Prism's application folder, so no hook in the remote's `hooks` folder or in a `core.hooksPath` its configuration names runs.
- `core.alternateRefsCommand` is a command that lists nothing, and `core.alternateRefsPrefixes` is empty, so no command that the remote's configuration names runs for an `objects/info/alternates` file.
- `receive.denyCurrentBranch` is `refuse`, so a push never checks out a non-bare remote's branch with that repository's filters or `core.fsmonitor`, and a push to a branch that a non-bare remote has checked out fails with `push_rejected` and Git's message.
- `receive.autogc` is `false`, `gc.auto` and `gc.autoPackLimit` are `0`, and `maintenance.auto` is `false`, so a push starts no automatic maintenance, which would run commands that the remote's configuration names, such as `gc.recentObjectsHook`.
- On Git 2.54 and later, every hook event is turned off with `hook.<event>.enabled=false`, and each hook that the remote's configuration sets up with `hook.<name>.command` or `hook.<name>.event` is turned off by name, so no configured hook runs either.
  A hook whose name holds an equals sign cannot be turned off this way, so a sync with that remote fails with `git_failed` and names the hook, and you remove its `hook.<name>.*` settings from the remote repository's configuration.
- A push sends no push certificate, because the remote's side would check one with the `gpg.program` that the remote's configuration names, and only the remote's hooks, which never run, would read it.

Prism finds that repository the way Git does, so a `file://` URL with `%20` for a space, a path with trailing slashes, a path that starts with `~/`, and a folder whose `.git` is a file all work, for a sync and for a first clone whose URL a `url.<base>.insteadOf` rule of yours turns into such a path.
It then gives Git the repository's absolute path for the sync's fetch and push and for the first clone, reads the hook names from that repository, and names a helper that enters that same repository whatever path Git hands it, while your remote's URL and your URL settings stay as you set them.
If one of your `url.<base>.insteadOf` rules, or for a push one of your `url.<base>.pushInsteadOf` rules, matches that absolute path, Git would reach another place for it, so the sync fails with `git_failed` and the first clone with `store_unavailable`, and the message names the path; change the rule so that it no longer matches.
If Prism cannot tell which repository Git would open, as for `~otheruser/`, a folder on the way whose name is not UTF-8, or, on Windows, a path with a reserved name such as `con`, the sync fails with `git_failed` and the first clone with `store_unavailable`, and the message names the URL; name the repository by its absolute path or a `file://` URL of it, or rename the folder, instead.
If Git finds no repository at such a URL, for example because the shared folder is not mounted, no helper starts: the sync neither fetches nor pushes and reports `fetch_failed`, or `push_rejected` for a push URL, and the first clone fails with `store_unavailable`.
A push whose URLs reach both such a repository and an SSH or HTTPS remote also fails with `git_failed`, so give each of them a remote of its own.

These settings narrow what the folder's repository can make Git do, but they do not make the folder safe to share with anyone.
Anyone who can write a folder store's repository can still affect what Git does on every machine that syncs with it, for example through a setting a later Git adds or one changed while a sync runs.
So make such a folder writable only by people you trust that far, and use an SSH or HTTPS remote to share a store with anyone else.

A remote that Git reaches by SSH, `git://`, or HTTP runs its own server's side of the push or fetch, so Prism leaves it as it is.
A `remote.<name>.uploadpack` or `remote.<name>.receivepack` that you set in the store is your own transport setting, so Prism runs that program as you set it, without these settings.

Before the clone writes any file, Prism checks the remote's whole branch, and every sync checks the upstream's whole branch the same way before it takes any of it.
A symbolic link, a submodule link, a path that some file system reads as leading outside the store, such as one with a `..` part, a backslash, or a drive form, Git's folder or the sync folder `.prism-sync/` in any spelling, an entry where Prism keeps a folder, such as a file named `initiatives/<slug>/slices`, or an entry below a file Prism keeps, such as `roadmap.json/x`, fails the clone, or refuses the sync as a whole, and the message names the path.
So does a path that some supported machine cannot hold, because Git for Windows refuses it even in Git's index: a part that is a Windows device name such as `aux.md`, `con.json`, or `NUL`, a part that ends in `.` or a space, or a part that holds `<`, `>`, `"`, `|`, `?`, `*`, or a control character.
So do two paths that differ only in letter case, such as `notes/Plan.md` and `notes/plan.md`, because macOS and Windows read them as one file.
So does a path that is not UTF-8, as an older Git on Windows could commit, because macOS and Windows cannot hold it either, and the message shows each byte that is not UTF-8 as `\x` and two hex digits.
So does a file Prism shares whose name holds more than 200 bytes or whose path holds more than 512, because every write goes through a temporary file about 30 bytes longer than the name, which some machine's file system could not hold.
So does any entry, file, folder, or link, at any folder, whose name Git reads as `.gitmodules` or `.gitattributes` on some machine, other than the store's own `.gitattributes` file at its root: such as `.GitModules`, `notes/.gitattributes`, a folder named `.gitattributes`, a Windows short name such as `GITATT~1`, or `.gitattributes` followed by a byte that is not UTF-8 or by a trailing backslash.
A store shares no `.gitmodules`, and Git checks the contents of every file it reads as either one, in ways that changed between releases, so this rule keeps a store's every tree one that every supported Git takes.
Any other file on the branch, such as a `.DS_Store` or a notes file that an earlier Prism committed, a README below the root, or a lock file, stays in Git only: Prism never writes it to disk, and no sync of any machine changes or removes it, so it never stops a sync.
A sync gives the branch the remote's copy of each such file before it pushes, so a commit of yours in the store that removes one can be undone by a sync before you push it.
To remove such a file, use a separate clone of the remote instead of the store:

1. Clone the remote into a new folder, for example `git clone <remote> prism-store-edit`.
2. In that folder, remove the file with `git rm -- <path>` and commit the removal.
3. Push the commit with `git push`, and delete the folder.

The next sync of each machine takes the removal.
A sync commits only the files Prism shares, so Prism never commits another file or a link you put in the store, and the remote's latest tree never holds one.
A commit you make by hand in the store is different: the next sync pushes it as part of the branch's history, so every file it holds reaches the remote's history and every clone fetches it, although Prism's next commit takes those files out of the branch's latest tree.
So never commit a file by hand in the store that you would not share with everyone who can read the remote.
A sync never commits a file that another machine could not take, and every other change still syncs:

- A file Prism shares whose name holds more than 200 bytes or whose path holds more than 512 stays on disk and out of every commit.
- A file whose Git object fails the checks that another machine's fetch or first clone applies, such as a `.gitattributes` with a line over 2048 bytes, stays on disk, and the branch keeps its earlier version.
- A file larger than its kind's limit in the table below stays on disk, and the branch keeps its earlier version, if it has one.
  This holds also for a file that grows past its limit while a sync reads it, so no commit that a sync makes holds a file above its limit.
- A comment folder that holds more than 1000 comment files commits every comment the store already shares and then this machine's other comments by file name up to 1000, and the rest stay on disk.
- A store holds at most 250000 files in all, so when this machine's new files would take it past that, the files the store already shares and then this machine's new files by path are committed up to 250000, and the rest stay on disk.

The sync's status lists each such file under `withheld` with the reason, and its message names the path and the fix that fits the reason.
Give a file whose name or path is too long a shorter one, make a file above its kind's limit smaller than that limit, or fix a file that Git's object checks refuse, and the next sync commits it.
A file left out because the store would hold more than 250000 files is committed once the store holds fewer files, so remove files that the store no longer needs.
A comment file left out of a folder past 1000 is different: no sync ever commits it, and while it is there no reader shows any of that file's comments, so move it out of its comment folder, keeping what it says if that matters, and the folder's other comments show again.

Every kind of file that a store shares has a size limit well above the largest file of that kind that Prism or a Git host writes:

| Kind | Store path | Limit |
| --- | --- | --- |
| Artifact | `artifacts/<location>` | 16 MiB |
| Accepted bytes | `artifact-accepted/<hash>` | 16 MiB |
| Status record | `artifact-status/<location>/status.json` | 16 MiB |
| Identity file | `artifact-identity/<location>` | 256 bytes |
| Comment | `artifact-comments/<location>/<name>.json` | 64 KiB |
| Move ledger | `artifact-migrations/<name>.json` | 16 MiB |
| Record migration file | `migrations/<name>.json` | 16 MiB |
| Registration | `repositories/<repository>.json` | 64 KiB |
| Roadmap record, initiative record, coordination state, change map | `roadmap.json`, `initiatives/<initiative>/initiative.json`, `initiatives/<initiative>/state.json`, `initiatives/<initiative>/slices/<slice>/change-map.json` | 1 MiB |
| Review ledger, design view, kept frozen tests, run entry | `review.json`, `design-view.json`, `frozen-tests.json`, and `runs/<id>.json` below `initiatives/<initiative>/slices/<slice>/` | 4 MiB |
| Claim | `initiatives/<initiative>/claims/<slice>.json` | 64 KiB |
| Root README or license | `README`, `README.md`, `README.txt`, `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `COPYING` | 1 MiB |
| Root Git file | `.gitattributes`, `.gitignore` | 64 KiB |

A file's comments are limited too: a file takes at most 1000 comments, so its comment folder holds at most 1000 comment files.
The `README` and license files at the store's root and the `.gitattributes` and `.gitignore` there take their limits as every other kind does, although Prism never reads them, because every sync writes, merges, and saves them as it does every other file.
A sync refuses an upstream that holds one above its limit and withholds a local one above it, as for every other kind.
When both machines change one of them, a sync merges their lines as it merges other files, and when the same lines changed, or the merged file would pass its limit, it keeps the other machine's version and saves this machine's copy under `.prism-sync/conflicts/`.
The next tool result names the file and its saved copy and says that the other machine also changed it.
When this machine removed one of them while the other machine changed it, the sync puts the other machine's version back, and the next tool result lists the file under a line that begins `Store sync undid this machine's removal of`, as `- <path> in the record store at <store>`.
Prism treats a file larger than its limit as a damaged file of its kind and reads none of it: a status record reads as one that no gate changed, a ledger or record migration file lists nothing, a comment is no comment, a comment folder of more than 1000 entries holds no comment, and `get_artifact` refuses such an artifact with `artifact_too_large`.
No Prism write makes a file larger than its limit, and a move whose ledger would pass 16 MiB writes it as several ledger files, which its report names.

A sync refuses an upstream whose branch holds a file larger than its kind's limit, or a comment folder of more than 1000 comment files, with `merge_failed` and a message that names the path, and the store stays as it was, so no reader on this machine ever loads the file.
To recover, shrink or remove that file, or remove comment files from that folder, on the remote's branch from a separate clone, as for an entry that no store may hold, and the next sync of each machine merges again.
A sync also lists no more of a branch than 250000 files, and refuses an upstream whose branch holds more in the same way, with a message that gives that bound, so remove files from the remote's branch to recover.
A commit you made by hand that takes this store's branch past 250000 files is refused before the sync merges, with the command that takes that commit off, as for a file larger than its limit.
When the files that both machines added would take the merged store past 250000, the merge keeps every file of the other machine and then this machine's added files by path up to 250000, and the rest stay on disk, out of every commit, and are listed under `withheld` as above.
When both machines made one file larger and their merge would pass its limit, the file keeps the other machine's version, and this machine's is saved under `.prism-sync/conflicts/` and named as a line conflict is.
When the version of a file that both machines last shared is larger than its kind's limit, as a commit made elsewhere can leave in the remote's history, and both machines changed it since, the sync never reads that version: the file keeps the other machine's version, and this machine's is saved under `.prism-sync/conflicts/` and named as a line conflict is.
When the comments that both machines added would take a comment folder past 1000, the folder keeps every comment of the other machine and then this machine's by file name up to 1000, and each of the rest is saved under `.prism-sync/conflicts/` and named to the agent.
When another machine changes or removes a file whose version this machine withheld, the next sync takes the other machine's version, saves this machine's under `.prism-sync/conflicts/`, names it as a conflict, and keeps syncing.
The next tool result names a saved file that was larger than its kind's limit for that cause: this machine held it back for its size, the other machine then changed or removed it, and the store keeps the other machine's version.
A sync never reads a withheld file that is larger than its kind's limit, whatever its size, and never adds it to Git: when the other machine changes or removes that file, the sync moves this machine's file into `.prism-sync/conflicts/` by renaming it there, and every other change syncs.
Prism keeps sharing the store's `.gitattributes`, which Git hosts read to collapse records in pull request diffs, because this check keeps every version of it that a sync commits one that every machine can fetch.
Before every push, Prism also checks every object that the push would send with those checks, because an object the remote holds stays in its history even after a later commit removes the file.
Prism applies Git's own checks of every commit and tree in those objects itself, as Git 2.43 and later make them, so the check holds on an older Git that checks less, such as Git before 2.43, which takes a name over 4096 bytes and a folder nested more than 2048 folders deep, which Git 2.43 and later refuse to walk, Git before 2.40, which takes a commit date after a carriage return, or Git before 2.27, which takes a tree that holds a file and a folder of one name.
It also checks the `.gitattributes` at the root of every tree in those objects as Git 2.43 does, refuses every other entry in them whose name Git reads as `.gitmodules` or `.gitattributes`, since Git before 2.39.1 does not check a `.gitattributes` and Git before 2.30.1 takes more `.gitmodules` URLs, and refuses a symbolic link whose target leads into Git's folder or holds more than 260 bytes, which Git 2.39.4, 2.43.4, 2.45.1, and the other releases of May 2024 refuse.
A push whose objects fail them, such as one of a commit you made by hand, is refused with `merge_failed`, and the message names the file and the exact command that takes that commit off the store's branch while every file stays on disk.
The command is `git reset --soft` with the tip of the remote's branch when the remote holds the branch, else with the commit before the first commit that the remote lacks and that holds the file, or `git update-ref -d HEAD` when that commit is the branch's first, as on a store's first publish.
After each fetch and push the store records under `refs/prism-store/shared/` the latest commits of its own branch that the remote's branches held, which is the commit this machine pushed, a fetched tip that its branch holds, or the last commit its branch shares with a fetched tip that it has not merged.
It counts those commits as ones that the remote and other machines already hold, also after the remote's branch is deleted, and keeps only commits that its branch holds, so these refs stay few and never lose a commit of its branch that other machines share.
So the command never takes off a commit that other machines share, and where the commit before that first commit would, it goes back to the last commit of the branch that other machines share instead.
Where no single commit does that, the message gives no command and says what to change instead, such as moving the comment files past the first 1000 out of their folder, after which the next sync commits their removal.
Run the command in the store as the message gives it and fix the file, and the next sync commits the store's files again without that commit, withholding the file while Git's object checks still refuse it.
A push is refused in the same way when the branch, or a commit of it that the remote does not hold yet, holds a file larger than its kind's limit, such as a 2 MiB `README.md` committed by hand, since every other machine's sync would then refuse the remote's branch.
The message names the file, says that the store's other changes are committed on this machine only, and gives the command for that commit in the same way; run it in the store, which keeps every file on disk, and the next sync commits and pushes the other changes and withholds the large file until it is smaller than its limit.
When the other machine changed the remote's branch meanwhile, the sync refuses such a file in a commit that this machine made before it merges anything, by its size alone, so a file of any size, such as one of 70 MiB, is named in the same way and never read.
The command then goes back to the commit before the first commit that holds the file rather than to the tip of the remote's branch, since the other machine's changes are not on disk yet, and the next sync merges them as usual.
A clone that an earlier Prism checked out with CR LF line endings is migrated once, on its first record access or sync after the upgrade, before Prism writes anything to it.
The migration gives each file at a path Prism shares whose only difference from the branch's version is CR LF line endings the branch's bytes again, and records in `.prism-sync/raw-files.json` that the clone is migrated.
From then on, a change of line endings alone, such as an artifact rewritten with CR LF line endings, is a change like any other, and the next sync pushes it.
Syncing requires Git 2.25 or later, so the Git that Xcode's command line tools, Ubuntu 22.04, or Debian 12 installs syncs.
On an older Git, every record operation of a remote store, or of a path store with sync on, fails with `store_unavailable`, and the message names this machine's Git version and the minimum.
SSH runs in batch mode unless you configured an SSH command, and Git never prompts, so a remote that needs a passphrase or password prompt fails instead of hanging.
Use an SSH agent or a Git credential helper for a remote that needs credentials, because a token in the URL stays in the clone's Git configuration, although Prism leaves it out of every message and status.

These problems make every record operation fail with `store_unavailable`, and the message names the remote without any user name or token:

- The clone failed, for example because the remote cannot be reached, sent an object that fails Git's object checks, or holds an entry that no store may hold; Prism leaves no partial clone behind and tries again on the next access.
- A folder already sits at the clone path with another origin; Prism leaves it untouched, so move it away.
- This machine's Git is older than 2.25; update Git.

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
On a Git older than 2.25, every record operation of such a store fails with `store_unavailable`, which names the Git version; update Git, or turn sync off.
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
Two registrations that differ only in when each machine registered the name, as the first accesses of two machines to a new store write them, lose nothing, so the sync keeps the upstream one and saves neither.
A remote or root commit added to an existing registration does not wait: the next sync pushes it, and the next check that needs it adds it again if a sync lost it.
Each name is a file of its own, so two machines that register one remote under two different names at the same time both keep their registrations, because `repository_remote_registered` refuses a second name for a remote only once the store holds the first.

A checkout whose configuration names a store but no repository is refused with `repository_name_missing` on every record operation, registers nothing, and writes nothing to the store, while the records it holds under `.prism` stay where they are until the name is committed and its first record operation moves them.
A verification run or contract-defect report of a named checkout records the name as its repository, while a checkout without a store keeps recording the root commit.
Naming a repository changes no record, migration entry, or run that the store already holds, and a store's migration marker from before Prism listed moved records keeps covering the repository after it is named.

## When two people change the same record

Changes to different initiatives in the roadmap, or to different slices or proposals of one initiative, merge, and both history entries are kept.
A roadmap reordered on one machine keeps that order, and an initiative added on the other machine lands after the initiative it followed there.
Two changes collide when they change the same initiative or slice differently, reorder the roadmap differently, or merge into a record that fails validation, such as a dependency cycle between two slices.
An initiative's coordination state merges as well, so a setting you change in the review app on one machine and an agent's state write on another both survive, and both machines' history entries are kept.
In coordination state, different settings, gates, active slices, closed gates, and evidence paths merge, and a gate or active slice ended on one machine stays ended.
A setting changed differently on both machines keeps your later change from the review app, and a gate answered differently on both machines keeps the earlier answer.
Coordination state collides when two agents set one setting differently, when a gate's question or options differ between the machines, when one slice's active work or another field such as `next` changed differently on both, when the merged state fails validation, or when it exceeds 1 MiB without its history and closed gates.
An initiative's coordination state stays within 1 MiB.
When a write or a merge would exceed that, the oldest history entries give way first and then the oldest closed gates, so your settings and open gates are always kept, and a write always keeps the history entry of the change it records.
A history entry or closed gate that gave way on either machine stays gone after a merge, and an agent is never told about it later.
A write is refused with `artifact_too_large` only when the state exceeds 1 MiB with all of its history and closed gates gone.
Other records, such as slice claims, collide whenever Git cannot merge their lines.
In a collision the first push wins.
The machine whose push lost keeps the upstream version and saves its own version under `.prism-sync/conflicts/<time>/` in the store, so no bytes are lost.
The next Prism tool result on that machine names the record and the saved file, so the agent that made the change learns of it.
Compare the saved file with the current record, and redo the change through Prism's tools if it still matters.
Prism never replaces a record that changed while a merge was running: it leaves the branch where it was and resolves the change on the next sync.
Prism reads every JSON file of the store, whether a record, a status record, a comment, an artifact's identity, a move ledger, or a repository registration, as damaged when it nests arrays and objects more than 64 levels deep, which Prism never writes, so a file that a sync brings in such a form stops no tool call and no review page: each reader leaves it out as it leaves out any file that is not valid JSON, and a merge of such a record collides.
Two records whose paths differ only in letter case settle the same way on file systems that ignore letter case, as macOS and Windows use by default: a sync removes the spelling that lost before it writes the upstream's, and gives a folder that still holds other files the upstream's spelling.
A sync saves the local versions that lost under `.prism-sync/saving/` before it replaces any file, so a sync that stops partway, for example because its server exits when the host closes, loses none of them.
The next sync on that machine moves the versions of the files the stopped sync replaced to `.prism-sync/conflicts/` and drops the others, which the merge saves again when it runs, even when such a file changed in between, so each lost version is saved once.
Each saved version stays pending in `.prism-sync/notices/` until a tool result has named it, so a sync that stops after it saved a version and before its status was written still has the version named by the next server's tool result.
Only a result that the server writes to its host counts, so any call that the host cancels before its result is written, such as a `wait_for_user_gate` or a slow `update_coordination_state` you stop with Esc, gets no response and leaves the version pending for the next result, and so does a call that the session's end aborts.

## When two people change the same artifact

With store sync on, each `update_artifact` that changes a file, and each plan file or view that Prism writes into the store, is committed and pushed by the next sync without a further call.
Changes to different lines of one artifact on two machines merge, so in a file with one sentence per line, edits to different sentences both survive.
A file that is not text, such as an image, has no lines to merge, so a change to it on both machines counts as a change to the same line.
When both machines change the same line differently, one machine makes a file where the other made a folder of the same name, or the two machines write paths that differ only in letter case, the first push wins.
This holds on file systems that ignore letter case, as macOS and Windows use by default, as well: a sync removes the spelling that lost before it writes the upstream's, and gives a folder that still holds other files the upstream's spelling.
A change of a file's or folder's letter case on another machine, such as a removal of `plans/Foo` and a write of `plans/foo`, reaches every machine the same way.
The machine whose push lost keeps the upstream artifact and saves its own files under `.prism-sync/conflicts/<time>/artifacts/` in the store, so no bytes are lost.
Every artifact in the store has an identity, kept beside it in the file `artifact-identity/<location>`, which syncs like a status record.
Writing a file where the store holds none gives it a new identity, also when an earlier file at that path was removed, while editing or rewriting a file keeps its identity.
Moving a file to another scope with `move_scope`, or a generated view's move to its plans folder's scope, takes its identity, status record, and comments to the new place and leaves nothing of it at the old one.
Removing a file removes its identity with it.
A file stored before Prism wrote identities, or whose identity file is damaged or copied from another file, has the identity that its place in the store gives, so an older store needs no migration.
No two files of a store share an identity, also when copied identity files would chain one onto another, so a merge never removes a file that neither machine removed.
A sync refuses an upstream that holds anything below `artifact-identity/` other than the identity file of an artifact's place, such as a file at `artifact-identity/plans`, where Prism keeps folders of identity files.
An entry at a file's identity path that is no identity file, such as a folder a sync brought, belongs to no file, so creating, moving, or removing that file replaces or removes it in the same update.
A sync merges each file by its identity rather than by its path, so a change that the other machine made at the old place before it synced, to the file's text, its status record, or its comments, lands on the moved file as if it had been made there.
So an approval answered on one machine while another moved the requirement approves the moved requirement, and a comment made meanwhile shows on it.
The text and the status record merge by lines there, so a change that only one machine made is kept, and one that both machines made to the same line keeps the upstream version and saves this machine's, as for any artifact; a status record is one line, so an approval answered on one machine while the other asked a new approval keeps the other machine's record, merges the approved status lines into the text, and saves and names the answered record.
A change made on a file that the other machine removed, whether or not that machine then wrote or moved another file to its path, never lands on that later file: the later file keeps its text, status, and comments, and the changed text, status record, and comments are saved under `.prism-sync/conflicts/<time>/` of the machine whose sync met the two changes and named in its next tool result.
A removal stands against every change of the other machine that left the file's text as it was, such as a comment, an approval asked, a request for changes, a status change alone, or a move to another scope, whichever machine synced first, so a file that the removing machine wrote or moved to that path keeps it.
Only an edit of the file's text that reached the store first, such as an approval, which rewrites the file's status lines, undoes the other machine's removal: the file comes back with the edit, a file that the removing machine moved to its path goes back to the scope it came from, and one that it wrote there is saved and named.
Every removal, move, or edit of this machine that a sync does not keep is named once in the next tool result: a saved copy names an edit, and a later file saved at the path also names the removal that gave way there.
Any other removal that a sync undid is listed under a line that begins `Store sync undid this machine's removal of`, as `- <path> in scope <scope>`.
A move to another scope that a sync sent elsewhere, as when both machines moved one file to different scopes, which keeps the other machine's scope, or when the path it was moved to keeps the other machine's file, is listed under a line that begins `Store sync undid this machine's move of`, as `- <path> in scope <scope>, which this machine moved to scope <scope>`, naming first the scope that the file stays in.
An artifact that one machine moved by removing it and writing similar text at another path is a new file there, so a change the other machine made at the old path is saved, and a file it added to a moved folder stays where it was written.
A status record or comment that a merge leaves where the store holds no artifact, such as one written on one machine while another removed the artifact, leaves the store and is saved under `.prism-sync/conflicts/<time>/`, and the next tool result names the file's path, its scope, and the saved copy.
The result quotes a saved comment's line and text only when the saved file is a comment in the exact form Prism writes, and names any other file there by its path, scope, and saved copy alone, so a file that a sync brings puts no other text before the agent.
A status record or comment whose place at the moved file would need a path longer than a store can share, a name of more than 200 bytes or a path of more than 512, is saved under `.prism-sync/conflicts/<time>/` too, while the rest of the change is placed.
The sync's message and the next tool result name it for that cause: they say whose change it holds, that its path would be too long at the file's new place, and name that place, where the store keeps the file without it.
Each file merges by itself, so a file that only one machine wrote stays, even in a folder that takes the place of a file both machines removed.
The next tool result of each running Prism server on that machine that uses the store names the artifact's path, its scope, and the saved copy, and a server started later names it too until a tool result has carried it.
The notes that name saved files and undone changes hold at most 32 KiB in one result: the lists of undone removals and moves come first, each list keeps the line that says what was saved or undone and why, entries past the bound are left out from the end, and a last line counts them, whether they name saved files or undone changes, and names the store's sync folder, which holds every saved copy.
Read the artifact again with `get_artifact`, and redo the change with `update_artifact` if it still matters.
A sync that starts while an artifact update is still writing leaves that update to the next sync, so it never merges the upstream over a change in progress.
A sync saves the local versions that lost under `.prism-sync/saving/` before it replaces any file, so a sync that stops partway, for example because its server exits when the host closes, loses none of them.
The next sync on that machine moves the versions of the files the stopped sync replaced to `.prism-sync/conflicts/` and drops the others, which the merge saves again when it runs, even when such a file changed in between, so each lost version is saved once.
Each saved version stays pending in `.prism-sync/notices/` until a tool result has named it, so a sync that stops after it saved a version and before its status was written still has the version named by the next server's tool result.
Only a result that the server writes to its host counts, so any call that the host cancels before its result is written, such as a `wait_for_user_gate` or a slow `update_coordination_state` you stop with Esc, gets no response and leaves the version pending for the next result, and so does a call that the session's end aborts.

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
While files that Git tracks under a checkout's requirements, ADRs, plans, glossary, or roadmap paths still wait in the checkout, the status bar warns of them beside the store, and an agent's Prism tool call in the checkout moves them into the store and reports each move or why a file stays, while the review browser itself never moves them and lists only the store's copies.
An agent session moves a checkout's files once, so a file that Git starts tracking after that move waits for the next session.
A moved file leaves the checkout only right before Prism writes the result that reports it, so a tool call that Prism refuses or that you interrupt writes the store's copies but leaves the files in the checkout, and the next tool call whose result is written removes them and reports the move.
An interruption that comes after a file left the checkout but before the result was written can leave that removal unreported, so the first Prism tool call of each later agent session reports such a file as moved earlier, with the tracked files that still name its old path, until you stage or commit its removal.
Files that a move kept in the checkout, such as an image in a plan folder or a file whose store copy differs, are counted apart beside the store as a plain note, without names, since they stay until a person settles each as the move's report said, and no tool call moves them.
When the last sync did not succeed, clicking the sync state opens its message, its time, and every saved conflict.
Each saved conflict shows the saved local copy against the current record as a diff, so you can ask an agent to redo the change that lost.
A saved copy or current record larger than its kind's limit, or one that is a link, shows its size and where the copy stays instead, because Prism reads none of its bytes.
The list shows saved records, while a saved artifact is named in the next tool result as described above.

| State | Meaning | What to do |
| --- | --- | --- |
| `ok` | The last sync committed, merged, and pushed; a file it left out is listed under `withheld`, and its message names it with the fix that fits its reason. | Nothing, or give each withheld file the fix that the message names for it. |
| `conflicts` | A record, an artifact, or a README, license, `.gitattributes`, or `.gitignore` at the store's root changed on both sides in a way that does not merge, so this machine's version is saved under `.prism-sync/conflicts/`; where this machine's removal of an artifact stands against the other machine's comment or status record, that change of the other machine is saved there instead, a comment or status record of either machine whose path would be too long at its moved artifact's new place is saved there too, and a local removal that gave way saves nothing. The message says whose copy each saved file holds and why. | Review the saved file. |
| `no_upstream` | A path store's branch has no upstream, so Prism only commits locally; a remote store sets its upstream on its first sync instead. | Set an upstream with `git branch --set-upstream-to`. |
| `not_a_repository` | Sync is on, but the store is not the top of a Git checkout. | Clone the store, or turn sync off. |
| `fetch_failed` or `push_rejected` | The remote could not be reached, sent an object that fails Git's object checks, refused the push, or kept moving for three attempts. | Check access to the remote; Prism retries on the next write or read, and a commit whose objects fail the checks needs removing from the remote's history. |
| `merge_failed` | A file other than a record, an artifact, or a README, license, `.gitattributes`, or `.gitignore` at the store's root conflicted, a record or an artifact stayed locked through every attempt, the store's branch and its upstream share no commit, the merge would hold a file Prism does not write and a file Prism writes whose paths differ only in letter case, or the upstream's branch holds a file larger than its kind's limit or a comment folder of more than 1000 comment files, the branch to push, or a commit of it that the remote lacks, holds a file larger than its kind's limit, the upstream's branch or the branch to push holds an entry that no store may hold, such as a symbolic link, a submodule link, the sync folder, a name that Windows refuses, a path that is not UTF-8, a name too long for some machine, or two paths that differ only in letter case, or the push would send an object that fails Git's object checks. | Read the status message; a busy record clears on its own, an entry that no store may hold, a file over its limit, or a comment folder over 1000 needs a commit on the remote's branch, made from a separate clone, that removes or shrinks the path the message names, and an object that fails the checks, or a file over its limit that a commit made by hand put on the branch to push, needs the commit that holds it taken off the store's branch with the `git reset --soft` or `git update-ref -d HEAD` command that the message gives, or, where the message gives no command, the change it names instead. |
| `git_failed` | Git failed for another reason, such as a leftover `.git/index.lock`, or this machine's Git is older than 2.25. | Fix the store with Git, or update Git; Prism never deletes Git's locks. |

## Cloud sessions

A cloud session clones a remote store into its own application folder on its first record access, like any other machine.
The session needs read and push access to the store repository, so add the store repository to the project's repositories, or otherwise let the session reach it with push access.
A cloud session that attached the store repository with push access could push to the store's `main` branch in a test on 2 November 2026, so sync works there without changes.
A session that may push only its own `claude/...` branch reports `push_rejected` and keeps its records in its own clone until a person merges them.
A path store such as `Store: ../prism-store` still works in a cloud session, because the session clones each of its repositories next to each other under `/home/user/`.

## How it works

The [external record store](../ADRs/workflow-records/external-record-store.md) and [Git sync](../ADRs/workflow-records/record-store-git-sync.md) decisions define the rules, and [record-store-architecture.puml](../ADRs/workflow-records/record-store-architecture.puml) shows how checkouts, the store, and the remote fit together.
The [slice claims](../ADRs/workflow-records/slice-claims.md) decision defines who may work on a slice.
