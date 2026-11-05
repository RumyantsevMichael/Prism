# Repository intelligence

Prism can plan repository context and compare that plan with the capacity of a target implementation session.

## Choose a repository provider

Use `list_repository_intelligence_providers` to inspect the registered native, CodeGraph, and CodeNib providers for one project.
Discovery is read-only and never creates or updates an external index.
The native provider reports semantic search, hybrid ranking, and the symbol graph when its runtime supports the platform, because search prepares the index on first use.
`native.status` gives the preparation state, and `native.diagnostics` holds the first 20 of `native.totalDiagnostics` diagnostics.

| Provider | Role | Numeric `FIT` |
|---|---|---|
| Native | Bundled local semantic, lexical, code, and document analysis with verified source | Yes, when all required evidence is complete |
| CodeGraph | Adds lexical and typed structural evidence from an existing index | No |
| CodeNib | Adds hybrid semantic, lexical, and graph evidence | Yes, when all required evidence is complete |

Use `provider: auto` with `plan_repository_context` for normal operation.
Automatic selection prepares bundled native analysis without invoking external indexers.
The first analysis downloads pinned runtime and model assets, then inference runs locally.
Both come from Prism's GitHub release, so a restricted network, such as a cloud session, needs to allow only `github.com`.
When a release does not mirror the model, Prism downloads it from `huggingface.co`.
Downloads use the `HTTPS_PROXY` and `NO_PROXY` environment variables when the MCP server runs on Node 22.21 or later.
The default manifest contains published archives for all five supported platforms.
Prism verifies each downloaded archive against its pinned size and hash.
Subsequent analysis works offline when those verified assets remain cached.
Prism uses external evidence only after the adapter binds it to the same normalized source snapshot identity as native.
For CodeNib, this binding requires the same canonical project root, verified CodeNib source access, the same concrete commit, and a fresh complete native snapshot after CodeNib verifies its manifest.
CodeNib and native can use different private fingerprint schemes, so Prism does not compare those raw fingerprints.
Use `provider: native` to avoid every external executable.
Use `provider: codegraph` or `provider: codenib` when that exact contributor is required.
An unavailable explicit provider fails visibly instead of selecting another external provider.

```json
{
  "projectRoot": "/absolute/project",
  "provider": "auto",
  "task": "Add request validation.",
  "hints": {
    "files": ["src/service.mjs"],
    "symbols": ["handleRequest"],
    "concepts": ["validation policy"],
    "expectedModifiedFiles": ["src/service.mjs"]
  }
}
```

The native provider searches Git-tracked and nonignored text files when Git is available.
It uses a bounded filesystem scan outside Git repositories.
It records symbolic-link values within the native scan limits for freshness checks without following targets or exposing links as searchable source.
An enumerated path that is neither a regular file nor a symbolic link, such as a Git submodule path, makes the native scan incomplete.
An unsafe, aliased, or colliding Git path also makes the native scan incomplete.
Prism verifies the whole native snapshot before it returns a plan, so a change to an unselected source file also rejects the plan.
Native plans can support numeric `FIT` when semantic retrieval, applicable structure, source freshness, hints, and source ranges are complete.

CodeGraph requires an executable version greater than or equal to `1.6.0` and less than `1.7.0`.
CodeGraph also requires a complete current `.codegraph` index for the exact project root.
Prism uses CodeGraph lexical and symbol-graph evidence but does not claim that CodeGraph provides embedding-based semantic search.
Therefore, CodeGraph improves discovery but cannot support a numeric `FIT` result under the current policy.
Explicit CodeGraph selection never runs initialization, synchronization, or indexing commands against the external index.
Bundled native analysis runs the SDK against a private snapshot mirror and leaves the project's `.codegraph` and CodeNib indexes unchanged.
Prism caps CodeGraph context nodes, edges, entry points, and explicit symbol matches.
Evidence that reaches a cap without an affirmative completeness signal cannot support a numeric estimate.

CodeNib `0.2.3` remains optional and supplies hybrid and graph evidence when its required views and verified source are available.
Prism rejects a different CodeNib executable identity or version.
Native still supplies the final source rendered for token accounting.
Prism rejects unsafe external source paths and applies its own limits when CodeNib returns more search or hint-resolution results than requested.
Prism rejects POSIX absolute paths, Windows drive paths, Windows drive-relative paths, UNC paths, traversal paths, and paths outside the canonical project root.
CodeNib graph evidence cannot support a numeric estimate when seed or node limits bound it, when CodeNib reports a graph note or error, or when a graph source range remains incomplete.
Any caller concept that no contributor resolves prevents a numeric estimate.
When provider reads expand into overlapping ranges, Prism merges the ranges and counts the final merged rendering once.

### Search for reusable concepts

Before changing targets, call `capture_repository_snapshot` or reuse the caller's original baseline.
For before-change reuse searches, pass the returned `snapshotId` from the first `search_repository_concepts` request:

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "query": "retry temporary network failures within a total deadline",
  "filters": {"domains": ["code", "configuration"]},
  "limit": 10
}
```

Domains are `code`, `instruction`, `documentation`, and `configuration`.
Optional path and kind filters restrict the candidate set.
Preparation still scans the eligible snapshot before applying these result filters.
Search defaults to ten results and permits at most fifty.
Each result is one source unit, for example a function, a class, a Markdown section, a paragraph, or a configuration key.
Each result identifies its path, selector, source range, source hash, and bounded excerpt.
The excerpt always comes from the source text.
Each result also gives its `ancestry`, the names of its containing classes or sections from the outermost one.
A class, a section, or a configuration object is an `outline` result that lists its members, and each member is also a separate result.
A unit longer than the model limit is split into `part` results, and its `parts` field gives their number.
The `tokens` field gives the size of the complete unit, so a large value can show a refactoring candidate.
When two or more results share a container, the search also returns that container with `groupedMembers`, directly after the one of those results that their index ranks first.
Lockfiles, generated output, vendored code, and minified files are not search candidates.
Cosine similarity, lexical score, fused rank, model identity, and index revision have distinct meanings.
Similarity does not establish conceptual equivalence or approve an addition.

Native code structure covers JavaScript, TypeScript, Python, Go, Rust, Java, C#, C, and C++ through the pinned SDK.
Markdown sections and rules, JSON keys, and YAML keys have source locations and typed containment or reference relationships.
Unsupported constructs, missing dependencies, malformed files, unresolved links, and denied configuration reads are disclosed as incomplete structure.
Relevant incomplete structure prevents a numeric fit estimate.

If preparation exceeds ten seconds, search and planning return `preparing` with a stable preparation ID.
Call `get_repository_intelligence_status` with `projectRoot` and optional `waitMs` up to 30000, then repeat the original request.
Concurrent requests share preparation.
A `preparing` response is unfinished discovery, not an empty search result.
Keep the original `snapshotId` through retries and edits so new code cannot appear as preexisting reuse evidence.
Use `discover_repository_intelligence` for native runtime, model, index, and coverage status without starting downloads or preparation.

#### Index a repository per component

A repository that declares components under `## Components` in `.prism/workflow.md` has one native index per component.
Each declared component's index holds only the files in its folder, and the root component's index holds every other file, including documents outside every declared folder.
The native limits of 20,000 files, 64 MiB of source, a 512 MiB index file, and 30 minutes of preparation apply to each component's index on its own.
A repository without components keeps one index of the whole repository, so an index that it prepared earlier is reused.

