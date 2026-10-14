# Managed roadmap and initiative records

Status: Accepted
Created: 2026-10-13

## Requirements

No Approved requirement governs this decision yet.
It records a direction proposed with the entity-first review browser proof of concept.

## Problem

The roadmap and each initiative's slice graph were PlantUML sources that agents edited as text.
The roadmap diagram had no fixed grammar and no parser, so no tool could read initiative bands, states, or dependencies reliably.
Initiative identity differed between the roadmap node, the plans folder, and the map title.
Orchestration wrote lifecycle states that other artifacts already implied, so the roadmap could disagree with the slice graph.
A review application that navigates by initiative and slice needs structured, validated data rather than diagrams.

## Decision

The roadmap and every initiative slice graph MUST be structured records that only MCP tools change, each with a revision and a generated Markdown view.
Agents MUST NOT edit a record or its generated view directly.
A generated view MUST NOT replace a hand-written file without an explicit replacement request.
An initiative identifier MUST be stable and MUST name the initiative's plans folder.
The initiative directory MUST be the root slice folder, and every other slice folder MUST sit directly under it.
The roadmap MUST store only decisions: bands, order, required initiatives, rationale, open questions, and the recorded `shipped` and `superseded` outcomes.
The `envisioned`, `planned`, and `in-progress` states MUST be derived from the initiative record and coordination state.
A `shipped` decision MUST be refused until every leaf slice is done, and it MUST be recorded before coordination cleanup removes the initiative record.
The initiative record MUST own slice titles, outcomes, topology, requirement assignments, dependencies, and status.
Every initiative record write MUST validate the whole slice graph, and a `done` slice status MUST require a passing completion gate.

## Rationale

Typed operations make invalid graphs and ambiguous identities impossible to write instead of merely detectable.
Derived progress cannot drift from the slice graph that produces it.
A recorded ship decision is still required because plans are scratch, and cleanup would otherwise erase the facts that prove completion.
The pattern already governs review ledgers and coordination state, so agents follow one record discipline.

## Alternatives

A strict PlantUML roadmap grammar with a parser would keep diagrams as the source but keep diagrams hard to read and keep stored lifecycle states able to drift.
A single record for the roadmap and every slice graph would serialize all agents behind one revision.
Best-effort parsing of the existing roadmap diagram would break whenever an agent phrased it differently.

## Consequences

The review browser can show the roadmap as a board, list, or graph and drill into initiatives and slices without parsing prose.
Existing projects need migration: slice graphs import deterministically from the strict map grammar, while roadmaps migrate with agent assistance and user confirmation.
Removing the map-writing skill and changing artifact formats is a breaking change.
Humans reading the repository without the review browser see generated Markdown instead of diagrams.

## Mechanism

The roadmap record sits beside the configured roadmap Markdown and the initiative record sits beside the initiative's coordination state.
Reads return the record with its revision and derived facts; writes take the expected revision and a batch of typed operations that apply atomically or not at all.
Orchestration creates the roadmap entry before the initiative record, creates or imports the initiative record, applies accepted splits and dependency changes, sets leaf status, records the ship decision, graduates durable facts, and then deletes the initiative directory.
The roadmap skill applies accepted prioritization and supersede decisions and migrates legacy roadmaps.

## Decision Log

2026-10-14: Accepted after three real orchestrated runs created, completed, and shipped initiatives only through the record tools, and the user approved the change for review.
2026-10-14: Clarified that the initiative directory is the root slice folder, after a run showed the completion gate looking for the root slice's review in a subfolder.
