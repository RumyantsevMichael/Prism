# Compose a native baseline with one optional external provider

Status: Accepted
Created: 2026-09-19

## Requirements

[Provide a native baseline](../../requirements/repository-intelligence-providers.md#1) requires useful repository discovery without an external executable.
[Discover registered providers safely](../../requirements/repository-intelligence-providers.md#2) requires inspectable and nonmutating provider probes.
[Select and compose providers](../../requirements/repository-intelligence-providers.md#3) requires deterministic provider composition.
[Preserve uncertainty](../../requirements/repository-intelligence-providers.md#4) prohibits false complete estimates.
[Use CodeGraph without managing its index](../../requirements/repository-intelligence-providers.md#5) makes CodeGraph an optional contributor.

## Problem

CodeNib is optional, CodeGraph does not cover every file type, and a single selected external provider cannot guarantee both repository coverage and live source identity.

## Decision

Prism MUST ship one native repository intelligence provider.
The native provider MUST enumerate Git-tracked and nonignored files when Git is available and MUST use a bounded non-Git walk otherwise.
The native provider MUST NOT follow symbolic links and MUST reject paths outside the project root.
An enumerated path that is not a regular file, including a Git submodule path, MUST make the native scan incomplete.
The native provider MUST supply every final source read used for token accounting.
Every external adapter MUST bind its evidence to the normalized native source snapshot identity before Prism uses that evidence.
CodeNib MUST adopt the native snapshot identity only after it proves the same canonical project root, verified source access, an equal concrete commit, and freshness of the complete native snapshot after CodeNib manifest verification.
Prism MUST NOT compare provider-private fingerprints from different fingerprint schemes.
Prism MUST verify the selected external snapshot and the whole native snapshot again before it returns a context plan.
Prism MUST reject POSIX absolute paths, Windows drive paths, Windows drive-relative paths, UNC paths, traversal paths, and paths outside the canonical project root before an external verification or source read.
Provider discovery MUST probe only registered adapters and MUST NOT accept executable paths from an MCP request.
Provider discovery MUST NOT create, synchronize, or update an external index.
Automatic selection MUST include the native provider and MAY add at most one healthy external provider.
Explicit native selection MUST use only the native provider.
Explicit external selection MUST include native source reads and MUST fail visibly when the external provider is unavailable.
An automatic external runtime failure MUST retry once with the native provider and MUST record the fallback.
Ranked results from multiple contributors MUST use deterministic reciprocal rank fusion instead of comparing provider-specific scores.
Prism MUST enforce its own result limits when an external provider returns more search, definition, or hint-resolution results than requested.
Prism MUST enforce its own query result limit when CodeGraph returns more results than requested.
Prism MUST merge ranges that overlap after a provider expands them and MUST read and count the merged rendered source once.
The public context plan MUST identify its requested selection, contributors, capabilities, and fallback.
An unavailable semantic or structural capability MUST remain explicit and MUST NOT support a `FIT`-eligible estimate.
Bounded, noted, failed, or range-incomplete graph evidence MUST remain explicit and MUST NOT support a `FIT`-eligible estimate.

## Rationale

The native provider guarantees a usable lexical floor and live source identity without claiming the richer evidence of an external index.
Composition keeps Markdown and unsupported languages visible while CodeNib or CodeGraph adds stronger retrieval or graph evidence.
One external contributor bounds process cost and makes automatic selection deterministic.

## Alternatives

### Require CodeNib

Declined because an optional beta executable cannot provide a guaranteed baseline.

### Select one winning provider

Declined because external indexes can omit file types that remain relevant to implementation.

### Let Prism update indexes automatically

Declined because discovery and planning are read-only operations and index updates can modify repository state.

## Consequences

Native-only plans can support discovery but may return unavailable numeric estimates when semantic or structural coverage is required.
CodeGraph contributes lexical and graph evidence but does not claim embedding-based semantic search.
CodeNib can contribute hybrid and graph evidence when its required views are healthy.
External adapter failures need typed diagnostics and bounded output handling.
Snapshot mismatches are typed external failures, so automatic selection can retry with native while explicit selection fails visibly.
CodeNib keeps its manifest fingerprint for its own response checks because CodeNib and native fingerprints can use different schemes.
Whole-snapshot verification rejects a plan when an unselected source file changes during planning.

## Mechanism

The provider catalog returns deterministic availability records for native, CodeGraph, and CodeNib.
The selector opens native and zero or one external provider according to the caller's selection.
The selector closes an opened provider session when its provider object or description is malformed.
The composite provider fuses ranked anchors and graph neighbors while routing source reads through native.
The composite provider verifies the external snapshot and the native whole-source snapshot before final plan delivery.
The context planner preserves composite provenance and uncertainty in its existing provider-independent result.

## Decision Log

2026-09-19: Accepted a native baseline with capability-aware composition after the user approved implementation.
