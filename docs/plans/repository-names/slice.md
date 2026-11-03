# Repository names in a shared store

## Contract

### Configuration

1. A checkout's repository name is the value of `- Repository: <name>` under `## Workspace` in its `.prism/workflow.md`, read with the same label rules as `Store`, and only when `Store` names a record store; without a store a `Repository` line is ignored and nothing below applies.
2. A valid name matches `^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`, so it has 1 to 64 characters and never holds `/`, which a later increment uses in `<repository>/<component>`.
3. An invalid name refuses every record operation with `repository_name_invalid`, whose message says the name must use lowercase letters, digits, hyphens, or underscores, starting and ending with a letter or digit, and shows `- Repository: <proposed>` (§12).

### Remotes

4. A checkout's remote is its `remote.origin.url`, shown and stored as its scheme, host, and path without user information, query, or fragment, exactly as run records already show it.
5. A checkout has no network remote when it has no origin, or its origin is a local path, a `file://` URL, or any value that run records would record as unknown.
6. Two remotes are the same remote when their lowercase host without a port and their path without leading or trailing `/` and without a trailing `.git` are equal, whatever their scheme or user; the path keeps its case.

### Registration

7. A store registers each name in its own file `repositories/<name>.json` at the store root, never under a `.prism` address: `{ "schemaVersion": 1, "name", "remotes", "root", "registeredAt" }` as two-space JSON with a final newline, where `remotes` lists shown remotes (§4) in the order they joined, empty for a repository registered without a network remote, `root` is the checkout's repository identity from run records (first root commit, null in a shallow clone or before the first commit), and `registeredAt` is an ISO date-time.
8. Before a record operation of a named checkout reads, writes, migrates, or creates housekeeping files in the store, Prism checks the name against the store's registration, and only a check that accepts lets the operation continue.
9. An unregistered name is registered with the checkout's remote and root, unless another registration lists the same remote (§6); then every record operation is refused with `repository_remote_registered`, whose message says the remote is registered in the record store as repository `<other>` and shows `- Repository: <other>`.
10. A registered name accepts the checkout when the checkout's remote is the same as a listed remote, when the checkout has no network remote and `remotes` is empty, or when the checkout's root is known and equals the registered root; acceptance by root appends the checkout's remote to `remotes` when it has one, and acceptance by remote fills a null registered root with the checkout's root when it is known.
11. Otherwise every record operation is refused with `repository_name_taken`, whose message names the name, the registered remotes or `no network remote`, and the checkout's remote or `no network remote`, says why history could not prove a move when that is the reason (`shallow` clone, a registration with `no root commit`, or a checkout without commits), and says to run `git fetch --unshallow` if this is the same repository moved on its host, or else to name the repository differently, showing `- Repository: <proposed>`.
12. A proposed name is the name of the first registration, in name order, that would accept the checkout under §10; otherwise it is the last path segment of the checkout's remote without `.git`, or the checkout folder's name when the checkout has no network remote or its remote has no path segment, lowercased, with each run of other characters replaced by `-`, trimmed of leading and trailing `-` and `_`, cut to 64 characters, and `repository` when nothing is left; a candidate registered for another repository takes the first free suffix `-2`, `-3`, and so on, cut so the whole stays within 64 characters.
13. Each refusal is a JSON-RPC error whose `data` is `{ code, proposed }`, and a refused operation leaves the store's files and the checkout's records byte for byte as they were.
14. The review browser shows a refused checkout as it shows an unavailable store: its records are hidden and its documents still list.
15. A change to `Repository` or to the origin takes effect in a running server within 5 seconds.

### Checkouts without a name

16. A checkout whose configuration names a store but no repository name keeps every record operation working as before, on its root-commit identity, and registers nothing.
17. Every tool result whose call opened that checkout's record store ends with one text item saying the checkout names a record store but no repository name, to add `- Repository: <proposed>` (§12) under `## Workspace` in `.prism/workflow.md` and commit it, and that a later Prism release will refuse record operations without it; `structuredContent` is unchanged.

### Records

18. A verification run or contract-defect report of an accepted named checkout records the name as `checkout.repository`; every other checkout keeps recording its root commit there.
19. Registering, checking, or naming changes no record, migration-ledger entry, or run that the store already holds.
20. A migration-ledger marker from before the ledger, named by a root commit, keeps making every checkout with that root commit skip migration, named or not.

### Store sync

21. Registration files are store sync records: a registration changed on both sides keeps the upstream version and saves the local one, and a registration that lost is reported only through the refusal or acceptance it causes, never in the store's sync status conflicts or a saved-conflict note.
22. Where store sync is on and the store has an upstream, a new registration is confirmed before the operation continues: Prism syncs the store and checks the checkout again against the registration the store then holds, so another machine's registration that won accepts or refuses the checkout under §10 and §11.
23. When that sync reports anything but `ok`, `conflicts`, `no_upstream`, or `not_a_repository`, Prism removes the registration it wrote, if the file still holds it, and refuses with `repository_unconfirmed`, whose message names the name and the sync state.
24. A remote or root that §10 adds to an existing registration is written without confirmation, and an addition that a sync loses is made again by the next check that needs it.
25. Two machines that register one remote under two names at the same time both keep their registrations; §9 catches the second name only once the store holds the first.

