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
- Replace external semantic and symbol indexes with a built-in vector database.

## Design questions

- n/a.

<a id="1"></a>
## 1. Provide a native baseline

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall provide a bounded native repository intelligence provider that can find nonignored text files, resolve exact lexical symbols, rank lexical matches, and read live source without an external executable.

Requirement: When native discovery enumerates a path that is not a regular file, including a Git submodule path, Prism shall report an incomplete repository scan and shall not use that scan for a numeric fit estimate.

Rationale: Repository context planning must remain available when no external index is installed.

Related: [repository-intelligence-providers.md§2](#2), [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§4](#4)

<a id="2"></a>
## 2. Discover registered providers safely

Pattern: Event-driven

Disposition: Active

Requirement: When a caller requests provider discovery for a project, Prism shall report every registered provider's availability, version, capabilities, and sanitized diagnostic without creating or updating an index.

Rationale: Users and automatic selection need inspectable provider state without hidden repository mutation.

Related: [repository-intelligence-providers.md§1](#1), [repository-intelligence-providers.md§3](#3)

<a id="3"></a>
## 3. Select and compose providers

Pattern: Event-driven

Disposition: Active

Requirement: When a caller plans repository context, Prism shall use the native provider for live source and shall add at most one healthy selected external provider for retrieval or graph evidence.

Requirement: Prism shall accept external evidence only when the adapter proves a normalized source snapshot identity that matches the native source snapshot, and Prism shall validate every source path against the canonical project root before external verification or source reading.

Requirement: When CodeNib contributes evidence, Prism shall require the same canonical project root, verified CodeNib source access, an equal concrete commit, and a fresh complete native snapshot before Prism adopts the native snapshot identity for that evidence.

Requirement: Before Prism returns a context plan, Prism shall verify that the whole native source snapshot and the selected external snapshot remain unchanged.

Rationale: Native coverage and external intelligence have complementary strengths and different failure modes.

Related: [repository-intelligence-providers.md§1](#1), [repository-intelligence-providers.md§2](#2), [repository-intelligence-providers.md§4](#4), [repository-intelligence-providers.md§5](#5)

<a id="4"></a>
## 4. Preserve uncertainty

Pattern: Unwanted behavior

Disposition: Active

Requirement: If required hints, source ranges, or claimed retrieval capabilities are unavailable, then Prism shall expose the gap and shall not return a numeric estimate that can support `FIT`.

Requirement: Prism shall enforce consumer-side result limits, merge source ranges that overlap after provider expansion, and count only the final merged rendered source.

Requirement: If graph evidence is bounded, contains an error or note, contains an incomplete source range, or is otherwise incomplete, then Prism shall expose the gap and shall not return a numeric estimate that can support `FIT`.

Rationale: A false complete estimate can cause a false fit decision.

Related: [repository-intelligence-providers.md§1](#1), [repository-intelligence-providers.md§3](#3)

<a id="5"></a>
## 5. Use CodeGraph without managing its index

Pattern: Optional feature

Disposition: Active

Requirement: Where a compatible and current CodeGraph index exists for the exact project root, Prism shall allow CodeGraph to contribute normalized lexical and symbol-graph evidence without running CodeGraph initialization, synchronization, or indexing commands.

Rationale: CodeGraph can improve structural discovery while index ownership remains explicit and external to Prism.

Related: [repository-intelligence-providers.md§2](#2), [repository-intelligence-providers.md§3](#3), [repository-intelligence-providers.md§4](#4)
