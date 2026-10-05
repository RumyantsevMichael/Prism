# Repository intelligence providers

Status: Approved
Created: 2026-09-19
Approved: 2026-09-19

## Problem

Prism cannot guarantee repository context planning when CodeNib is absent, and it cannot select another installed repository intelligence provider through a stable boundary.

## Goals

- Provide bounded lexical repository discovery without an external index.
- Discover supported external providers without changing the repository.
- Select providers deterministically and preserve provider provenance.
- Add CodeGraph as an optional structural discovery provider.

## Non-goals

- Create or update an external provider index.
- Claim semantic or structural coverage that a selected provider does not supply.
- Decide conceptual equivalence or approve additions from similarity scores.

## Design questions

- n/a.

<a id="1"></a>
## 1. Provide a native baseline

Pattern: Ubiquitous

Disposition: Superseded by [Provide a native baseline with safe symbolic-link identity](#6) and [Reject unsupported non-file paths](#7)

Requirement: Prism shall provide a bounded native repository intelligence provider that can find nonignored text files, resolve exact lexical symbols, rank lexical matches, and read live source without an external executable.

Rationale: Repository context planning must remain available when no external index is installed.

Related: [repository-intelligence-providers.md§2](#2), [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§4](#4)

<a id="2"></a>
## 2. Discover registered providers safely

Pattern: Event-driven

Disposition: Active

Requirement: When a caller requests provider discovery for a project, Prism shall report every registered provider's availability, version, capabilities, and sanitized diagnostic without creating or updating an index.

Rationale: Users and automatic selection need inspectable provider state without hidden repository mutation.

Related: [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§6](#6)

<a id="3"></a>
## 3. Select and compose providers

Pattern: Event-driven

Disposition: Active

Requirement: When a caller plans repository context, Prism shall use the native provider for live source and shall add at most one healthy selected external provider for retrieval or graph evidence.

Requirement: When provider selection is `auto`, Prism shall prepare bundled native analysis without invoking external indexers.

Requirement: Prism shall accept external evidence only when the adapter proves a normalized source snapshot identity that matches the native source snapshot, and Prism shall validate every source path against the canonical project root before external verification or source reading.

Requirement: When CodeNib contributes evidence, Prism shall require the same canonical project root, verified CodeNib source access, an equal concrete commit, and a fresh complete native snapshot before Prism adopts the native snapshot identity for that evidence.

Requirement: Before Prism returns a context plan, Prism shall verify that the whole native source snapshot and the selected external snapshot remain unchanged.

Rationale: Native coverage and external intelligence have complementary strengths and different failure modes.

Related: [repository-intelligence-providers.md§2](#2), [repository-intelligence-providers.md§4](#4), [repository-intelligence-providers.md§5](#5), [repository-intelligence-providers.md§6](#6), [repository-intelligence-providers.md§7](#7)

<a id="4"></a>
## 4. Preserve uncertainty

Pattern: Unwanted behavior

Disposition: Active

Requirement: If required hints, source ranges, or claimed retrieval capabilities are unavailable, then Prism shall expose the gap and shall not return a numeric estimate that can support `FIT`.

Requirement: Prism shall enforce consumer-side result limits, merge source ranges that overlap after provider expansion, and count only the final merged rendered source.

Requirement: If graph evidence is bounded, contains an error or note, contains an incomplete source range, or is otherwise incomplete, then Prism shall expose the gap and shall not return a numeric estimate that can support `FIT`.

Rationale: A false complete estimate can cause a false fit decision.

Related: [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§6](#6), [repository-intelligence-providers.md§7](#7)

<a id="5"></a>
## 5. Use CodeGraph without managing its index

Pattern: Optional feature

Disposition: Active

Requirement: Where a compatible and current CodeGraph index exists for the exact project root, Prism shall allow CodeGraph to contribute normalized lexical and symbol-graph evidence without running CodeGraph initialization, synchronization, or indexing commands.

Rationale: CodeGraph can improve structural discovery while index ownership remains explicit and external to Prism.

Related: [repository-intelligence-providers.md§2](#2), [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§4](#4)

<a id="6"></a>
## 6. Provide a native baseline with safe symbolic-link identity

Pattern: Event-driven

Disposition: Active

Requirement: Prism shall provide a bounded native repository intelligence provider that can find nonignored text files, resolve exact lexical symbols, rank lexical matches, and read live source without an external executable.

Requirement: When native discovery enumerates a symbolic link, Prism shall capture its link value without following its target and shall include that value in whole-snapshot freshness verification without making the link searchable.

Requirement: Prism shall apply its file-count, per-entry byte, and whole-snapshot byte limits to symbolic links, and an unreadable or over-limit link shall make the native scan incomplete.

Rationale: Symbolic links must not hide repository changes or prevent external evidence from binding to an otherwise complete native snapshot.

Supersedes: [Provide a native baseline](#1)

Related: [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§4](#4), [repository-intelligence-providers.md§7](#7)

<a id="7"></a>
## 7. Reject unsupported non-file paths

Pattern: Unwanted behavior

Disposition: Active

Requirement: When native discovery enumerates a path that is neither a regular file nor a symbolic link, including a Git submodule path, Prism shall report an incomplete repository scan and shall not use that scan for a numeric fit estimate.

Rationale: Prism cannot prove whole-snapshot freshness for an unsupported repository entry.

Supersedes: [Provide a native baseline](#1)

Related: [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§4](#4), [repository-intelligence-providers.md§6](#6)

<a id="8"></a>
## 8. Supply local semantic and structural evidence

Pattern: Event-driven

Disposition: Active

Requirement: When a caller requests native planning or concept search, Prism shall prepare a private index from the verified source snapshot.

Requirement: Prism shall use pinned local inference and graph dependencies.

Requirement: Prism shall support code concepts in JavaScript, TypeScript, Python, Go, Rust, Java, C#, C, and C++ with explicit coverage diagnostics.

Requirement: Prism shall support non-code concepts in Markdown, JSON, and YAML with explicit coverage diagnostics.

Requirement: Prism shall combine independent lexical and vector rankings with equal-weight reciprocal-rank fusion at `k = 60`.

Requirement: Prism shall preserve exact hints ahead of candidates and report similarity separately from token estimates.

Requirement: Prism shall preserve source text across bounded model inputs and retain fragment parents and ranges.

Requirement: Prism shall reuse unchanged embeddings and rebuild graph resolution for changed snapshots.

Requirement: Prism shall reject stale expected snapshots and verify the live source snapshot before returning source-backed results.

Rationale: Local semantic evidence supports reuse without requiring users to install external indexers.

<a id="9"></a>
## 9. Prepare privately and report partial evidence

Pattern: Unwanted behavior

Disposition: Active

Requirement: If native preparation takes more than ten seconds, then Prism shall return `preparing` with a shared preparation identity.

Requirement: Prism shall provide a read-only status wait bounded to thirty seconds.

Requirement: Prism shall verify downloaded assets, publish complete generations atomically, and renew long operation locks.

Requirement: Prism shall preserve the last complete index after failure and keep target repositories and their external indexes unchanged.

Requirement: If required preparation, parsing, resolution, containment, source ranges, or resource limits prevent complete evidence, then Prism shall disclose the gap.

Requirement: Incomplete evidence shall prevent numeric `FIT` support while retaining useful lexical retrieval.

Requirement: Prism shall keep discovery independent of downloads and model loading.

Requirement: Prism shall run one lazy helper with two inference threads that exits after five idle minutes.

Rationale: Preparation and partial analysis must remain observable without weakening existing fit gates.