A search of the current files with `filters.paths` prepares and reads only the components that hold a file at or under those paths.
A search without paths prepares and reads every component that holds a file.
Prism prepares one index at a time, in component order: the root component first, then the declared components in declaration order.
The components that a later call needs move ahead of components that only an earlier call waits for, and the running preparation always finishes.
A component is prepared again only when its own files change, and its new index reuses the embeddings of its unchanged fragments.
A component that another session is preparing is reported `preparing`, and this server tries it again every few seconds while it prepares the other components.
A component whose storage lock names a running process but has gone unrenewed for more than 30 seconds, as when a killed session's process id was reused, fails with `lock_timeout`, and its diagnostic names the lock file to delete when no session is preparing that component.
Each component's index is reused across sessions and after the repository's name changes.

Each result lists the components it read in `components`, in component order, with each one's identity `<repository>/<component>`, `folder`, `status`, `indexRevision`, and `failure`.
A component's `status` is `included` when its up-to-date index answered, `waiting` while it is queued, `preparing` while it is built, and `failed` when its preparation failed.
The result's `status` is `ready` when every component it read is included, `partial` when only some are, `preparing` when none is included yet, and `degraded` when every one failed.
A result that leaves out a component starts its diagnostics with `components_missing`, whose `components` lists the components it left out and whose message says why for each one.
A `partial` result is not evidence that the missing components hold no matching code, so wait with `get_repository_intelligence_status` and repeat the search.
The result's `snapshot` covers only the components it read, so an edit in another component leaves it unchanged.

Each search result names the identity of its component in `component`.
When one component is included, its results keep that index's order and `fusedRank`.
When several components are included, each one answers the query with the search's filters and `limit`, and the merged results are ordered by `cosineSimilarity` from highest to lowest, with equal similarities in component order and then in each index's order.
A result without a similarity, such as a container returned for its grouped members, stays directly after the result that it follows in its component's index.
Such a result counts toward `limit` like any other, so it is left out when the result it follows is the last one kept.
The merged list keeps the first `limit` results and numbers `fusedRank` from 1.
Each result keeps the `fusedScore` and `lexicalScore` that its component's index computed, and those scores depend on that index's own files, so compare them only between results of one component.
When every component that the search read failed, the search returns lexical matches over those components' files, each with its `component` and a `cosineSimilarity` of `null`, and the result's `status` is `degraded`.
The search's receipt records the result's `components`, `snapshot`, and `indexRevision`.

A component whose preparation fails keeps its earlier indexes, and every other component's index stays in use.
Its `failure` gives a `code` and a `message`, and a component that reached a native limit has the code `resource_limit` and a message that names the limit.
The same server does not prepare that component again until its files change, while any other failure is retried by the next call that needs the component.

In a repository with components, `get_repository_intelligence_status` and `discover_repository_intelligence` list each component that holds a file in `components`.
Each entry gives the component's `status`, `preparationId`, `snapshot`, `indexRevision`, `builtAt`, `progress`, `coverage`, `failure`, and `diagnosticCount`, where `status` is `unprepared`, `waiting`, `preparing`, `ready`, `indexed`, or `degraded`.
The top-level `status` is `preparing` while a component waits or prepares, else `degraded` when a component's latest preparation in this server failed, else `indexed` when a component has an index, else `unprepared`.
The top-level `progress` is the running preparation's progress with its `component`, and each diagnostic names its `component`.
An invalid `## Components` declaration refuses the native index and status tools before any preparation, with the declaration's error code.
Background preparation at startup and the review browser's rebuild do not build any index in a repository with components yet, so a search builds the components it reads; refreshing each component's index in the background is Planned.

#### Watch an index build in the review browser

The review browser's status bar shows the open project's native index at its right end.
While a build runs, the chip names the current step out of five and its percentage, and clicking it lists every step.
The steps are checking or downloading the runtime and model, copying source files, parsing code, embedding new fragments, and saving the index.
A step shows a percentage only when the build reports counts for it, so unpacking the runtime, planning fragments, and saving show motion without a number.
Embedding counts only fragments that need a new embedding, so a rebuild after a small edit has a small total.
The project switcher marks other projects whose build runs or failed.

The Prism MCP server starts a build in the background once it knows the project, at startup when the host names the project or else at the first Prism tool call, and a later search joins that build instead of starting another.
An agent's search also starts or retries a build.
While a page of the project is open, the review browser rebuilds an index that is out of date once the files stayed unchanged for a minute, at most once every five minutes, so slice pages show current line ranges.
The index panel's Rebuild index button starts a build at once.
To keep a project from building at startup or from the open page, add `- Background indexing: off` under `## Repository intelligence` in `.prism/workflow.md`; searches and the button still build the index.
`Not indexed` means no build has run yet, and `Indexing stopped` means the session that ran the build ended before it finished.
`Index rebuild pending` means files changed during the build, and the next build uses the current files.

`Index out of date` is a hint from Git, not a comparison of file contents.
It compares the commit and the changed files' sizes and modification times with those recorded when the index was built or last reused.
A commit that leaves indexed files unchanged looks out of date until the next build, and an edit that keeps a file's size and modification time looks current.
A folder outside Git, an index of a retained baseline, and an index built by a Prism version without the chip show no hint.

### Find shared dependencies

