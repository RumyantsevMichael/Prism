---
name: roadmap
description: Maintain the durable, priority-ordered roadmap of whole initiatives — the rung between product strategy and /plan. Survey and (re)prioritize into Now/Next/Later, or flip one initiative's state as plans land.
argument-hint: '[initiative]'
---

# Maintain the roadmap

This is the rung **one altitude above `/plan`**: it orders **whole initiatives** by **priority** (the one thing `/plan` is forbidden to do) and is the **only durable** planning surface.
It answers "what do we do next, why this not that, and what blocks what" — never "how do we build one initiative" (that is `/plan`).

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill). Read it first if it exists; it overrides the default paths and stack assumptions below. If absent, use the defaults and the project's own CLAUDE.md conventions. The session map and lifecycle rules live in the `workflow` overview skill.

The artifact is the roadmap file (default `/docs/roadmap.md`) — a single **durable, living** file.
Unlike the one-shot skills, the roadmap is **not** authored once: it is revisited continuously as new information arrives.
So this skill has **two modes**, and you state which you are in up front.

Read first: the roadmap, the product strategy document if the project has one (the vision the roadmap serves), and the glossary (default `/docs/Glossary.md`).

## Mode A — re-prioritization (a `/roadmap` session, gated)

The judgment-heavy mode.
Run **inline with the user**; delegate the read-heavy "what exists / what shipped since last time" to a subagent (pass paths), keep the prioritization call inline.

1. **Orient.**
  Read the current roadmap and the strategy pillars it serves.
  Confirm which initiatives are live, shipped, or newly envisioned since the last pass — delegate this survey to a subagent.
2. **Re-band.**
  Move initiatives between **Now / Next / Later** by priority *given* cross-initiative dependency.
  Band (priority) and arrow (dependency) are orthogonal — keep both visible; never collapse to one axis.
  Sequencing whole initiatives is **not** phasing a design (see Conventions).
3. **Check band load, sub-order if overloaded.**
  A band — especially **Now** — feeds a finite delivery lane.
  When a band holds more concurrent initiatives than that lane can actually advance, breadth *is* the risk: everything inches and nothing ships.
  Surface the overload explicitly, then add an explicit **within-band order** — a finer priority call than the band itself, answering "finish which before starting which."
  Favour initiatives that **unblock downstream nodes** (dependency-aware priority — see **Prioritization lenses**).
  Record it in the sequencing rationale.
  This is still priority, not a schedule and not phasing (see Conventions).
4. **Add envisioned work.**
  New ideas enter as `envisioned` nodes (dashed, just name + intent + the pillar served).
  A node is *usually* ADR-less until `/plan`-ned or `/design`-ned — but an idea already shaped by `/ideate` MAY enter carrying its exploratory `Proposed` ADRs (cite them like any other node).
  `/ideate` never writes the roadmap itself; you attach those ADRs when you band the node.
5. **Park, don't drop.**
  De-prioritized work moves to `parked` with a recorded reason.
  Shipped nodes stay (the roadmap is also the ledger of what got built).
6. **Resolve open questions.**
  Each strategic question routes to a banding decision or a new ADR — never an indefinite parking lot.

**Gate:** present the re-banded roadmap; the user accepts before you write it.

## Mode B — state flip (fired inside another session, no gate)

A one-line colour change bound to a lifecycle event that already passed its own gate.
**No new gate** — re-gating an event that already happened is ceremony.
The flips:

| Trigger | Flip |
|---|---|
| `/plan` accepted, or a self-contained ADR created | envisioned → planned (add ADRs + the `click` plan link) |
| first track enters `/design` | planned → in-progress |
| last track lands (plan folder deleted) | in-progress → shipped (remove the `click` link) |

If the initiative is not yet a node (it was started without ever being roadmapped), **add it** — in `Now`, since it is being worked.
A self-contained feature (no `/plan`) is just an initiative of one track: a single node citing its one ADR.

## Prioritization lenses

Banding and the within-band sub-order (step 3) are **qualitative** calls — on a roadmap without real usage data or a large scored backlog, reach/effort numbers would be invented.
Three lenses, in the order you reach for them:

- **Dependency-aware, first.**
  The forced lens: favour the initiative whose completion *unblocks the most downstream nodes*.
  The graph already encodes it — read the arrows before any softer judgment.
- **MoSCoW, to scope a loaded band.**
  Make each initiative earn its place:
  **Must** (the band fails without it) stays;
  **Should / Could** drop a band down;
  **Won't, this cycle** goes to `parked` with a reason.
  This is the discipline behind "what comes off?" — adding to a band without demoting something is how a finite lane silently overcommits.
- **Value vs effort, to spot quick wins.**
  Within a band, pull near-done, low-effort, high-value nodes forward to bank progress;
  name any high-effort/low-value node as a candidate to **park**, not sequence.

**Deferred on purpose — RICE and ICE.**
Both need *Reach* and *Effort* numbers (users per period, person-months).
Without real usage data, those are fiction — the same reason this skill bans dates.
Adopt them once there is real usage data and a backlog large enough to need scoring;
until then a score only launders guesses into false confidence.

## Writing the artifact

Update the roadmap file in place.
The central Mermaid `graph` (Now/Next/Later bands as `subgraph`s, initiatives as nodes, cross-initiative dependency arrows, state by `classDef`) is the single source of truth for both priority and dependency.
Keep the section list: header/`Serves`, the roadmap graph, initiative index, sequencing rationale, cross-initiative dependencies, parked & superseded, open strategic questions, lifecycle.

## Conventions

- **Priority + dependency, both visible.**
  The band is priority (your call); the arrow is dependency (forced).
  Never collapse them — that is the whole reason this is a `graph`, not a list or a Gantt.
- **No dates.**
  The horizon is the band, not a calendar axis. Durations on a bursty, agent-driven cadence are fiction.
- **Sub-order a loaded band.**
  The band is the coarse priority; the **delivery lane is finite**.
  When one band (typically Now) holds more concurrent initiatives than that lane can advance, add an explicit **within-band order** in the sequencing rationale and flag the overload — running everything at once means nothing ships.
  It is a finer priority call, not a schedule and not phasing;
  favour initiatives that **unblock downstream nodes** so finishing one releases the most work.
  The within-band order lives in the sequencing-rationale prose, not as new bands or dates.
- **Cite ADRs and names, never plan ids.**
  A node's durable identity is name + ADR set + pillar served, so it outlives every plan folder.
  The `click` plan deep-link is the lone tolerated reference to scratch, dropped on ship.
- **Sequencing initiatives ≠ phasing a design.**
  "No phased designs" governs the architecture *inside* one initiative (it lands whole).
  Ordering whole initiatives over time is this roadmap's entire job and does not violate that rule.
- **Anti-rot gate.**
  A plan folder may not be deleted until its roadmap node is `shipped` (rule in the `workflow` overview skill's "Cross-session lifecycles"; `implement`'s last-track gate enforces it).
  The state column is therefore mechanically incapable of lying.
- **Mermaid, not ASCII** — it renders and diffs, same idiom as the plan DAG.

## Gate

Mode A: stop and present the re-banded roadmap; wait for the user to accept before writing.
Mode B: no gate — the flip is bound to an event that already cleared one.
