# Roadmap

Serves: Reliable planning and resumable work in Prism's spec-driven engineering workflow, inferred from the configured product description because product strategy is set to `n/a`.

The proposed priority bands and lifecycle states are shown in the [roadmap diagram](roadmap-proposal.puml).

## Initiative index

- **Repository intelligence** — proposed as `Now` and `in-progress` because provider-selection corrections remain in the working tree, even though the current design and implementation reviews are clean; the [provider-selection slice](plans/repository-intelligence/provider-selection/slice.md) is the available entry point because the bounded survey found no top-level initiative map.
- **Agent execution evidence and continuity** — proposed as `Next` and `envisioned` to group [observed context-range size](requirements/partial-context-estimates.md#1), [current pause checkpoints](requirements/pause-recovery-checkpoints.md#1), [incomplete-checkpoint reporting](requirements/pause-recovery-checkpoints.md#2), [checkpoint-failure preservation](requirements/pause-recovery-checkpoints.md#3), and [diagram-readability assessment](requirements/slice-complexity-assessment.md#1).

## Sequencing rationale

- Keep repository intelligence in `Now` while its current provider-selection changes remain unlanded.
- Place the new initiative in `Next` because observed-range reporting consumes verified ranges from repository context planning, while pause checkpoints and diagram-readability assessment can proceed independently after design.
- Treat this as a provisional ordering because no prior roadmap or product strategy is present to establish capacity or strategic priority.
- Keep the new work together at roadmap level until design shows that its outcomes need separate sequencing or ownership.

## Parked context

No parked initiatives surfaced in the available artifacts, and the missing prior roadmap provides no parked decisions to restore.

## Superseded context

No superseded initiative history was available in the bounded survey.

## Open questions

- Does the proposed `Next` placement match the intended priority relative to current repository-intelligence work?
- Should the three new outcomes remain in one initiative after design assigns concrete slices?
- Should the existing repository-intelligence work receive a top-level initiative map while its status is represented in the new roadmap?
- Should shipped initiatives be backfilled after the first roadmap baseline is accepted and reviewed against repository history?

## Lifecycle

An `envisioned` initiative becomes `planned` when its initial map is created with Approved-requirement and applicable-ADR citations and the roadmap diagram receives a clickable link to that initiative map.

The first slice entering design changes an initiative to `in-progress`, and the last slice landing changes it to `shipped`.

Superseded initiatives remain in roadmap history with their replacement relationship recorded.