`find_shared_dependencies` groups functions and methods in different files that call the same rare set of operations.
A group can show a copied helper, a repeated safety check, or a repeated write or lock protocol.
Search finds units that look alike, and this tool finds units that work alike, without a query.

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "filters": {"paths": ["src/server"]},
  "limit": 20
}
```

The tool uses the same preparation, `snapshotId`, and `expectedSnapshot` behavior as search.
Each group lists its shared operations, with the number of units that use each operation, and its members.
The `share` of a member is the part of its dependencies that the group covers.
A share near 1 means that the member is mostly the shared step, and a low share means that the member does other work too.
Operations match by name, so copies of one helper in different modules connect their callers.
Core collection, string, conversion, and error operations of each language do not count, and type references do not count.
The core operation lists cover JavaScript and TypeScript, Python, Go, Rust, Java and Kotlin, C#, and C and C++.
A path constructor such as `Registry::new` keeps its type, so it does not match `Vec::new`.
Test code is left out unless `includeTests` is true.
Test code is a file in a test directory or with a test name, such as `store.test.ts`, `test_store.py`, `store_test.go`, or `StoreTest.java`, and a Rust `#[cfg(test)]` module or `#[test]` function.
Generated, vendored, and minified files are always left out.
With `filters.paths`, a group is reported when one of its members is inside the paths, and it keeps its members elsewhere, so a scoped analysis still sees code that the scope repeats.
A function that only uses core operations has no dependency profile, so use search for small helpers.
`coverage` gives the number of profiled units, and a `dependency_names_unavailable` diagnostic means that the index was prepared without library call names.
A shared dependency set identifies candidates for investigation and does not establish equivalent behavior.

### Report module interfaces

`report_module_interfaces` reports the exports of JavaScript and TypeScript modules and the modules that import each export.
It gives facts for an interface design review and does not decide whether an interface is too shallow.

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "filters": {"paths": ["packages/agent"]},
  "limit": 20
}
```

The tool uses the same preparation, `snapshotId`, and `expectedSnapshot` behavior as search.
Each module entry lists its exports, with the number of importing modules and importing tests for each export.
`unusedExports` lists exports that no other module or test imports, and `testOnlyExports` lists exports that only tests import.
An unused export can be private or removed, unless it is a published API, an entry point, or a name that a framework loads by convention.
A test-only export is often a deliberate test seam.
`namesPerImporter` is the median number of exports that one importer uses, so a low value on a module with many exports shows that each caller needs only a small part of the interface.
By default, only modules with unused or test-only exports appear, and `allModules` reports every exporting module.
With `filters.paths`, only modules inside the paths are reported, while importers outside the paths still count.
Use `offset` and `nextOffset` to page through modules.

Imports resolve through relative paths, `package.json` names and `exports` maps of workspace packages, `tsconfig` path aliases, and built output that mirrors a `src/` file.
Static imports, re-exports, dynamic `import()`, and `require` count, and a dynamic import or `require` counts as a use of every export.
Only top-level declarations with the `export` keyword count as exports.
Tests, design documents, examples, declaration files, and generated, vendored, or minified files are not reported as modules.
An `unresolved_imports` diagnostic gives the number of local imports that did not resolve, because each one can hide an importer.
An import from a file type that the tool does not read, such as a workflow YAML file, also stays hidden.

`delegatingClasses` lists classes in which at least three public methods, and at least half of them, forward their parameters to one field.
`unchangedNames` counts forwarded methods that keep the name of the delegate method.
A delegating class can be a pass-through layer to remove, or an adapter, decorator, or access boundary with a purpose, so inspect it before you change it.

### Find shared literals

`find_shared_literals` groups functions, methods, classes, and constants in different files that spell the same rare set of string literals.
Instructions such as skills are clients too: a list item or paragraph in an instruction file that names identifiers in backticks uses those names together.
The tool also reports shapes: key sets that several objects, interfaces, or schemas repeat.
A group can show a value set that several units must know, such as states, capability ids, event names, error codes, or method names.
Shared dependencies find units that do the same work, and this tool finds units that know the same values.

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "filters": {"paths": ["src"]},
  "limit": 20
}
```

The tool uses the same preparation, `snapshotId`, `expectedSnapshot`, and `includeTests` behavior as `find_shared_dependencies`.
With `filters.paths`, a group is reported when one of its members or clients is inside the paths, and it keeps the ones elsewhere.
Each group lists its shared literals, with the number of units that spell each literal, and its members with their `share`.
Only identifier-like literals count: a letter or underscore, then letters, digits, `_`, `.`, `:`, `/`, or `-`, from 3 through 81 characters.
Prose, format strings, and module specifiers in `import`, `export ... from`, `require`, and `import()` do not count.
The smallest function, method, class, or constant that contains a literal owns it.
In an instruction file, the smallest list item or paragraph that contains a backtick name owns it.
A table describes one item per row, so the names in a table do not count, and documentation files only describe names, so they do not count either.
When a group has code members, its instruction members appear in `clients`, because they use the names that the code defines.
A group of instruction members only is repeated prose, so those members stay in `members`.
For a group with clients, `entryShape` gives the key set of at least four keys that most definitions of the names share, with the number of definitions that have it.
A definition is the smallest object literal in a code member that contains the name, such as one entry of a tool list.
Of the key sets that more than half of the definitions share, the one with the rarest keys is reported.
Several entry points that clients use together and that share an input shape can be one task split across several interfaces.
A literal that many units spell, or that only one unit spells, does not count.
When a group member is a constant or variable, a member that imports the module of that constant uses its values and does not keep its own copy.
Such members move from `members` to `users`, and a group whose remaining members sit in one file is not reported, because the set has one owner.
`coverage.ownedGroups` counts these groups.
Import analysis covers JavaScript and TypeScript, so in other languages every member stays in `members`.
A type declaration does not count as an owner, because units that import a union type can still copy the logic that derives its values.
A literal set can also be values of a type that the compiler checks, such as the members of a string union in a `switch`.
Check whether one owner, such as a constant or a type, would let the other units stop spelling the values.

