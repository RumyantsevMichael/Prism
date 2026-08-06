---
name: workflow
description: "Overview of the spec-driven agentic engineering workflow: the session map (roadmap/ideate/plan/design/implement), cross-session lifecycles, and durable-artifact rules. Load when running any workflow skill, or to understand how the skills chain together."
---

# The agentic engineering workflow

This is a spec-driven flow for changes big enough to need a spec.
They move through at least **two sessions** over a layered spec: first an ADR, then technical design, build plan, contracts, and feature files.
A small change that needs no spec skips the flow entirely: make it directly under the project's baseline conventions.

Project settings (paths, stack, tracker) live in `.claude/workflow-config.md` at the project root, created by the `workflow-init` skill.
Read it if it exists.
It overrides the default paths and stack assumptions below.

The workflow skills named here are siblings in this plugin: `roadmap`, `ideate`, `plan`, `design`, `implement`, `orchestrate`, `validate-artifacts`, and the `write-*` family.
When one says "load `write-adr`" or "`/plan`", resolve it under the plugin's namespace (for example `prism:write-adr` or `/prism:plan`).
Some skills named here are *not* in that list: `verify`, `run`, `security-review`, a commit skill, or a repair skill.
These resolve outside the plugin, to a Claude Code built-in or a project-local skill of that name.
A project may also override any sibling with a local skill, and the local one wins.

## The map

Each rung is a skill, and each runs as **its own session**:

- **Priority** (`roadmap`): order whole initiatives Now/Next/Later.
  This is the only priority call and the only durable planning surface.
- **Shaping** (`ideate`, optional): brainstorm a shapeless idea into Proposed ADRs, or kill it.
- **Build order** (`plan`): decompose a multi-ADR initiative into dependency-ordered tracks.
- **Spec** (`design`): per track, ADR ⇄ technical design → contracts + build plan + feature files → handoff.
- **Build** (`implement`): fresh session, validate the spec, tests first, implement to green, verify, audit.

`orchestrate` chains plan → design → implement across tracks through fresh subagent sessions.
The `write-*` skills load inside the drafter forks that `design` spawns, and `validate-artifacts` always runs as an isolated forked subagent through its own `context: fork`.
None of them is ever a session of its own.

**Defect repair** sits outside the flow.
A repair session restores code to the already-settled spec: reproduce it with a failing test, diagnose the root cause **without touching production code**, then stop and report the diagnosis for approval before any fix.
Pull the code to the spec, never the spec to the code.
A fix that would require changing an ADR, a feature file, or a contract is not a repair, so escalate it to a design session.
Follow the project's own repair skill if it has one.

**One workflow skill per session.**
`ideate`, `plan`, `design`, and `implement` are deliberate context boundaries: if one has already run in a session, the next starts in a **fresh** session, never chained.
The cold read is the point, because it makes downstream validation honest.
`orchestrate` is the sole exception: chaining the others through genuinely fresh subagent sessions is its entire job.

The organizing principle across every session is to **protect the main session's context**.
Push read-heavy and parallelizable work to subagents (pass them paths and a scoped task, never inlined contents), and use a fresh session when independence or a clean slate is what you need.
Keep inline the load-bearing reasoning and anything interactive with the user.

**Ground conclusions in evidence, not assumption, and do not give up early.**
Before you declare something impossible, required, blocked, or "gated" (any negative or limiting claim), prove it: reproduce it, or cite the authoritative doc that says so.
A plausible inference is a hypothesis to test, not a conclusion.
Research and verify **before you down-scope, defer, or call something a residual**.

Recommend model and effort only (a) for a subagent you are about to spawn, and (b) for the next session at handoff.
Render the recommendation as:

- Model: <model_name>
- Effort: <effort_level>

## Documentation hierarchy

Read documentation in this order before any task (these are defaults, and workflow-config may relocate them):

1. The glossary (default `/docs/Glossary.md`): term definitions and navigation.
2. Relevant ADRs (default `/docs/ADRs/*/ADR.md`): architectural invariants and settled decisions, in RFC 2119 language.
3. Relevant Gherkin feature files (default `/docs/Features/*.feature`): behavioral invariants, the executable specification for observable behavior.

The glossary only defines what terms mean, not behavioral rules.
When an architectural invariant in an ADR conflicts with a behavioral invariant in a feature file, stop and report the conflict to the user.
Do not resolve it yourself.

## Cross-session lifecycles

The **rule** is fixed here.
The mechanics live in the named skill.

- **Roadmap state** (envisioned → planned → in-progress → shipped): `roadmap`.
  Status flips fire inside whichever session triggers them, standalone features included.
- **ADR status** (Proposed → Accepted): created `Proposed` by an ideation, planning, or design session.
  **Only the implementation session** flips it `Accepted`, at the user's confirmation of correctness.
  The flip is a file edit and does not wait for a commit.
  Acceptance means the decision survived being built.
  Mechanics in `write-adr`.
- **Track status** (not-started → in-progress → done, or blocked/deferred): `design` flips a track `in-progress` at its start, and `implement` flips it `done` at landing, in both the spine DAG and the track file.
  Mechanics in `plan`, `design`, and `implement`.
