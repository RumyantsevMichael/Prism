# Search of reference repositories and libraries

Status: Approved
Created: 2026-11-10
Approved: 2026-11-11

## Problem

Design plans against code it cannot read: a colleague's service whose interface the work calls, a shared library repository, infrastructure code, and third-party libraries.
Agents guess these facts from memory or ask the person to paste code, so a contract can rest on an interface that differs at the version the work actually uses.
Prism's native indexes cover only the project's own checkout, keyed by its working tree, and every result they return is treated as the project's own code.
Michael decided on 9 November 2026 that a workspace's repositories carry a role, worked on or reference, beside a list of libraries, that each work item pins the exact commit of every reference repository it reads, that the project's own code always comes first, and that one separate tool, `search_references`, answers from reference repositories and libraries.
He also decided that a peer team's Prism store can be a reference entry, read-only, with its Approved records shown by default, names qualified by workspace, and its records indexed separately from its code.

## Goals

- Let a separate tool search reference repositories and libraries at the commit or version a work item pins.
- Keep the project's own search and context results free of outside content.
- Index an outside source's interfaces first, and its internals only when a query asks for them.
- Keep outside indexes affordable on a machine that holds many of them.
- Show what changed in the cited files when a pin moves.
- Let a plan cite a peer workspace's requirements and decisions at a known store commit.

## Non-goals

- Declare reference repositories and choose their ref policy, which [reference-repositories.md](reference-repositories.md) owns.
- Pin and move commits on work items or record citations, which [work-item-pins.md](work-item-pins.md) owns.
- Plan slices, run tests, or write anything in a reference repository or a library.
- Store any content of an outside source in the shared store.
- Index host tools such as Claude Code or Codex, whose facts come from probes recorded in host profiles.

## Design questions

- Which interface formats are read first, and how is an exported type recognized per language?
- How is a library's identity derived from each ecosystem's lockfile, and how is a patched installed copy told apart?
- How are many outside indexes ranked against each other in one answer?
- Where on a machine do outside indexes live so that projects share a library's index safely?

<a id="1"></a>
## 1. Keep outside results out of the project's own tools

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall return no result from a reference repository or a library through concept search, context planning, or the structural reports of the project's own code.

Rationale: Michael decided that own code comes first, and mixing outside results into those tools would let a colleague's code crowd out the project's own.