`shapes` lists key sets of at least four keys that at least three objects, interfaces, structs, or schemas share, also inside one file.
Each shape gives its keys, the number of occurrences and files, the number of `declarations` inside an interface, type alias, or struct, and the location and unit of each occurrence.
Only the largest key set that the same objects share is reported, and nested keys and import or export lists do not count.
A shape repeated without one declared owner is a data clump: the same parameters or fields travel together and can become one type or one entry point.
With `filters.paths`, a shape is reported when one of its occurrences is inside the paths.
The response lists at most 10 literals for each group, with `literalCount`, and at most 8 shapes with 4 locations each, so that it stays short enough for an agent to read in full.
The receipt keeps every group, literal, shape, and location, with the shapes in its `shapes` section, and `totalShapes` gives their number.

### Report cohesion clusters

`report_cohesion_clusters` reports large classes, Rust and Go types, and modules whose members fall into separate clusters.
A cluster is a group of members that share fields or module constants, or call each other.
Separate clusters can show separate responsibilities in one class or module.

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "filters": {"paths": ["src/server"]},
  "limit": 20
}
```

The tool uses the same preparation, `snapshotId`, `expectedSnapshot`, and `includeTests` behavior as `find_shared_dependencies`.
With `filters.paths`, only classes, types, and modules inside the paths are examined.
The members of a class are its methods, the members of a Rust or Go type are the methods with that type name, and the members of a module are its top-level functions.
Fields come from `this.` and `self.` references, so Go receivers do not supply fields.
Constructors are left out, because a constructor sets every field.
A field or helper that n members share links each pair of them with weight 1/(n-1), so a logger that every member uses links them only weakly.
Community detection then finds the clusters, and `modularity` measures how separate they are.

A container is reported when it has at least six members and 120 lines, at least two clusters with two members and 30 lines each, a modularity of at least 0.3, and at least 300 lines outside its largest cluster.
`separableLines` is that number of lines outside the largest cluster, and the report is ordered by it.
Each cluster lists its lines, its members, and the state that its members use, and `smallClusters` counts the other clusters.
Mixed responsibilities inside one long function do not appear, because the tool groups members, not statements.
Clusters identify candidate responsibilities for investigation and do not decide whether a split is better.

### Find same-name units

`find_same_name_units` groups functions in different files that have the same name.
Identical copies show a helper that one module could own, and diverged variants of one name can carry different contracts.
For example, one variant can throw on bad input while another returns `null`.

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "filters": {"paths": ["src"]},
  "limit": 20
}
```

The tool uses the same preparation, `snapshotId`, `expectedSnapshot`, `includeTests`, and `filters.paths` behavior as `find_shared_dependencies`.
Each group has a `kind` of `identical` or `diverged` and lists its variants.
Each variant lists its members, its lines and signature, its `throws` count of `throw`, `raise`, and `panic!`, and `onlyHere`, the dependencies that not every variant uses.
Bodies that differ only in whitespace or an `export` or `pub` keyword are one variant.
Only functions with at least three lines count, and methods are left out, because the same method name in several classes is usually polymorphism.
A name with more than 20 functions is too generic to compare.
`similarity` is the smallest identifier overlap between two variants, and groups below 0.3 are unrelated functions that only share a name, so they are not reported.
When every variant has at most three lines, the floor is 0.5, because a few shared identifiers make short wrappers look alike.
Diverged groups whose variants differ in throwing come first, then diverged groups with different dependencies, then other diverged groups, and then identical copies.
A diverged name identifies candidates for one contract and does not establish that the variants should behave alike.

### Report complex units

