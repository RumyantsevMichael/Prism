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
Prism shares the regular files at the paths it writes in a store: the records under `initiatives/`, `roadmap.json`, the registrations under `repositories/`, the migration files under `migrations/`, the store's `.gitignore` and `.gitattributes`, and the files under `artifacts/` that a later Prism writes there, whose every name begins with an ASCII letter or digit and holds only ASCII letters, digits, `.`, `_`, and `-`.
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

The sync's status lists each such file under `withheld` with the reason, and its message names the path, so rename, shorten, or fix the file, and the next sync commits it.
When another machine changes or removes a file whose version this machine withheld, the next sync takes the other machine's version, saves this machine's under `.prism-sync/conflicts/`, names it as a conflict, and keeps syncing.
Prism keeps sharing the store's `.gitattributes`, which Git hosts read to collapse records in pull request diffs, because this check keeps every version of it that a sync commits one that every machine can fetch.
Before every push, Prism also checks every object that the push would send with those checks, because an object the remote holds stays in its history even after a later commit removes the file.
Prism applies Git's own checks of every commit and tree in those objects itself, as Git 2.43 and later make them, so the check holds on an older Git that checks less, such as Git before 2.43, which takes a name over 4096 bytes and a folder nested more than 2048 folders deep, which Git 2.43 and later refuse to walk, Git before 2.40, which takes a commit date after a carriage return, or Git before 2.27, which takes a tree that holds a file and a folder of one name.
It also checks the `.gitattributes` at the root of every tree in those objects as Git 2.43 does, refuses every other entry in them whose name Git reads as `.gitmodules` or `.gitattributes`, since Git before 2.39.1 does not check a `.gitattributes` and Git before 2.30.1 takes more `.gitmodules` URLs, and refuses a symbolic link whose target leads into Git's folder or holds more than 260 bytes, which Git 2.39.4, 2.43.4, 2.45.1, and the other releases of May 2024 refuse.
A push whose objects fail them, such as one of a commit you made by hand, is refused with `merge_failed`, and the message names the file; fix the file, then move the store's branch back to the remote's with `git reset --soft @{upstream}` in the store, and the next sync commits the store's files again without that commit.
A clone that an earlier Prism checked out with CR LF line endings is migrated once, on its first record access or sync after the upgrade, before Prism writes anything to it.
The migration gives each file at a path Prism shares whose only difference from the branch's version is CR LF line endings the branch's bytes again, and records in `.prism-sync/raw-files.json` that the clone is migrated.
From then on, a change of line endings alone, such as a file rewritten with CR LF line endings, is a change like any other, and the next sync pushes it.
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
The review browser hides the records of a refused checkout as it does for an unavailable store, shows the refusal's message as the reason, and still lists its documents.

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
Two records whose paths differ only in letter case settle the same way on file systems that ignore letter case, as macOS and Windows use by default: a sync removes the spelling that lost before it writes the upstream's, and gives a folder that still holds other files the upstream's spelling.
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
When the last sync did not succeed, clicking the sync state opens its message, its time, and every saved conflict.
Each saved conflict shows the saved local copy against the current record as a diff, so you can ask an agent to redo the change that lost.

| State | Meaning | What to do |
| --- | --- | --- |
| `ok` | The last sync committed, merged, and pushed; a file it left out is listed under `withheld`, and its message names it. | Nothing, or rename, shorten, or fix each withheld file. |
| `conflicts` | A record changed on both sides in a way that does not merge; the local version is saved under `.prism-sync/conflicts/`. | Review the saved file. |
| `no_upstream` | A path store's branch has no upstream, so Prism only commits locally; a remote store sets its upstream on its first sync instead. | Set an upstream with `git branch --set-upstream-to`. |
| `not_a_repository` | Sync is on, but the store is not the top of a Git checkout. | Clone the store, or turn sync off. |
| `fetch_failed` or `push_rejected` | The remote could not be reached, sent an object that fails Git's object checks, refused the push, or kept moving for three attempts. | Check access to the remote; Prism retries on the next write or read, and a commit whose objects fail the checks needs removing from the remote's history. |
| `merge_failed` | A file other than a record conflicted, a record stayed locked through every attempt, the store's branch and its upstream share no commit, the merge would hold two paths that differ only in letter case, or the upstream's branch or the branch to push holds an entry that no store may hold, such as a symbolic link, a submodule link, the sync folder, a name that Windows refuses, a path that is not UTF-8, a name too long for some machine, or two paths that differ only in letter case, or the push would send an object that fails Git's object checks. | Read the status message; a busy record clears on its own, an entry that no store may hold needs a commit on the remote's branch, made from a separate clone, that removes the path the message names, and an object that fails the checks needs the commit that holds it taken off the store's branch. |
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