### Checkouts on this machine

26. Each machine keeps its list of checkouts in `checkouts.json` in Prism's application folder, the folder that holds managed store clones: `{ "schemaVersion": 1, "checkouts": [{ "store", "repository", "path", "recordedAt" }] }` as two-space JSON with a final newline, where `store` is the real path of the store folder, the managed clone for a remote store, `path` is the real path of the checkout's project root, and entries are sorted by store, repository, and path.
27. A server records its checkout once per process, after the checkout's name check first accepts: at start in the background when the host names the project, and otherwise during the first tool call that names it; a refused, invalid, or unnamed checkout, or one whose store is unavailable, is not recorded.
28. Recording replaces any entry with the same path and drops each entry of the same store and repository whose path no longer holds a `.prism/workflow.md` naming that store and that repository name.
29. The list is written atomically under a lock; an unreadable list is replaced, and a list with another `schemaVersion` is left untouched and nothing is recorded, while record operations continue.
30. No checkout path is written to the record store.

## Assumptions

- Probed: `remote-url.mjs` `publicRemote` already gives scheme, host, and path without user information for HTTPS, SSH URL, scp, and `git://` forms and null for local paths and `file://`, but `normalizeRemote` keeps the scheme and the scp separator, so §6 needs its own comparison (`node docs/plans/repository-names/probes/probe-remotes.mjs`, observed `github.com:Acme/API.git`, `ssh://github.com/Acme/API.git`, `https://github.com/Acme/API.git/`, null for `file:///srv/api.git`, and normalized forms `github.com:Acme/API` and `ssh://github.com/Acme/API`).
- Probed: a full clone of a repository through another remote has the original's root commit, a depth-1 clone reports `--is-shallow-repository` true with another apparent root, and `git fetch --unshallow` restores the real root (`bash docs/plans/repository-names/probes/probe-shallow.sh`, observed roots `95286db…` for full and moved clones, `77abfb6…` shallow, `95286db…` after unshallow).
- Probed: store sync fails the whole merge when two clones add a store file outside `roadmap.json` and `initiatives/` with different bytes (`node docs/plans/repository-names/probes/probe-sync-addadd.mjs`, observed `merge_failed The upstream conflicts with local changes to repositories/api.json`), so §21 requires registration files to join sync's record files.
- Probed: a `RecordStoreError` reaches an MCP client as a JSON-RPC error without `data` (`node docs/plans/repository-names/probes/probe-mcp-error.mjs`, observed `{"code":-32603,"message":"The record store ../missing-store …"}` and no `data`), so §13 requires the server to pass the new codes through.
- Probed: the acceptance tests run real Prism servers over stdio against folder stores and a bare `file://` store remote, and fail today only where behavior is missing (`node --test test/server/repository-names.test.mjs`, observed 11 failing and the §20 and §1 guards passing; `repository-names-sync.test.mjs` 4 failing; `machine-checkouts.test.mjs` 4 failing and the §29 guard passing).
- Probed: a server whose test folder was removed while it was still syncing did not exit when its input closed, so the fixture closes every server before it removes folders and kills one that has not exited after 10 seconds (observed two `mcp.mjs` processes alive after the test ended, none after the fixture change).
- Unprobed: two different services on one host that differ only by port; §6 counts them as one remote, so the second can take the first's name, which a person can still undo by naming it differently.
- Unprobed: hosts that treat repository paths case-insensitively; §6 keeps path case, so a differently cased spelling is refused with both remotes named rather than accepted silently.
- Unprobed: Codex starting a server without naming the project; §27 records the checkout at its first tool call instead, as the review app already registers such projects.

## Slices

| Slug | Outcome | Requirements | Depends on | Frozen tests | Review |
| --- | --- | --- | --- | --- | --- |
| `repository-registration` | A named checkout registers its name and remote in its store, a clash is refused with the remotes and a free name, a moved repository keeps its name, and an unnamed checkout keeps working with a warning. | `repository-names.md§1`, `§2`, `§3`, `§4`, `§6`, `§7`, `§8` | | `test/server/repository-names.test.mjs`, `test/server/fixtures/repository-checkouts.mjs` | required: runs before migration and the ledger, so a mistake loses or resurrects records |
| `registration-sync` | Two machines that register one name at once end with one registration, and an unreachable remote withdraws the registration. | `repository-names.md§5` | `repository-registration` | `test/server/repository-names-sync.test.mjs` | required: changes which store files sync merges and which conflicts it reports |
| `machine-checkouts` | Each machine lists its checkouts of each named repository in Prism's application folder, never in the store. | `repository-names.md§9`, `§10` | `repository-registration` | `test/server/machine-checkouts.test.mjs` | none |

The overview is [overview.puml](overview.puml).