`report_complex_units` reports long or branchy functions and methods.

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "filters": {"paths": ["src/server"]},
  "limit": 20
}
```

The tool uses the same preparation, `snapshotId`, `expectedSnapshot`, and `includeTests` behavior as `find_shared_dependencies`.
With `filters.paths`, only units inside the paths are reported.
A unit is reported when it has at least 80 lines, at least 25 branches, or a dispatch on at least 8 literal values, and the longest units come first.
`branches` counts `if`, loops, `case`, `catch`, and the `&&`, `||`, and ternary operators, with comments and string contents left out.
Python counts `elif`, `except`, `and`, and `or`, and Rust counts match arms.
`maxDepth` is the deepest nesting below the body, and `parameters` counts the top-level parameters of the signature.
`nestedFunctions` counts the functions inside the unit, because their code also counts toward the unit.
`dispatch` names the expression that the unit compares with the most distinct literal values, through equality or inequality comparisons, `case` labels, or Rust match arms, when it has at least three.
A long chain on one subject can be a table of handlers.
The facts identify candidates for a split and do not decide that a unit is too complex.

### Analysis receipts

`find_shared_dependencies`, `find_shared_literals`, `find_same_name_units`, `report_module_interfaces`, `report_cohesion_clusters`, and `report_complex_units` retain each complete result as immutable private evidence and return its `receiptId`.
The receipt keeps every result before the response `limit`, so `totalGroups`, `totalContainers`, or `totalUnits` can be larger than the returned list.
The receipt also records the tool, the scope, the snapshot, the index revision, coverage, diagnostics, and the hash of every file that the result names.
A file hash that differs from the current file shows a result that a later edit made stale.
Read a receipt in pages with `get_conservation_evidence`.
The default section is `groups`, `modules`, `containers`, or `units`, and the `delegatingClasses` and `files` sections are also available.
Cite the `receiptId` in a refactoring report, so that a reviewer can open the exact result that supports a candidate.
An identical result gives the same `receiptId`, and a `preparing` or degraded response has no receipt.

For live-source searches and context planning, pass a returned `snapshot` as `expectedSnapshot` to bind the source fingerprint.
This fingerprint differs from a retained evidence `snapshotId`.
On `stale_snapshot` during live-source discovery, repeat the search against current source and reassess the candidates.
Before-change discovery keeps its retained baseline instead of replacing it with current source.
On `corrupt_asset`, replace the affected private cache from the pinned release and retry.
On `unsupported_runtime` or `preparation_failed`, inspect the status diagnostic and retry after correcting the platform or download problem.
Degraded analysis supplies lexical results and explicitly withholds semantic fit eligibility.

Runtime archives include Node 24, so users do not need npm, Python, compilers, CodeNib, or a CodeGraph executable.
Assets, models, and indexes use the host plugin data directory when available, or the user's private Prism cache.
They are never stored in the target repository.
Each source change produces a new index that reuses unchanged embeddings.
Prism keeps the current index and the three most recently used earlier indexes, and removes older ones.
One helper runs per MCP server with two inference threads and exits after five idle minutes.
Native source limits remain 20,000 files, 64 MiB total, and 2 MiB per file.
Known omissions outside a managed change's scope limit coverage without blocking its affected-source gate.
Missing affected source and unknown omissions block that gate.
The SDK's stricter limits and omissions are reported independently of its completion flag.
The supported platforms are macOS and Linux on x64 and arm64, plus Windows x64.

### Prepare an external provider

Prepare external indexes outside Prism because provider discovery never changes them.

For CodeNib, install the supported release and prepare the project:

```bash
python -m pip install "codenib[graph,mcp]==0.2.3"
codenib codegraph init /absolute/project
```

For CodeGraph, install a compatible `1.6.x` release and create or synchronize the project `.codegraph` index with CodeGraph.
Set `PRISM_CODEGRAPH_COMMAND` when the CodeGraph executable is not on `PATH`.
Set `CodeNib command` in `.prism/workflow.md` when the CodeNib executable is not on the Prism MCP process `PATH`.
Set the project field to an absolute executable path without arguments, or use `n/a` to defer to the environment or default `PATH` lookup.
`PRISM_CODENIB_COMMAND` overrides the project field and may name a command on the Prism MCP process `PATH`.
The project field overrides the default `codenib` lookup when the environment variable is absent.
Prism reads this setting only from `.prism/workflow.md` under the requested project root and rejects a config file that resolves outside that root.

```markdown
## Repository intelligence
- CodeNib command: /absolute/path/to/codenib
```

Use `list_repository_intelligence_providers` to verify availability before planning.
For `not-installed`, fix the executable or command setting.
For `invalid-config`, set `CodeNib command` to an absolute executable path or `n/a`.
For `not-indexed`, `stale-index`, or `incomplete-index`, update the provider-owned index outside Prism.
For a snapshot mismatch, finish repository or index changes and retry planning.

## Resolve active session capacity

Use the read-only `resolve_session_capacity` tool with active mode when the target implementation session is the current Codex or Claude Code session.

```json
{
  "projectRoot": "/absolute/project",
  "session": {
    "mode": "active",
    "correlationKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "dataDirectory": "/absolute/plugin-data"
  }
}
```

Active resolution requires the bundled hooks in `hooks/hooks.json` to be enabled and trusted by the host.
Codex skips plugin hooks until the user reviews and trusts their current definition through `/hooks`.
After a Prism install or update, trust the current hook definition and start a new root Codex task.
Send the first prompt so Codex records the effective context window.
The first subsequent tool call refreshes Prism's active capacity facts.
After it stores a fact record successfully, the hook emits a SHA-256 session correlation key and absolute plugin data directory as bounded developer context.
Pass both exact values to active capacity, fit, and consumption requests.
The hook stores only hashed session and project identities plus allowlisted model and capacity facts in the plugin data directory.
It does not store prompts, source, commands, responses, credentials, or transcripts.
The raw session identifier never appears in additional context, MCP input, or persisted public output.
Fact cleanup runs during writes, removes records older than 30 days, and evicts the oldest eligible records by modification time and file name before the fact directory exceeds 16 MiB.

The Codex adapter reads the first bounded `session_meta` transcript record to correlate the session, canonical project root, root execution, CLI version, and model provider.
On `PreToolUse`, it also reads the latest record from a bounded 256 KiB transcript tail to obtain the effective `model_context_window` reported after the first model call.
It persists neither the transcript path nor transcript content.
The active model comes from the hook event.
Prism requests the effective layered Codex configuration for the event working directory through the local app-server and stores only allowlisted capacity values and provenance.
An explicit effective threshold and scope take precedence over a registry default.
When the effective configuration proves that no threshold override exists, Prism uses the threshold policy of the registry profile that covers the host version, provider, and model.
An explicit context-window override uses that profile's reviewed default percentage after the transcript effective window is verified.
Missing, timed-out, malformed, or ambiguous effective configuration keeps capacity unsupported.
Prism rejects `body_after_prefix` accounting.
If correlated facts contain complete identity but no exact threshold, the caller may supply both capacity overrides and `compactionScope: "total"`.
Active override objects must contain both `contextWindowTokens` and `compactionThresholdTokens`.
Prism rejects partial objects instead of merging them with hook facts.
A stored `body_after_prefix` scope cannot be overridden by claiming `total`.

Active capacity returns `UNSUPPORTED` with a stable reason code when facts are absent, stale, associated with another key, cross-project, malformed, or do not prove exact total-scope capacity.
Using another valid key normally returns `NO_SESSION_FACTS` because storage is keyed by the digest.
Use explicit session input when the key or data directory does not appear, active evidence stays unsupported, or a different implementation session is the target.

## Summarize pre-edit consumption

Use `summarize_session_consumption` to inspect content-free observations from the same active host session.

```json
{
  "projectRoot": "/absolute/project",
  "correlationKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "dataDirectory": "/absolute/plugin-data"
}
```

Use the exact correlation key and plugin data directory that the enabled session hook adds to developer context.
The key identifies the active session without exposing its raw host session identifier, and Prism also requires the canonical project identity to match.
The bundled hooks observe supported searches, source reads, successful edits, failed edit attempts, tests, compaction, and session boundaries.
The trace stores hashed identities, relative source ranges, numeric counts, coverage, and provenance in the plugin data directory.
It never stores prompts, source text, commands, tool output, model responses, credentials, or transcripts.
Hook project roots are resolved to their canonical filesystem paths before trace identities are created.
Claude traces use canonical `CLAUDE_PROJECT_DIR` even when the hook working directory changes.
Codex traces use the canonical project root from the correlated transcript and never use the hook working directory as a substitute when correlation fails.

For Codex, Prism reads only the first bounded `session_meta` transcript record to classify the event as root or subagent execution.
The classifier reads at most 256 KiB and persists no transcript content.
Correlated transcript metadata identifies Codex before any Claude compatibility variable is considered.
Codex-specific markers without a root-correlated transcript fail closed, while a hook with no Codex marker can use canonical `CLAUDE_PROJECT_DIR` as positive Claude identity without `CLAUDE_VERSION`.
Subagent action details are excluded from the root trace and replaced with a content-free coverage gap.
An absent, malformed, or mismatched classification creates a coverage gap when the stable root identity remains known and otherwise the event is ignored instead of being merged into another trace.

The first successful edit closes the pre-edit window.
Failed edit attempts keep the window open.
For Codex, only a root-correlated exact `apply_patch` `PostToolUse` event under a reviewed trace behavior profile proves success.
The bundled trace behavior registry verifies Codex `0.147.0` and `0.163.0` as minimum versions and `0.155.0-alpha.9.2` as an exact version, all with provider `openai`.
A minimum profile covers its version and every later version until a newer minimum profile replaces it.
Each profile records the exact tagged upstream source used to verify its lifecycle and response-shape contract in `src/server/session/session-trace-behavior-registry.json`.
Codex versions that no profile covers and unknown host edits remain attempts even when response fields look successful.
Claude `PostToolUse` events use the documented successful lifecycle after positive Claude project classification.
Tool classification uses exact built-in and explicit provider names instead of suffix matching.
When a tool exposes an edit path, its canonical resolution must stay beneath the stable project root.
Shell and unknown tools add coverage gaps because Prism does not inspect their command text.
When Codex omits a rendered token count for a supported read or search, Prism estimates tokens with the shared `utf8-bytes-divided-by-3` counter only when the exact behavior profile documents a model-facing string and that string is no larger than one mebibyte.
Only the numeric estimate is stored, and the summary remains partial because the estimate is not tokenizer-exact.
Prism does not serialize object responses for estimation.
If no bounded string count can be produced, the summary reports partial coverage and unavailable consumption instead of a false zero.
Events are ordered by occurrence time with stable tie breakers before the first edit and summary are derived, so delayed delivery cannot turn an observed pre-edit read into a false zero.
Trace cleanup runs during append, removes traces older than 30 days and owned stale temporary files, counts owned active temporary files, and evicts the oldest eligible trace files by modification time and file name before aggregate trace storage exceeds 64 MiB.
Trace storage rejects symbolic-link directories and records, rejects multiply linked records, and uses no-follow opens where supported.
Cleanup and commit use token-owned locks, reclaim an aged lock only when its matching process is confirmed dead, and fail an append that loses ownership before commit.
The summary is measurement evidence for future calibration and does not change the current deterministic fit formula.

### Run measures

The summary also returns `runMeasures` with one row per execution: the root session and, on Claude Code, each subagent.

```json
{
  "runMeasures": {
    "collection": "on",
    "idleThresholdMs": 300000,
    "executions": [
      {
        "execution": "root",
        "executionDigest": "<64 hex>",
        "host": "claude-code",
        "firstObservedAt": "2026-10-22T10:00:00.000Z",
        "lastObservedAt": "2026-10-22T10:20:00.000Z",
        "ended": false,
        "wallTimeMs": { "value": 1200000, "coverage": "exact" },
        "activeTimeMs": { "value": 540000, "coverage": "exact" },
        "inputTokens": { "value": 120, "coverage": "exact" },
        "cacheWriteTokens": { "value": 40000, "coverage": "exact" },
        "cacheReadTokens": { "value": 900000, "coverage": "exact" },
        "outputTokens": { "value": 8000, "coverage": "exact" },
        "toolCalls": { "value": 42, "coverage": "exact" }
      }
    ]
  }
}
```

`collection` is `on`, `off`, or `unknown`, and only `on` returns executions; see [Project files](workflow.md#project-files) for the off switch.
Wall time runs from the first to the last observed event of the execution, starting at session start when it was observed.
Active time adds every interval between consecutive observed events except an interval longer than `idleThresholdMs`, five minutes, during which no tool call of that execution was running.
Token measures count each model message once, however many transcript records repeat it.
Tool calls count distinct tool calls seen at start or end, including failed calls.
A root row is `ended` after its session end, and a subagent row after its subagent stop.

Every measure carries a coverage mark of `exact`, `approximate`, `partial`, or `unavailable`, and `value` is `null` exactly when the mark is `unavailable`.
An unreadable or unrecognized transcript leaves the token measures `unavailable` instead of zero, while tool calls and times stay reported.
A transcript usage read stops at 64 MiB or after 1.5 seconds of one hook call, and the token measures then keep the last complete totals marked `partial`.
A tool call without an observed end lowers active time to `partial`.
A lost observation, a subagent identifier Prism cannot use, or a full run-statistics trace lowers every measure of that execution to at most `partial`.
A hook write that the local trace refuses, for example while many concurrent hooks hold its lock, also lowers that execution to at most `partial`, and the execution keeps its row.

On Codex, the root row is the session total of every thread, including subagent threads, and no subagent rows are returned.
Codex has no cache-write category, so `cacheWriteTokens` is `unavailable`, Codex rows are never `ended`, and `belowSession` is `partial` because no thread's share is reported.

Run statistics use separate local traces in the plugin data directory, so they never change the pre-edit coverage, reason codes, or trace limit.
Subagent observations never enter the root pre-edit summary.
For usage, Prism reads only per-message usage counts, timestamps, and message identifiers from Claude Code transcripts, and only the latest bounded `token_count` record from Codex transcripts.
The traces store only counts, timestamps, coverage, and SHA-256 digests, never transcript paths, content, or raw identifiers.
The MCP text output adds one line per execution with the same measures.

`runMeasures.attribution` splits the same cost by the Prism target and role current when it was spent.

```json
{
  "attribution": {
    "targets": [
      {
        "target": { "initiative": "demo", "slice": "alpha", "kind": "wave", "wave": "design-2" },
        "role": "coordinator",
        "attribution": "exact",
        "wallTimeMs": { "value": 129000, "coverage": "exact" },
        "activeTimeMs": { "value": 129000, "coverage": "exact" },
        "inputTokens": { "value": 45, "coverage": "exact" },
        "cacheWriteTokens": { "value": 0, "coverage": "exact" },
        "cacheReadTokens": { "value": 0, "coverage": "exact" },
        "outputTokens": { "value": 45, "coverage": "exact" },
        "toolCalls": { "value": 3, "coverage": "exact" }
      }
    ],
    "unattributed": { "wallTimeMs": { "value": 30000, "coverage": "exact" } }
  }
}
```

Each Prism tool call that names an initiative or slice starts a new target for the calling execution, from the call's start until its next such call.
A call that names only an initiative, through `initiative` without `slice`, targets the initiative's root slice.
The target `kind` is `wave` with the `wave` id when the slice's latest review wave is not accepted and the role is `reviewer` or `coordinator`, `design-run` with the `designRun` number while the slice is in design, and `slice` otherwise.
Design runs are numbered one more than the count of design-audit waves already started for the slice.
The `role` is the call's `actor.role` when it declares one, otherwise the role the same execution declared for that slice, otherwise `coordinator` for the root session and `delivery` for a subagent.
A Claude Code subagent's cost before its own first Prism call counts toward the root session's target and role current when the subagent started.

`attribution` is `exact`, `approximate`, or `partial`, and each measure's coverage is at most the attribution and the execution's own coverage.
A role taken from the same execution's own declaration for that slice keeps the attribution `exact`, and only the default `coordinator` or `delivery` role makes it `approximate`.
Naming a slice while a different slice the same execution named earlier still has active work in coordination state makes the attribution to both slices `approximate`.
A state file or review ledger that cannot be read, is larger than 8 MiB, or takes too long to read attributes the call to its slice with `partial` attribution.
Entries with the same target and role are summed over executions, and their times are summed per execution.

`unattributed` carries the same seven measures for cost that no Prism call or subagent start attributes, such as work before the first Prism call.
Attributed and unattributed tokens and tool calls add up to the executions' totals, so no cost is dropped or spread across targets.
A call whose project switches run statistics off records no target, and its following cost stays with the previous target.
A call whose project's workflow config cannot be read, exceeds 256 KiB, or takes too long to read stores nothing from that project, and its following cost stays with the previous target at `partial` attribution, or stays unattributed at `partial` coverage before the execution's first target.
A hook write that the local trace refuses also leaves that cost with the previous target and lowers the affected measures to at most `partial`.
On Codex, each thread is replayed alone, every attributed and unattributed measure is at most `partial`, and a subagent thread's cost before its own first Prism call is unattributed.
Because Codex threads overlap, their summed attributed time can exceed the root row's wall time.
With collection `off` or `unknown`, `targets` is empty and every unattributed measure is `unavailable`.

The traces store only the initiative and slice slugs, the declared role, the open wave id, the design run number, the active slice slugs, and the canonical project root of each Prism call, never other argument content.
The project root stays in the local trace and never enters a run record or the MCP output.
The MCP text output adds one line per attributed target and role and one line for unattributed cost.

#### Run records

Each finished run becomes one immutable run record per slice it served, written to `.prism/initiatives/<initiative>/slices/<slice>/runs/<run-id>.json`.
A run is the run-statistics work of one execution from its start until it ends, so one Claude Code subagent, one Claude Code session, or one Codex session can hold several runs over time.
A Claude Code run finishes at its subagent stop or session end.
Any run also finishes after 30 minutes without events while no tool is running, or after 24 hours, and Codex runs finish only this way because Codex reports no reliable end.
A new event after a finished run starts a new run.

A record goes to the project whose records the attributing Prism call read: the call's `projectRoot` argument when it names a directory, otherwise the project where the session runs.
A worktree initiative's records therefore land in that worktree, on the branch that carries the initiative.
Records are shared only through the working tree, like other committed project files.

```json
{
  "schemaVersion": 1,
  "runId": "<64 hex>",
  "host": "claude-code",
  "initiative": "demo",
  "slice": "alpha",
  "startedAt": "2026-10-23T10:00:00.000Z",
  "endedAt": "2026-10-23T10:04:00.000Z",
  "idleThresholdMs": 300000,
  "segments": [
    {
      "kind": "wave",
      "wave": "design-2",
      "role": "coordinator",
      "attribution": "exact",
      "wallTimeMs": { "value": 150000, "coverage": "exact" },
      "activeTimeMs": { "value": 150000, "coverage": "exact" },
      "inputTokens": { "value": 4, "coverage": "exact" },
      "cacheWriteTokens": { "value": 0, "coverage": "exact" },
      "cacheReadTokens": { "value": 0, "coverage": "exact" },
      "outputTokens": { "value": 4, "coverage": "exact" },
      "toolCalls": { "value": 2, "coverage": "exact" },
      "activeIntervals": { "value": [[1792749630000, 1792749780000]], "coverage": "exact" }
    }
  ]
}
```

A record holds one segment per target and role of the run within that slice, with the same measures and coverage marks as `attribution`.
`activeIntervals` lists the active periods as pairs of epoch milliseconds, at most 512, and becomes `approximate` when Prism joins the closest periods to stay within that bound.
A record holds only counts, durations, timestamps, coverage marks, the host, roles, the run identifier, and target identifiers, never content, paths, session identifiers, or model names.
Cost that no Prism call attributes creates no record and stays in the local session totals.

Prism never changes or replaces a record, so recording the same run again leaves the existing file as it is.
Records stay after coordination cleanup removes an initiative's plans folder and coordination state.
The first record also writes `.prism/.gitignore`, which ignores only transient `*.lock` and `.*.tmp` files, so the records themselves can be committed.
Files under `.prism/initiatives/` and `.prism/.gitignore` never count as source in repository snapshots, so a record written while a review is open does not make that review stale.

The trace hook records a run when it observes the run's end, and it records other sessions of the project that have been quiet for over 30 minutes at its next call.
`summarize_session_consumption` records finished runs before it reports.
A record that cannot be written now, for example because its folder is unusable, stays pending and is recorded by a later hook call or summary, and the hook still lets the host action proceed.
The hook starts no record work after 2.5 seconds, so whatever remains waits for the next call.
A project whose run statistics are `off` receives no new records, and its existing records stay readable.

`runMeasures.inProgress` reports the calling session's runs that are not recorded yet, with the same `{ targets, unattributed }` shape as `attribution`.
The session's current run is always in progress, and a finished run whose record could not be written stays in progress with every measure at most `partial`.
With collection `off` or `unknown`, `inProgress.targets` is empty and every unattributed measure is `unavailable`.
The MCP text output adds one line per in-progress target and role.

`runMeasures.recorded` totals the calling session's recorded runs from their run records, and it counts no other session's records in the same slice.
A run is either recorded or in progress, never both.
With collection `off` or `unknown`, or when recording could not finish, every `recorded` measure, including `runs`, is `unavailable`.
The MCP text output adds one `Recorded run totals:` line.

`get_review` and `get_initiative` also report `runTotals`, computed from run records at each read and never stored.
`get_review` reports `{ slice, waves, designRuns }` for the slice its `initiative` and `slice` name: the slice total, one `{ wave, totals }` per review wave, and one `{ designRun, totals }` per design run.
Its `runTotals` is `null` when those identifiers are invalid, and it appears on every page and section, including a review that does not exist yet.
`get_initiative` reports `{ initiative, slices }`, where each `slices.<slug>` also holds `withDescendants`, the slice's own runs and all of its descendants' runs, and `initiative` covers every slice.
Its `runTotals` is `null` when the initiative record is absent or invalid.
Every total has this shape:

```json
{
  "runs": { "value": 2, "coverage": "exact" },
  "wallTimeMs": { "value": 630000, "coverage": "exact" },
  "elapsedActiveTimeMs": { "value": 120000, "coverage": "exact" },
  "summedActiveTimeMs": { "value": 150000, "coverage": "exact" },
  "inputTokens": { "value": 31, "coverage": "exact" },
  "cacheWriteTokens": { "value": 0, "coverage": "exact" },
  "cacheReadTokens": { "value": 5, "coverage": "exact" },
  "outputTokens": { "value": 8, "coverage": "exact" },
  "toolCalls": { "value": 6, "coverage": "exact" },
  "idleThresholdMs": 300000
}
```

`runs` counts distinct runs.
`wallTimeMs` is the calendar span from the earliest run start to the latest run end, not a sum, so overlapping or repeated runs count the time between them once.
Records store no start or end time for a wave or design run, so its wall time spans its active periods and is at best `approximate`.
`elapsedActiveTimeMs` counts overlapping active periods once, while `summedActiveTimeMs` adds every agent's active time.
Token and tool-call totals add every included measure.
A slice without records reports `runs` as `0` and every other measure as `unavailable`, never zero.
When a slice's record folder cannot be read, for example because one file exceeds 1 MiB or is not valid JSON, every measure of that slice is `unavailable` and its waves and design runs are omitted.
A record outside the allowed shape is skipped and makes its slice's totals `partial`.
Because a skipped record could belong to any wave or design run, it also makes every wave and design-run total of that slice `partial`.
Either way the parent and initiative totals that include the slice are at most `partial`, and the read still succeeds.

## Evaluate repository fit

Use the read-only `evaluate_repository_fit` tool after `plan_repository_context` returns its token estimate.
Use `session.mode: active` for the same current session when active facts are available.
Supply the exact harness, harness version, provider, and model when the target is another session.
Supply the context already present in that session and the design context that implementation will receive.
Override the implementation reserve when the registered default does not fit the project workflow.

```json
{
  "session": {
    "harness": "codex-cli",
    "harnessVersion": "0.147.0",
    "provider": "openai",
    "model": "gpt-5.6-sol"
  },
  "costs": {
    "baseSessionContextTokens": 20000,
    "featureDesignContextTokens": 10000,
    "implementationReserveTokens": 90000
  },
  "tokenEstimate": {
    "lower": 140000,
    "expected": 145000,
    "upper": 150000
  }
}
```

The bundled registry in `src/server/session/session-capacity-registry.json` matches host, provider, and model exactly.
Each profile marks its verified host version as `exact` or `minimum`.
A `minimum` profile covers its version and every later version until a newer `minimum` profile for the same model replaces it, so a new Codex release needs no plugin update.
A version with an `exact` profile, such as a reviewed prerelease, resolves only through exact profiles.
For the bundled 272000-token Codex profiles, the 95 percent usable input window is recorded separately from the default 90 percent automatic-compaction threshold of 244800 tokens.
Supply both capacity overrides for an unregistered host, provider, or model, or for a version that no profile covers.
Prism returns `UNSUPPORTED` without a fit classification when neither path establishes exact capacity.

### Active Claude Code capacity

Claude Code does not report its compaction threshold to hooks, so active Claude Code capacity is a conservative estimate with `capacityBasis: "ESTIMATED"`.
Codex results and results built from complete explicit overrides report `capacityBasis: "ATTESTED"`.
In Claude Code the hook announces the correlation key from the first prompt, and the `PreToolUse` refresh before each Prism tool call records the facts.
The version comes from the bounded session transcript tail, the model from the hook event or the latest main-thread transcript message, and the provider from `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, or `CLAUDE_CODE_USE_FOUNDRY`.
The context window is 1000000 tokens for a model that carries the `[1m]` suffix, unless `CLAUDE_CODE_DISABLE_1M_CONTEXT` is set, and 200000 tokens otherwise.
The estimated compaction window is the smallest of that context window, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and any numeric `autoCompactWindow` in the user, project, local, or managed settings, and defaults to 200000 tokens.
Prism reads only the `autoCompactWindow` keys from those settings files.
The threshold is 80 percent of that window after a 20000-token output reserve, or a lower `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` percentage.
A default 200000-token window gives a 144000-token threshold.
Fit evaluation uses a 60000-token implementation reserve unless the caller supplies one.
The estimate cannot observe a `/autocompact` change made inside the session or a server-side window experiment, so supply both capacity overrides when the session uses a smaller window.

