---
name: roadmap
description: "Prioritize initiatives and update their roadmap states."
argument-hint: '[initiative]'
sdm: "0.3"
---

# Maintain the roadmap

The roadmap prioritizes whole initiatives, without designing their slices.
Its sibling `roadmap.puml` owns priority bands, lifecycle states, and cross-initiative dependencies.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the [workflow](../workflow/SKILL.md), roadmap, glossary, and product strategy when present.
3. Select orchestrated state-change mode only for a transition requested by `orchestrate` after its gate.
4. Otherwise, select re-prioritization mode.
5. State the selected mode.

Configured paths override `docs/roadmap.md` and `docs/Glossary.md`.

## 2. Apply the selected mode

- For re-prioritization:
  1. Conduct a bounded survey of initiative status, strategy alignment, and dependencies through [delegation.md](../workflow/references/delegation.md).
  2. Propose `Now`, `Next`, and `Later` bands locally, first favoring prerequisites that unblock the most initiatives.
  3. For overloaded bands, retain `Must` initiatives required for band success and defer `Should` and `Could` when capacity requires.
  4. Move `Won't, this cycle` and de-prioritized initiatives to `Parked` with reasons.
  5. When adding work to a full band, demote other work to preserve capacity.
  6. Within each band, favor near-complete, low-effort, high-value initiatives and identify high-effort, low-value parking candidates.
  7. When a band exceeds capacity, record the overload and within-band order in the sequencing rationale.
  8. Add new initiatives as dashed `envisioned` nodes with a name, intent, served pillar, and Approved requirement links when available.
  9. Retain shipped initiatives as history.
  10. Resolve strategic questions into banding decisions, requirement tasks, or ADR questions.
  11. Prepare the proposed prose and diagram under the [artifact rules](#3-artifact-rules), without replacing current files.
  12. Inspect the candidate through [visual-review.md](../workflow/references/visual-review.md).
  13. Present the proposed changes through the workflow gate rules.
  14. After user acceptance, save the roadmap and sibling `roadmap.puml`.
- For an orchestrated state change:
  1. If the initiative node is missing, return `BLOCKED` because only re-prioritization creates initiatives.
  2. Apply exactly the requested transition and associated links from the table below.
  3. Check the candidate against the [artifact rules](#3-artifact-rules), preserving other initiatives, priority bands, and dependencies.
  4. Save the required changes without questions, approval, or visual review.

| Trigger | Transition | Associated changes |
| --- | --- | --- |
| Initial initiative map created | `envisioned` to `planned` | Cite requirements and any ADRs, and add the `click` map link. |
| First slice starts design | `planned` to `in-progress` | None. |
| Last slice lands | `in-progress` to `shipped` | Move to `Shipped` and remove the `click` map link. |

Qualitative judgment is the default.
RICE or ICE scores require real reach and effort data.
Priority and dependency remain separate axes, without dates, durations, Gantt charts, or a duplicate dependency table.
Coordination identifiers do not replace durable initiative identity.

## 3. Artifact rules

The roadmap links its source as `[Roadmap diagram](roadmap.puml)`.
Nonempty packages are `Now`, `Next`, `Later`, `Parked`, and `Shipped`.
State stereotypes are `envisioned`, `planned`, `in-progress`, `shipped`, and `superseded`.
Dependency arrows use `requires` or `unblocks`.
The prose retains its header, `Serves`, roadmap link, initiative index, sequencing rationale, parked context, superseded context, open questions, and lifecycle.
Alignment, rationale, overload risks, and unresolved questions stay in prose.

- Return the paths and applied changes, or the unresolved decision.

The roadmap stores PlantUML source, not rendered images, ASCII diagrams, or EBNF.
Initiative coordination cleanup must wait until its roadmap node is `shipped`.
