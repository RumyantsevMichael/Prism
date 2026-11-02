# Artifact conservation

Status: Approved
Created: 2026-10-05
Approved: 2026-10-05

## Problem

A freeform review record cannot reliably bind acceptance to an unchanged plan and source.
Live semantic search can mistake material that the task created for a reuse candidate that existed before the task.

## Goals

- Retain B, A, and F as immutable source evidence that survives semantic cache cleanup.
- Compare exact source spans with the planned changes in the change map.
- Govern review acceptance and active-work mutations with one gate validator.
- Keep measurements separate by dimension and keep unknowns and observed failures visible.

## Non-goals

- Make the gates a filesystem security boundary.
- Authenticate humans or host processes.
- Detect semantic equivalence automatically.

## Design questions

- n/a.

<a id="1"></a>
## 1. Retain source evidence

Pattern: Ubiquitous

Disposition: Active

Requirement: The workflow shall retain original source B before the first target change, audited source A, and final source F, including dirty and untracked files.

Rationale: B→A measures the design changes, and B→F measures the complete task.

Related: [artifact-conservation.md§2](#2), [artifact-conservation.md§10](#10)

<a id="2"></a>
## 2. Preserve the original baseline

Pattern: Ubiquitous

Disposition: Active

Requirement: The server shall preserve the original baseline through corrections and shall reject missing or corrupt affected evidence.

Rationale: Acceptance must bind to the source that the task started from, and missing or corrupt source evidence makes that binding impossible.

Related: [artifact-conservation.md§1](#1), [artifact-conservation.md§8](#8)

<a id="3"></a>
## 3. Require addition search receipts

Pattern: Event-driven

Disposition: Active

Requirement: When design introduces an `ADD`, the server shall require successful native semantic search receipts from B and dispositions for actual returned candidates.

Rationale: Search bound to B prevents material that the task created from appearing as a reuse candidate that existed before the task.

Related: [artifact-conservation.md§1](#1)

<a id="4"></a>
## 4. Compare planned transitions

Pattern: Ubiquitous

Disposition: Active

Requirement: The server shall compare exact planned transitions with source-bound observations and shall report unsupported measurements as unknown.

Rationale: A comparison of exact source spans, not file hashes, binds acceptance to the planned change.

Related: [artifact-conservation.md§1](#1), [artifact-conservation.md§8](#8)

<a id="5"></a>
## 5. Justify growth

Pattern: Ubiquitous

Disposition: Active

Requirement: Every positive measured increase and new public surface shall require requirement-linked justification reviewed independently of delivery.

Rationale: Growth must have a reason that a requirement supports and that a reviewer other than the implementer checks.

Related: [artifact-conservation.md§4](#4), [artifact-conservation.md§7](#7)

<a id="6"></a>
## 6. Assess text resynthesis

Pattern: Ubiquitous

Disposition: Active

Requirement: For affected text, review shall assess resynthesis against the combined requirements and preserve explicitly identified obligations.

Rationale: The server does not detect semantic equivalence, so review must supply text convergence evidence.

Related: [artifact-conservation.md§5](#5)

<a id="7"></a>
## 7. Manage review through typed operations

Pattern: Ubiquitous

Disposition: Active

Requirement: The server shall manage review lanes, findings, ownership, history, disagreements, source bindings, and acceptance through typed atomic operations.

Rationale: One managed review record for each slice keeps results valid across unrelated lane writes and makes them stale when their declared evidence changes.

Related: [artifact-conservation.md§9](#9)

<a id="8"></a>
## 8. Block acceptance on mechanical failures

Pattern: Ubiquitous

Disposition: Active

Requirement: Known mechanical failures shall prevent acceptance and shall not be waived as unsupported checks.

Rationale: Recorded reviewer judgments must keep observed failures, so a reviewer cannot turn a failure into an unknown.

Related: [artifact-conservation.md§4](#4), [artifact-conservation.md§9](#9)

<a id="9"></a>
## 9. Use one gate validator

Pattern: Ubiquitous

Disposition: Active

Requirement: The same gate validator shall govern explanatory checks, review acceptance, and coordination mutations that enter implementation or claim completion.

Rationale: One validator gives the same answer in review acceptance and in typed active-work mutations.

Related: [artifact-conservation.md§7](#7), [artifact-conservation.md§8](#8)

<a id="10"></a>
## 10. Migrate legacy evidence explicitly

Pattern: Ubiquitous

Disposition: Active

Requirement: Legacy evidence shall remain readable and shall migrate explicitly without fabricating an original baseline or importing historical acceptance.

Rationale: The change map moved to version 2, and a slice designed before that change keeps its earlier record.

Related: [artifact-conservation.md§1](#1), [artifact-conservation.md§2](#2)

<a id="11"></a>
## 11. Separate context-budget FIT

Pattern: Ubiquitous

Disposition: Active

Requirement: Context-budget FIT shall remain separate from conservation checks.

Rationale: Context-budget FIT and conservation acceptance are separate checks.

Related: n/a
