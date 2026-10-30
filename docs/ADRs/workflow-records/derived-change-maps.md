# Derive a designed slice's change map from its verified result

Status: Proposed
Created: 2026-10-26

## Requirements

No Approved requirement governs this decision yet.
It follows [Complete a designed slice on a recorded verification run](slice-verification-runs.md), which removed the agent-written change map from the leaner workflow.

## Problem

A change map shows the human running the agents what a slice changes, unit by unit, in the review browser.
Agents wrote it by hand through change map operations, which cost many tool calls and did not improve delivery quality in the October 2026 benchmark runs.
The leaner skills no longer write it, so a designed slice would show no change map at all.

## Decision

Design acceptance MUST capture a snapshot of the project source as the slice's baseline, and a failed capture MUST NOT block the acceptance.
A passing verification run of a slice with a baseline MUST capture a snapshot of the source it tested.
The server MUST derive the slice's change map by comparing the parsed units of the baseline with those of the latest passing run's snapshot, and MUST write it as the slice's change map record marked as derived.
A unit present only in the result MUST be listed as added, only in the baseline as removed, and in both with different bytes as changed.
A file MUST be listed itself only when none of its units is listed.
A derived change map MUST NOT replace a change map that an agent wrote, and agent change map operations MUST refuse to edit a derived one.

## Rationale

The diff between two retained snapshots is exact and costs agents nothing, so the review browser keeps its change map without bookkeeping.
Reusing the conservation snapshots and parser analysis gives the same unit identities and references that hand-written change maps used.
The written reason of each change is lost, and the slice's contract in `slice.md` and its requirements carry the intent instead.

## Alternatives

Asking implementers for a short reason per change was rejected because it brings back the bookkeeping that the leaner workflow removed.
Diffing git trees at file level was rejected as the only source because it cannot name the functions and sections that changed.
Planned changes that design writes before implementation, compared with this derived map, are left to a later decision.

## Consequences

Every passing verification run of a designed slice adds one retained snapshot, and its parser analysis is prepared in the background.
Without the semantic runtime, the derived change map lists changed files only.
A container whose nested unit changed is listed only through that unit, so an edit to the container's own text next to a changed member is not listed separately.

## Mechanism

The initiative update tool stores the baseline snapshot identifier on the slice's accepted design.
The verification tool stores the result snapshot identifier on a passing run entry and starts the derivation after it returns.
Opening a designed slice in the review browser starts a derivation when the change map does not match the latest passing run, and the slice page shows that the change map is being built.

## Decision Log
