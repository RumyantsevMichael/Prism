---
name: workflow
description: Overview of the spec-driven agentic engineering workflow — the session map (roadmap/ideate/plan/design/implement), cross-session lifecycles, and durable-artifact rules. Load when running any workflow skill, or to understand how the skills chain together.
---

# The agentic engineering workflow

A spec-driven flow for changes big enough to need a spec: they move through at least **two sessions** over a layered spec — first an ADR, then technical design, build plan, contracts, feature files. A small change that needs no spec skips the flow entirely: make it directly under the project's baseline conventions.

Project settings (paths, stack, tracker) live in `.claude/workflow-config.md` at the project root, created by the `workflow-init` skill. Read it if it exists; it overrides the defaults below.

All skills named here are siblings in this plugin: when a skill says "load `write-adr`" or "`/plan`", resolve it under the plugin's namespace (e.g. `lux:write-adr`, `/lux:plan`).

## The map

Each rung is a skill, and each runs as **its own session**:

| Rung | Skill | Job |
|---|---|---|
| Priority | `roadmap` | Order whole initiatives Now/Next/Later — the only priority call, the only durable planning surface. |
| Shaping *(optional)* | `ideate` | Brainstorm a shapeless idea into Proposed ADR(s) — or kill it. |
| Build order | `plan` | Decompose a multi-ADR initiative into dependency-ordered tracks. |
| Spec | `design` | Per track: ADR ⇄ technical design → contracts + build plan + feature files → handoff. |
| Build | `implement` | Fresh session: validate the spec, tests first, implement to green, verify, audit. |

`orchestrate` chains plan → design → implement across tracks via fresh subagent sessions. The `write-*` skills and `validate-artifacts` are sub-skills loaded *inside* these sessions, never sessions of their own. **Defect repair** sits outside the flow (a defect surfaces at any time): a repair session restores code to the already-settled spec — diagnose and report before any fix, never re-design mid-repair.

**One workflow skill per session.** `ideate`, `plan`, `design`, and `implement` are deliberate context boundaries: if one has already run in a session, the next starts in a **fresh** session — never chained. The cold read is the point — it is what makes downstream validation honest. `orchestrate` is the sole exception: chaining the others through genuinely fresh subagent sessions is its entire job.

The organizing principle across every session is **protect the main session's context** — push read-heavy and parallelizable work to subagents (pass them paths and a scoped task, never inlined contents), and use a fresh session when independence or a clean slate is what's needed. Keep inline the load-bearing reasoning and anything interactive with the user.

**Ground conclusions in evidence, not assumption — do not give up early.** Before declaring something impossible, required, blocked, or "gated" — any negative or limiting claim — prove it: reproduce it, or cite the authoritative doc that says so. A plausible inference is a hypothesis to test, not a conclusion.

Recommend model and effort only (a) for a subagent you are about to spawn, and (b) for the next session at handoff.

## Documentation hierarchy

Read documentation in this order before any task (defaults; workflow-config may relocate):

1. The glossary (default `/docs/Glossary.md`) — term definitions and navigation.
2. Relevant ADRs (default `/docs/ADRs/*/ADR.md`) — architectural invariants and settled decisions, in RFC 2119 language.
3. Relevant Gherkin feature files (default `/docs/Features/*.feature`) — behavioral invariants; the executable specification for observable behavior.

When an architectural invariant in an ADR conflicts with a behavioral invariant in a feature file, stop and report the conflict to the user — do not resolve it yourself.

## Cross-session lifecycles

The **rule** is fixed here; the mechanics live in the named skill.

- **Roadmap state** (envisioned → planned → in-progress → shipped) — `roadmap`. Status flips fire inside whichever session triggers them, standalone features included.
- **ADR status** (Proposed → Accepted) — created `Proposed` by an ideation, planning, or design session; **only the implementation session** flips it `Accepted`, in the change that lands the code — acceptance means the decision survived being built. Mechanics in `write-adr`.
- **Track status** (not-started → in-progress → done, or blocked/deferred) — `design` flips a track `in-progress` at its start, `implement` flips it `done` at landing, in both the spine DAG and the track file. Mechanics in `plan`, `design`, and `implement`.
- **Plan folders** are scratch with a gated end of life: created by `plan`, deleted only when the last track lands, behind the **graduate-before-delete** gate (every open question and cross-cutting concern graduates to a durable home — ADR, feature file, user docs, tracker issue — or is explicitly killed) and the **anti-rot** rule (a plan folder MUST NOT be deleted before its roadmap node is `shipped`). Mechanics in `implement`'s last-track gate.

## Durable artifacts must not reference non-durable identifiers

Everything under the plans directory (default `/docs/plans/`) — track names (`T4`), build "steps", section numbers (`§ 6.2`), "handoff", "spike", "Locked decision N" — is **scratch**, deleted once implemented. So **nothing durable may reference it** — not code/doc comments, READMEs, ADRs, commit messages, or test assertions; a future session has zero context for `T4 § 5` once that file is gone.

- **State the rationale, cite the ADR**, not the plan section that scheduled the work — and if it isn't yet in an ADR, put it there.
- **Describe deferred work by what it is** — "Planned", never "T9".
- **Allowed durable references:** ADRs, the glossary, feature files, named project rules. Plan tracks/steps/sections are not.
- **The roadmap's one exception:** an *in-flight* roadmap node may carry a deep-link to its live plan folder — a navigation convenience, removed when the node ships.

This applies as you write, not as a later cleanup pass.

## User-facing docs and runbooks

The user-guide directory (default `/docs/user-guide/`) is the source-of-truth for install/configure/use. Any change to observable behavior MUST update it in the same change; mark unshipped capabilities **Planned**. An **operational capability** (build, sign, publish, host, rotate, migrate) MUST ship with an operator runbook living with the tooling it documents — accurate to the real commands, procedure numbered and copy-pasteable.

## Backlog

The project's issue tracker (default: GitHub issues) is the durable record for **all work below initiative level** — defects (`bug`) and small buildable follow-ups (`enhancement`). The roadmap stays initiative-level; ADRs stay decisions; issues are the sub-initiative backlog. A repair session works from a bug issue; graduate-before-delete turns a closing plan's loose ends into enhancement issues. Closing issues is user-initiated.

## Presenting decisions to the user

When a session surfaces a decision that is the user's to make, state it **plainly first**: the situation in everyday terms, the concrete choice, and your recommendation. Cite the ADR / track / section *after*, as the paper trail, never as the explanation. Keep the rigor in the artifacts; keep the conversation plain.

## Git

Conventional commits: `type(scope): header`, imperative, ≤72 chars, body explaining what and **why**. Types: `feat`, `fix`, `chore`, `refactor` (production code only), `docs`. Cite an ADR for rationale where one applies; never cite a plan. No test counts or "tests green" noise. Never push; committing is user-initiated — prepare and propose the message only when asked, following these conventions (or the project's own commit skill if it has one).
