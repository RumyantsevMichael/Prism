---
name: write-build-plan
description: Author or update a track's build plan in the plans directory — build order, reuse map, plug points, tests, risks. Use when planning how to build one track of an initiative.
argument-hint: '[initiative/track]'
---

# Write build plan

A build plan is the **build order** for one track: how to get from a settled design to working code without surprises.
It is one of three artifacts in a track's prep bundle (`build-plan.md`, the contracts file, `handoff.md`) under the plans directory (default `/docs/plans/<initiative>/<track>/`).
("Plan" unqualified means the *initiative* plan one altitude up — `/docs/plans/<initiative>/plan.md` — a different artifact; this skill authors the per-track **build plan**.)

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists — it overrides the default paths and stack assumptions below.
If absent, use the defaults and the project's own CLAUDE.md conventions.
The session map and lifecycle rules live in the `workflow` overview skill.

The build plan and the contracts are **mutually validating** and authored in parallel.
The contracts own *shapes*; the build plan owns *sequence, reuse, and risk*.
The build plan **references** the contracts rather than restating types — if you find yourself pasting interfaces in, move them to the contracts file and link instead.

The build plan is **scratch** — deleted in the commit that lands the track's implementation.
So it may name internal labels (workstream IDs, "steps") freely *within itself*, but nothing durable may reference those labels (see the durable-artifacts rule in the `workflow` overview skill).
Cite ADRs, not the build plan's own labels, for rationale.

Before writing, read the project glossary (use its terms), the governing ADR(s), and the contracts you are pairing with.

---

## Where it lives

`<plans-dir>/<initiative>/<track>/build-plan.md`, alongside the contracts file and `handoff.md` for the same track.
`<track>` is the track's handle within its initiative — prefer a descriptive slug (e.g. `V2-streaming-notifications`) over a bare ordinal; `<initiative>` is a short slug for the body of work.

---

## Structure

Adapt to the track, but this skeleton has earned its keep:

```markdown
# <Initiative> / <Track> — build plan

<One-paragraph executive summary: the single load-bearing fact that shapes the
design (e.g. "an existing seam already carries the delivery channel"), so the
reader knows what everything hangs on.>

## Resolved decisions / open items

What is settled (with a one-line each) versus what the implementer still owes a
decision on. Put this first so the reader sees the solid ground before the detail.

## Build order

The workstreams as a dependency DAG — show what can run in parallel and what is on
the critical path, in prose plus a small **Mermaid** diagram (`graph TD`). Call out
which workstreams are mechanical mirrors of existing code and which carry real
judgment, so effort lands where it matters.

## Workstreams

One subsection per workstream. For each:
- **What & where**: the change, and whether it reuses, mirrors, or is new — with
  destination paths for new files and `file:symbol` (or `file:line`) for plug
  points into existing code.
- **Tests**: the unit / integration / acceptance tests this workstream owes, as a
  sub-bullet here — not deferred to a separate section.
- ADR citation for any decision (`ADR 30 §Section-name`).

## Risks & open questions

Bounded risks and owed decisions with an owner — not design ambiguities (those
were resolved above, or feed back to the ADR).

## Recommended model & effort

The model and effort level for the implementation session, and why. Note where to
slow down (judgment-heavy workstreams) versus where mechanical mirroring is safe.

## Critical files

A short `file:symbol` callout list the implementer will touch first.
```

---

## Conventions

- **Cite ADRs, not labels, for rationale.** `ADR 30 §Capability resolution`, never "as decided in step 4".
  The build plan's own labels stay inside it.
- **Express build order as a Mermaid DAG.** Make parallelism and the critical path explicit.
  A flat numbered list hides what can overlap.
- **Map reuse-vs-mirror-vs-new explicitly.** For every workstream say whether it reuses code as-is, mirrors a proven pattern, or is genuinely new — this is the single most useful thing the plan tells the implementer.
- **Pin plug points with `file:symbol`.** Line numbers when precision matters; full destination paths for new files.
- **Tests live with their workstream**, as sub-bullets, so the implementer sees the test obligation next to the work.
- **Concentrate judgment.** Flag which workstreams are mechanical (mirror existing code) and which need care — this directs the implementer's and the model's effort.
- State typing/naming conventions the project uses at boundaries (e.g. Result types for expected failures, schema validation at parse boundaries, domain aliases) once, up front, where they apply — do not repeat per workstream.

---

## Quality checks before finishing

- Build order shows parallelism and the critical path, not just a sequence.
- Every workstream states reuse / mirror / new and its destination or plug point.
- Every decision cites an ADR; no rationale points at the build plan's own labels.
- Each workstream lists the tests it owes.
- A model + effort recommendation for implementation is present and justified.
- Shapes live in the contracts file; the build plan links to them, not restates them.

