# Roadmap

This file is a generated view of roadmap.json.
Current progress is derived from initiative records, so read it through `get_roadmap` or the review browser.

Serves: Reliable planning and resumable work in Prism's spec-driven engineering workflow.

## Initiative index

### Now

- **Repository intelligence** (`repository-intelligence`): Give workflow agents deterministic repository evidence: providers, context planning, session capacity, structural analysis, and duplication gates.

### Next

- **Agent execution evidence and continuity** (`agent-execution-evidence`): Report observed context ranges, keep pause checkpoints current and recoverable, and assess diagram readability.

## Sequencing rationale

- **Repository intelligence**: Kept in Now while repository-intelligence work continues on main.
- **Agent execution evidence and continuity**: Next, because observed-range reporting consumes verified ranges from repository context planning, while pause checkpoints and diagram-readability assessment can proceed independently after design. The new work stays together until design shows that its outcomes need separate sequencing.

## Open questions

- Should the three outcomes of agent-execution-evidence remain in one initiative after design assigns concrete slices?
- Should shipped initiatives be backfilled after the first roadmap baseline is accepted and reviewed against repository history?

## Lifecycle

`envisioned`, `planned`, and `in-progress` are derived from initiative records and coordination state.
`shipped` and `superseded` are recorded decisions.
