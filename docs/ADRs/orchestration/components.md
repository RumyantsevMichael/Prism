# Bound each slice to one component of its repository

Status: Proposed
Created: 2026-11-04

## Requirements

No Approved requirement governs this decision yet.
The Draft [component requirements](../../requirements/components.md) §3-§19 and §27 describe the behavior it implements.

## Problem

A monorepo holds many packages with their own tests, but Prism treats a repository as one unit, so every slice runs the whole repository's tests and nothing keeps a slice inside the package it was planned for.
A package's own tests often only work from its folder, because its test configuration resolves paths from there.
A change in one package can break the packages that use it, and nothing runs their tests when the work that changed it finishes.
Records already hold accepted slices, approvals, and runs from before any repository declared packages.

## Decision

A repository MAY declare components in its committed workflow configuration, each a folder with an optional test command and the components it depends on, plus a short list of shared paths.
Every file MUST belong to exactly one component: the declared component whose folder holds it, or the root component, which is named after the repository and holds every other file.
A declaration MUST be refused whole, by every operation that reads it, when an entry is invalid, two folders overlap or nest, a dependency names no component, or dependencies form a cycle, and the refusal MUST name the first problem in a fixed order.
A repository that declares no components MUST be one root component, so that every existing repository keeps working unchanged.
A component MUST be identified across the workspace as `<repository>/<component>`, where the repository is the one its configuration names, with or without a record store, or `root` when it names none, and a declaration MAY keep bare names for its own repository's components.
A dependency on another repository's component MUST be written as `<repository>/<component>` and MUST be checked only for its form, because the other repository's declaration is not read when this one is checked.
When a repository declares no components and its root manifests list workspace members, Prism MUST offer a `## Components` declaration derived from them for the person to review and commit, and MUST NOT write it to any file.
Each planned leaf slice MUST record exactly one component when its design is accepted, and a contract scope MAY span components.
A slice's planned changes and frozen tests MUST lie in its component or under a shared path, or the design MUST be refused before it is recorded.
A slice MUST be verified with its component's test command in the component's folder, or with the repository's test command in the project root when the component declares none.
A verification run MUST fail without running the command when the slice's changes since it started include a file outside its component and outside every shared path.
Prism's own configuration, records, plans, and roadmap MUST belong to no component's boundary.
The user MUST allow each distinct pair of test command and working folder before it first runs, and an approval from before components MUST keep allowing its command in the project root.
When every leaf of a scope with a fit design is done, the tests of every component that depends on one of its slices' components, directly or transitively, MUST run once on request, each distinct command and folder once, and the run MUST be recorded on the scope.
That run MUST cover only the scope's own repository and MUST report the components of other repositories that depend on the scope's components and that it did not run, which MUST NOT fail or block it.
An initiative MUST NOT ship while a finished scope's dependents have no passing run that covers each of them under the current declaration.
A change under a shared path MUST NOT make any component's dependents run.
A slice recorded without a component MUST be read, started, and verified as before, and reads of records MUST NOT depend on a valid declaration.

## Rationale

The team that owns a repository knows its packages and their tests, and a committed declaration is the same in every checkout.
One owner per file is what makes a slice boundary checkable, and refusing nested folders keeps that true without a precedence rule.
Checking planned paths at design acceptance catches a crossing while design can still fix it, and checking the actual changes at verification catches an implementation that strays, which the component's own tests would never notice.
Measuring changes against the content when the slice started counts committed and uncommitted work alike and needs no new snapshot format, because verification already hashes that content.
Running dependents once per finished scope keeps each slice's verification short while still proving that the scope's boundary contract holds for its users.
Running the dependents' run as its own request, rather than inside the last slice's verification, lets a scope whose last slice completes through review run it too, and keeps record updates quick.
A workspace identity lets a slice, a run, and the review browser name a component without the reader knowing which checkout it came from, while bare names keep a single repository's declaration short.
Running another repository's tests would need that repository's checkout, configuration, and approvals, so the run reports those dependents and leaves running them to that repository's own work.
A proposal from workspace manifests saves typing the folders a monorepo already lists, while the person's review keeps the declaration a decision of the team that owns the repository.
One approval gate for every pair a dependents' run needs asks the user once per run rather than once per package, while each pair is still allowed separately.

## Alternatives

Inferring components from package manifests at every read, instead of proposing a declaration once, would differ between ecosystems, could not name test commands or dependencies that the manifests leave out, and would change a repository's boundaries whenever a manifest changed.
Applying the proposal automatically would commit boundaries nobody reviewed, such as a folder that is not a package.
Refusing to plan until a monorepo adopts the proposal would block repositories that work well as one component.
Validating a dependency on another repository against that repository's declaration would make one repository's design fail because of a checkout that is missing or out of date.
Letting a slice span components would need several components' checkouts and test commands for one slice, which is what the scope's contract exists to coordinate.
Only reporting a crossing at verification instead of failing the run would let a slice complete without the tests of the component it changed.
Running dependents' tests after every slice would multiply the slowest tests by the number of slices in a scope.
Counting a change under a shared path as a change to every component would run every package's tests whenever a lockfile changes.
Approving a command text once for every folder would let one approval run in folders whose configuration gives the same text another meaning.

## Consequences

A slice in a monorepo runs only its package's tests, which is faster and more precise than the whole repository's.
Documentation and feature files outside every package belong to the root component, so a repository that wants package slices to update them lists them as shared paths or plans a root slice for them.
A declared folder that does not exist yet is accepted, so a design can plan the slices that create a package, while verification refuses to run in a folder that is still missing.
A scope that changes a widely used package runs many dependents' tests at its end, up to every transitive user of that package.
A slice started where Git could not hash the work tree verifies without the boundary check and says so.
A dependency on another repository's component that names nothing there is found only by reading that repository, so the dependents' run reports it rather than refusing it.
A dependents' run reads other repositories' committed declarations only from checkouts this machine has recorded for the same store, and names each of the store's other repositories it could not read.
A repository without a record store is named `root` unless its configuration names it, so two such repositories share that name until one does.
The first verification in each new folder asks the user again, even for a command already allowed elsewhere.
A repository that renames its root component by adding a record store changes the name that new slices record, and a slice that recorded the old name is refused at verification until its design is accepted again.

## Mechanism

The declaration is read from its own section of the workflow configuration with a reader that keeps the nesting of its list items.
Design acceptance reads the declaration once per update, resolves each accepted slice's component, and checks its planned change paths and frozen test paths against the owner of each file.
Starting a slice records the hash of the project content that verification already computes, and verification lists the paths that differ between that hash and the current one before it runs anything.
The dependents' run walks the declared dependencies backwards from the scope's components, orders the dependents so that a component runs after the components it depends on, groups them by command and folder, asks for the pairs not yet allowed in one gate, and records every dependent's result in one run entry on the scope.
A proposal reads the root's `package.json` workspaces, `pnpm-workspace.yaml`, Cargo workspace members, and `go.work`, matches their patterns to folders that hold a package manifest, takes each name from its manifest or folder, its dependencies from workspace dependencies, and its test command from a `test` script, and is checked with the same reader as a declaration so that it reports why it would be refused.
Shipping reads the declaration and each finished scope's latest dependents' run, while reading an initiative reports those runs without reading the declaration.

## Decision Log