Related: [reference-search.md§2](#2)

<a id="2"></a>
## 2. Search reference repositories and libraries in their own tool

Pattern: Event-driven

Disposition: Active

Requirement: When an agent calls `search_references`, Prism shall answer from the reference repositories and libraries the call names, or from every one the work item pins when it names none.

Rationale: One separate tool keeps outside evidence visibly apart while covering both kinds of outside source.

Related: [reference-search.md§3](#3)

<a id="3"></a>
## 3. Answer at the pinned commit

Pattern: Event-driven

Disposition: Active

Requirement: When `search_references` answers for a work item, Prism shall answer each reference repository from its commit pinned on that work item, and each library from the version its lockfile pins, and name that commit or version in every result.

Rationale: A contract must cite the interface at the version the work uses, not whatever the remote holds today.

Related: [reference-search.md§4](#4), [work-item-pins.md§1](work-item-pins.md#1), [work-item-pins.md§2](work-item-pins.md#2)

<a id="4"></a>
## 4. Answer without a work item at the default commit

Pattern: Event-driven

Disposition: Active

Requirement: When `search_references` is called without a work item, Prism shall answer each reference repository from the commit its entry's ref policy gives and name that commit in every result.

Rationale: Exploration before a work item exists still needs a known version, and naming it lets the later pin match what was read.

Related: [reference-search.md§3](#3), [reference-repositories.md§5](reference-repositories.md#5)

<a id="5"></a>
## 5. Mark every outside result as outside data

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall mark every result of `search_references` as outside data and name its source, commit or version, path, and symbol.

Rationale: A README or a comment in someone else's repository can carry instructions aimed at agents, and a citation needs all four parts to be checked later.

Related: [reference-search.md§2](#2)

<a id="6"></a>
## 6. Index interfaces first

Pattern: Event-driven

Disposition: Active

Requirement: When Prism prepares the index of a reference repository or a library, Prism shall make its interface descriptions, exported types, and documentation searchable before its internal code.

Rationale: The facts a plan needs about outside code are its interfaces, and a library's internals would multiply the index's size for little value.

Related: [reference-search.md§7](#7)

<a id="7"></a>
## 7. Read internals only for a scoped query

Pattern: Event-driven

Disposition: Active

Requirement: When a `search_references` call scopes its query to paths inside a reference repository or a library, Prism shall answer from that source's internal code under those paths as well as its interfaces.

Rationale: An agent that needs one implementation detail can still reach it without every source being indexed in full.

Related: [reference-search.md§6](#6)

<a id="8"></a>
## 8. Prepare only the outside sources a call names

Pattern: Event-driven

Disposition: Active

Requirement: When a `search_references` call needs an outside source whose index at the required commit or version is missing, Prism shall prepare that source's index and no other outside source's index.

Rationale: A workspace can list many reference repositories and hundreds of libraries, and preparing all of them on one call would make the first search unusable.

Related: [components.md§21](components.md#21)

<a id="9"></a>
## 9. Keep outside indexes apart from the project's

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall keep each outside source's index separate from every index of the project's own code and from every other outside source's index.

Rationale: Separate indexes keep outside results out of the project's tools by construction and let each source be rebuilt, removed, or shared on its own.

Related: [reference-search.md§1](#1)

<a id="10"></a>
## 10. Share a library's index between projects

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall prepare one index for each library version on a machine and use it for every project on that machine that pins that version.

Rationale: The same library version is the same content, so preparing it once per project wastes the most expensive step.

Related: [reference-search.md§9](#9)

<a id="11"></a>
## 11. Rebuild only what changed when a pin moves

Pattern: Event-driven

Disposition: Active

Requirement: When the pinned commit of a reference repository moves, Prism shall prepare its index for the new commit in a time that grows with the files changed between the two commits rather than with the whole repository.

Rationale: A busy repository moves often, and a full rebuild on every move would make pins too costly to move.

Related: [index-preparation.md§8](index-preparation.md#8)

<a id="12"></a>
## 12. Show what changed in cited files when a pin moves

Pattern: Event-driven

Disposition: Active

Requirement: When an agent asks what changed for a work item's pin of a reference repository, Prism shall list each file cited by that work item's contract that changed between the old and the new commit, with the change.

Rationale: Moving a pin is safe only when the person and the agent see which contract assumptions rest on changed files.

Related: [reference-search.md§3](#3), [work-item-pins.md§5](work-item-pins.md#5)

<a id="13"></a>
## 13. Report an outside source that this machine cannot read

Pattern: Unwanted behavior

Disposition: Active

Requirement: If this machine cannot fetch a reference repository or find a library's installed copy, then Prism shall report that source as unavailable with the reason and shall not answer for it from any other source or from memory.

Rationale: Colleagues share entries but not access, and an empty answer would read as "the interface has no such thing".

Related: [reference-search.md§5](#5), [reference-repositories.md§7](reference-repositories.md#7)

<a id="14"></a>
## 14. Report a cited commit that is no longer reachable

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a commit that a work item pins or cites is no longer reachable from its reference repository's remote, then Prism shall report the pin or citation as unreachable and keep its repository, commit, and path.

Rationale: A force-push upstream must not erase the evidence a contract rests on.

Related: [reference-search.md§12](#12), [work-item-pins.md§3](work-item-pins.md#3)

<a id="15"></a>
## 15. Search a peer workspace's records

Pattern: Event-driven

Disposition: Active

Requirement: When `search_references` answers from a reference entry that is another Prism workspace's store, Prism shall answer from that store's records at the store commit the work item pins, as records with their kind, status, and links, and name each record with its workspace.

Rationale: A peer team's Approved requirements and decisions are the facts a plan must respect about their system, and a name qualified by workspace keeps them apart from this workspace's records.

Related: [record-search.md§1](record-search.md#1), [reference-search.md§3](#3), [reference-repositories.md§18](reference-repositories.md#18)

<a id="16"></a>
## 16. Show a peer workspace's Approved records by default

Pattern: Optional feature

Disposition: Active

Requirement: Where a `search_references` call names no record status for a peer workspace, Prism shall return only that workspace's Approved requirements, Accepted decisions, and current glossary terms.

Rationale: A peer team's drafts and superseded records are not commitments, and showing them by default would let a plan rest on something the team never agreed.

Related: [record-search.md§2](record-search.md#2)

<a id="17"></a>
## 17. Index a peer workspace's records apart from its code

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall keep the index of a peer workspace's records separate from the indexes of that workspace's code and of this workspace's records.

Rationale: Michael asked for a separate records index, so a question about a peer team's decisions never ranks against their code or against this workspace's own records.

Related: [reference-search.md§9](#9)
