# Retain source evidence and enforce conservation in MCP

Status: Proposed

## Context

A freeform review record cannot reliably bind acceptance to an unchanged plan and source.
Live semantic search can also mistake material created during the task for a preexisting reuse candidate.
The existing native source scanner, runtime, parser adapters, content revisions, and atomic persistence already own the necessary lower-level guarantees.

## Decision

Retain B, A, and F as immutable source manifests with content-addressed blobs in host-private storage.
Bind native search receipts to B and compare exact source spans rather than file hashes for contained concepts.
Extend the concept delta to version 2 and use one MCP-managed review record per slice.
Use one gate validator inside review acceptance and typed active-work mutations.
Preserve human-readable Markdown as a regenerable projection of authoritative JSON.
Keep measurements separate by dimension and preserve unknowns and observed failures when recording reviewer judgments.
Require explicit private-detail attribution, growth justification, and text convergence evidence without implementing automatic semantic equivalence.

## Consequences

Retained evidence survives semantic cache cleanup and adds private disk use.
Review results remain valid across unrelated lane writes but become stale when their declared evidence changes.
Direct filesystem edits remain possible; gates govern authoritative Prism records rather than acting as a filesystem security boundary.
Workers declare their identity and role; the ledger enforces workflow ownership rather than authenticating humans or host processes.
Public native-runtime publication remains a release prerequisite, and Windows support remains unverified until its CI executes.
