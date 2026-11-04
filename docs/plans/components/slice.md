# Components in one repository

## Outcome

A repository declares components; each leaf slice stays inside one, is verified with its component's tests, dependents' tests run when a scope finishes, and the native index is prepared per component.

## Parts

The scope splits into two parts, each designed as its own contract when it is next.
`component-slices` can be frozen now, while `component-indexes` rests on the Unprobed assumption below, which its own design settles once `component-slices` has delivered the component model.

| Slug | Title | Outcome | Requirements | Depends on |
| --- | --- | --- | --- | --- |
| `component-slices` | Components for slices and verification | A repository declares its components, each planned leaf slice records one and stays inside it, verification runs its component's tests and the dependents' tests when a scope finishes, the review browser labels each slice's component, and a checkout that names a store but no repository is refused. | `components.md§1`-`§19`, `§27` | |
| `component-indexes` | Native indexes per component | Prism prepares a native index per component, only for the components a tool needs, keeps the others after a failure, and answers path-scoped queries from matching components and unscoped semantic queries from every prepared one, naming those it left out. | `components.md§20`-`§26` | `component-slices` |

The overview is [overview.puml](overview.puml).

## Interfaces

Both parts read the component model below, so it is fixed here and each part's contract restates the clauses it implements.

### Declaring components

1. A repository declares components under `## Components` in its committed `.prism/workflow.md` as top-level list items `- <name>: <folder>`, each optionally followed by more-indented list items `- Test command: <command>` and `- Depends on: <name>, <name>`; labels match without case and without a parenthesized note, as other sections' labels do, and lines that are not list items are ignored.
2. A component name matches `^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$`, the rule for repository names.
3. A folder is a project-relative path with forward slashes, read without a trailing `/`, and never empty, `.`, absolute, or holding a backslash, a colon, or an empty, `.`, or `..` segment; a declared folder that does not exist yet is accepted, so a design can declare the component that its slices create.
4. A top-level item `- Shared paths: <path>, <path>` under `## Components` lists project-relative files or folders under the same path rules, and a file lies under a shared path when it equals that path or lies inside it.
5. The root component is named after the repository: the `Repository` name under `## Workspace` when the configuration names a record store, and `root` otherwise.
6. The root component holds every file outside all declared folders, tests with the repository's `Test command` under `## Stack`, and depends on nothing, while a declared component may name it under `Depends on`.
7. A repository whose configuration lists no component under `## Components` declares no components and is one component, its root component, holding every file.
8. A file belongs to the declared component whose folder it lies inside, and otherwise to the root component; shared paths never change which component a file belongs to, only which files a slice may change.

### Refusing an invalid declaration

9. Every operation that reads a repository's components refuses an invalid declaration with a JSON-RPC error whose `data` holds `code` and the fields of its kind, and an operation that reads no components is unaffected.
   - `component_invalid` refuses an entry with an invalid name or folder, an invalid shared path, a name declared twice or equal to the root component's name, an unknown nested label, or a nested item before any component, with `data.entry` quoting the line.
   - `component_overlap` refuses two components with the same folder or one folder inside another, with `data.components` listing both as `{ name, folder }` (`components.md§6`).
   - `component_dependency_unknown` refuses a `Depends on` name that is neither a declared component nor the root component, with `data.component` and `data.dependency` (`components.md§7`).
   - `component_cycle` refuses `Depends on` entries that form a cycle, with `data.cycle` listing its names in dependency order, starting and ending with the same name (`components.md§8`).
10. When a declaration has several problems, the refusal reports the first one in the order of the list above, and within one kind the first in declaration order.

### A slice's component

11. A planned leaf slice records the name of its one component in the initiative record, and `get_initiative` returns it as the slice's `component`; a slice recorded before components existed has none.
12. Until `component-indexes` is delivered, every repository keeps one native index of the whole repository, whatever components it declares.

### Defaults for `component-slices`

The coordinator put four product questions to Michael, and `component-slices` designs with these defaults, which he can revise at its design gate; the Draft requirements state them.

- A slice whose verified changes include a file outside its component and outside every shared path fails its verification run (`components.md§16`).
- The dependents' run at the end of a scope runs every component that depends on one of the scope's slices' components directly or through other components, once per finishing scope (`components.md§17`).
- The dependents' run also happens for a scope whose slices all belong to one component that has dependents, not only for a scope that spans components (`components.md§17`).
- A change under a shared path does not by itself make any component's dependents run (`components.md§17`).

## Assumptions

- Probed: today's configuration reader flattens the nested list items of a section into one label map, so a second component's `Test command` replaces the first's and §1 needs a reader of its own for `## Components` (`node docs/plans/components/probes/config-nesting.mjs`, observed `{"billing":"packages/billing/","Test command":"bun test","Depends on":"shared","shared":"packages/shared/","Shared paths":"bun.lock"}`).
- Probed: in Lumen, 57 packages have a `package.json` whose name equals their folder and 4 Rust packages have none, their workspace dependencies form no cycle, and `messages` has the most transitive dependents at 30, so the transitive dependents' run of a scope that changes it runs 30 components (`node docs/plans/components/probes/lumen-components.mjs <Lumen checkout>`, observed `packages: 57`, `cycles: []`, `["messages", 30]`).
- Probed: Lumen runs each package's tests from the package folder: 45 packages test with `bun test --isolate --parallel`, 5 with `bun test`, 7 have no test script, and 23 have a `bunfig.toml` whose preload paths are relative to the package folder, such as `../../tests/preload-isolate-lumen-home.ts` (same probe and `packages/di/bunfig.toml`), so `component-slices` needs a component's own test command to run in its folder.
- Probed: Lumen keeps one `bun.lock` at the repository root, outside every package folder, which a change to any package's dependencies rewrites, so it is the shared path that §4 exists for, while every `Cargo.lock` lies inside a package folder (`git ls-files` in the Lumen checkout, observed `bun.lock` at the root and five `Cargo.lock` files under `packages/`).
- Probed: a native index of Lumen's `packages/lumend` alone, the largest package, prepares within the native limits with today's runtime (`node docs/plans/components/probes/index-folder.mjs <Lumen checkout>/packages/lumend <scratch folder>`, observed `ready` after 570 seconds with 451 files and 6,722 fragments, about 11 new embeddings a second, which puts the whole repository's estimated 45,000 fragments past the 30 minute operation limit); the same run reported structure for only 35 of the 451 files, with `incomplete_structure` extraction failures on TypeScript files, which `component-indexes` must weigh for structural reports on Lumen.
- Unprobed: how the native index consumers other than path-scoped and unscoped semantic search compose component indexes, namely the structural reports such as `find_shared_dependencies`, the `snapshot`, `indexRevision`, and `expectedSnapshot` of a result built from several indexes, analysis receipts, retained baselines named by `snapshotId` that conservation evidence and derived change maps index, `plan_repository_context`, background preparation at server start, and the review browser's index and code views; `component-indexes` settles them in its own design against the component model that `component-slices` delivers, and until then §12 keeps one whole-repository index.