- **Plan folders** are scratch with a gated end of life: created by `plan`, deleted only when the last track lands.
  Deletion sits behind the **graduate-before-delete** gate (every open question and cross-cutting concern either graduates to a durable home, such as an ADR, feature file, user docs, or tracker issue, or is explicitly killed) and the **anti-rot** rule (a plan folder MUST NOT be deleted before its roadmap node is `shipped`).
  Mechanics in `implement`'s last-track gate.

## Durable artifacts must not reference non-durable identifiers

Everything under the plans directory (default `/docs/plans/`) is **scratch**, deleted once implemented: track names (`T4`), build "steps", section numbers (`§ 6.2`), "handoff", "spike", and "Locked decision N".
So **nothing durable may reference it**: not code or doc comments, READMEs, ADRs, commit messages, or test assertions.
A future session has zero context for `T4 § 5` once that file is gone.

- **State the rationale, cite the ADR**, not the plan section that scheduled the work.
  If it is not yet in an ADR, put it there.
- **Describe deferred work by what it is**: "Planned", never "T9".
- **Allowed durable references:** ADRs, the glossary, feature files, and named project rules.
  Plan tracks, steps, and sections are not.
- **The roadmap's one exception:** an *in-flight* roadmap node may carry a deep-link to its live plan folder.
  This is a navigation convenience, removed when the node ships.

This applies as you write, not as a later cleanup pass.

## User-facing docs and runbooks

The user-guide directory (default `/docs/user-guide/`) is the source-of-truth for install, configure, and use.
Any change to observable behavior MUST update it in the same change.
Mark unshipped capabilities **Planned**.
Link to ADRs and the glossary for rationale rather than duplicating it.

An **operational capability** (build, sign, publish, host, rotate, migrate) MUST ship with an operator runbook living with the tooling it documents.
It MUST be accurate to the real commands, never guesswork.
**Needing to read source to learn a capability is a missing-runbook signal.**
It MUST surface the guarantees a consumer relies on, flag genuinely-unsettled decisions (key custody, hosting, certificates) as **TBD** rather than papering over them, and give the operator's *procedure*.
The procedure is numbered and copy-pasteable, with exact commands or a UI click-path, not just the pipeline's shape.

## Backlog

The project's issue tracker (default: GitHub issues) is the durable record for **all work below initiative level**: defects and small buildable follow-ups.
The roadmap stays initiative-level.
ADRs stay decisions.
Issues are the sub-initiative backlog.
A repair session works from a defect issue, and its landing `fix(scope):` commit references it.
Graduate-before-delete turns a closing plan's loose ends into follow-up issues.
Closing issues is user-initiated: prepare and propose, never close unasked.

Label so the two read apart (these are defaults, and workflow-config may name the project's own vocabulary):

- `type:bug`, `type:enhancement`, `type:docs`: what kind of work it is.
- `area:<name>`: scope.
  Check the existing area labels before inventing one.
- `needs-design`: a **routing rule**, not a description.
  An enhancement carrying it must go through a design pass before it can be built.

Only an item that genuinely **blocks the launch** additionally surfaces as a roadmap launch-readiness gate, which merely links to the issue.
The issue stays the record.

## Presenting decisions to the user

When a session surfaces a decision that is the user's to make (at a gate, or any choice you cannot resolve from the spec), state it **in plain language first**: the situation in everyday terms, the concrete choice, and your recommendation.
Lead with that framing.
Cite the ADR, track, or section *after*, as the paper trail, never as the explanation.

The user reviews as an informed engineer, not as a co-author of the spec's vocabulary.
So "the session cache is wiped on restart, so signing out one device would silently sign out the others" lands where "the `SessionRegistry` isn't persisted" does not.
Keep the rigor in the artifacts, and keep the conversation in plain language.
This governs the *wording*, never the delivery mechanism (see below).

### How to deliver the question

The rule above governs *framing*.
This governs *delivery*.
They are independent, and the framing never changes.

**Default: a structured prompt.**
Use Claude Code's `AskUserQuestion` tool at a gate or a decision fork.
It renders the options as selectable choices, which keeps a long run legible and makes the decision points scannable afterwards.
Put your recommendation first and mark it `(Recommended)`.
Keep each option's label short and let its description carry the trade-off.

**Opt-out: plain text.**
If workflow-config sets `Interaction style: plain-text`, present the same options as a short numbered list in the message body and let the user answer in prose.
Same options, same order, and same recommendation, so only the delivery differs.

**Either way, reserve it for real forks.**
A gate, a trade-off you cannot resolve from the spec, or a choice that changes what gets built.
Never use it for routine motion, progress narration, or "shall I continue?".
Asking permission for mechanics is the anti-pattern the autonomy dials in `orchestrate` exist to prevent.
A question the spec already answers is a question you should not be asking.

## Git

Conventional commits: `type(scope): header`, imperative, ≤72 chars, with a body explaining what and **why**.

Types, with their boundaries:

- `feat`, `fix`: production behavior added or repaired.
- `docs`: any pass that changes documentation only.
- `refactor`: production code restructuring only, **never** dev tooling.
- `chore`: anything that neither adds features nor fixes bugs in production code.

Cite an ADR for rationale where one applies.
Never cite a plan.
No test counts or "tests green" noise.

Never push.
Committing is user-initiated.
**Do not proactively propose a commit on your own, including at the end of a workflow session**, which is exactly the moment the pull to do so is strongest.
Only when the user asks do you prepare and propose the message, following these conventions (or the project's own commit skill if it has one).