### Claude Code on AWS Bedrock

For a target session other than the current one, Claude Code on AWS Bedrock is supported through explicit session input when the caller supplies the exact effective context window and compaction threshold.
This explicit path is separate from the verified Codex tuples in the bundled registry.
Prism does not claim an automatic bundled Bedrock tuple in this milestone.
The effective Claude Code threshold can depend on host settings and environment, including the auto-compact window or percentage, maximum output tokens, context-window override, and compaction-disable flags.
Supply the exact Claude Code version, Bedrock model identifier, both capacity values, and an explicit implementation reserve for fit evaluation.
Use this field template and replace every uppercase placeholder with the exact value from the target execution.

```text
session.harness = "claude-code"
session.harnessVersion = EXACT_CLAUDE_CODE_VERSION
session.provider = "aws-bedrock"
session.model = EXACT_BEDROCK_MODEL_IDENTIFIER
session.capacityOverrides.contextWindowTokens = EXACT_EFFECTIVE_CONTEXT_WINDOW_INTEGER
session.capacityOverrides.compactionThresholdTokens = EXACT_EFFECTIVE_COMPACTION_THRESHOLD_INTEGER
costs.implementationReserveTokens = EXPLICIT_IMPLEMENTATION_RESERVE_INTEGER
```

`FIT` means the upper estimate fits the repository read budget.
`SPLIT` means the lower estimate exceeds the repository read budget.
`UNCERTAIN` means the estimate overlaps the budget or contains unavailable bounds.
Inspect the returned provenance before accepting the decision.
