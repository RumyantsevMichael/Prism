---
name: roadmap
description: "Prioritize initiatives into Now, Next, Later, and Parked bands, record superseded initiatives, and migrate a legacy roadmap into the managed roadmap record."
argument-hint: '[initiative]'
sdm: "0.3"
---

# Maintain the roadmap

The roadmap prioritizes whole initiatives, without designing their slices.
The MCP-managed roadmap record owns initiative identity, priority bands, order, cross-initiative requirements, rationale, open questions, and recorded decisions.
Read it with `get_roadmap` and change it with `update_roadmap`.
The roadmap Markdown is a generated view, so agents never edit the record or its Markdown directly.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the [workflow](../workflow/SKILL.md), glossary, and product strategy when present.
3. Call `get_roadmap` and keep its revision.
4. If the roadmap record is missing and a legacy roadmap Markdown file or sibling `roadmap.puml` exists, select migration mode.
5. Otherwise, select re-prioritization mode.
6. State the selected mode.

Configured paths override `docs/roadmap.md` and `docs/Glossary.md`.
The roadmap record sits beside the configured roadmap Markdown with the same base name and a `.json` extension.

## 2. Apply the selected mode

- For re-prioritization:
  1. Conduct a bounded survey of initiative status, strategy alignment, and dependencies through [delegation.md](../workflow/references/delegation.md).
  2. Propose `Now`, `Next`, and `Later` bands locally, first favoring prerequisites that unblock the most initiatives.
  3. For overloaded bands, retain `Must` initiatives required for band success and defer `Should` and `Could` when capacity requires.
  4. Move `Won't, this cycle` and de-prioritized initiatives to `Parked` with reasons.
  5. When adding work to a full band, demote other work to preserve capacity.
  6. Within each band, favor near-complete, low-effort, high-value initiatives and identify high-effort, low-value parking candidates.
  7. When a band exceeds capacity, record the overload and within-band order in the affected initiatives' rationale.
  8. Add each new initiative with a stable identifier, title, intent, served pillar, and Approved requirement links when available.
  9. When an initiative is replaced by another, propose a supersede decision with its replacement and reason.
  10. Resolve strategic questions into banding decisions, requirement tasks, or ADR questions, and keep unresolved ones as open questions.
  11. Prepare the proposed `update_roadmap` operations under the [artifact rules](#3-artifact-rules), without applying them.
  12. Present the proposed changes through the workflow gate rules.
  13. After user acceptance, call `update_roadmap` with the kept revision and the accepted operations.
  14. Inspect the result through [visual-review.md](../workflow/references/visual-review.md).
- For migration:
  1. Read the legacy roadmap Markdown and `roadmap.puml`.
  2. Map each legacy node to one initiative with a stable identifier that matches its plans folder when one exists.
  3. Map packages to bands, `requires` and reversed `unblocks` arrows to required initiatives, prose rationale to initiative rationale, and open questions to open questions.
  4. Map `shipped` and `superseded` nodes to recorded decisions, and leave `envisioned`, `planned`, and `in-progress` to derivation.
  5. Present the proposed record and every unmappable statement through the workflow gate rules.
  6. After user acceptance, create the record by calling `update_roadmap` with `expectedRevision: null`, the accepted operations, and `replace_hand_written_projection`.
  7. Report that `roadmap.puml` is no longer read, and that the user may remove it after review.

Qualitative judgment is the default.
RICE or ICE scores require real reach and effort data.
Priority and dependency remain separate axes, without dates, durations, Gantt charts, or a duplicate dependency table.
Coordination identifiers do not replace durable initiative identity.

## 3. Artifact rules

An initiative identifier uses letters, digits, hyphens, or underscores, never changes, and names the initiative's plans folder.
A title may change without changing the identifier.
Stored bands are `Now`, `Next`, `Later`, and `Parked`, and order within a band is the record order.
`Shipped` is the band that a recorded ship decision derives.
Lifecycle states are `envisioned`, `planned`, `in-progress`, `shipped`, and `superseded`.
`get_roadmap` derives `envisioned`, `planned`, and `in-progress` from the initiative record and coordination state.
`shipped` and `superseded` are recorded decisions, and `update_roadmap` refuses `ship` until every leaf slice is done.
Required initiatives are the only stored dependency, and the inverse relation is derived.
Alignment, rationale, overload risks, and unresolved questions stay in the record's rationale and open questions.

- Return the record path, the applied operations, and the new revision, or the unresolved decision.

Initiative coordination cleanup must wait until the roadmap records the initiative as shipped.
