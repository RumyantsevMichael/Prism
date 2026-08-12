---
name: workflow
description: "Explain Prism's workflow map, context boundaries, artifact lifecycles, and durable rules. Use with workflow skills or to understand how they connect."
---

# The agentic engineering workflow

This is a spec-driven flow for changes big enough to need a spec.
They move through at least **two fresh contexts** over a layered specification.
A small change that needs no spec skips the flow entirely: make it directly under the project's baseline conventions.

Project settings (paths, stack, tracker) live in `.prism/workflow.md` at the project root, created by the `workflow-init` skill.
Read it if it exists.
It overrides the default paths and stack assumptions below.
All configured paths resolve from the project root.

The workflow skills named here are siblings in this plugin: `roadmap`, `ideate`, `plan`, `design`, `implement`, `orchestrate`, `validate-artifacts`, and the `write-*` family.
When one says "load `write-requirements`" or "run `plan`", use the host's supported skill invocation mechanism.
A project may provide verification, security review, repair, or commit instructions outside Prism.
Use those instructions when available, and use the inline Prism procedure otherwise.
A project may also override any sibling with a local skill, and the local one wins.

## The map

Each rung is a skill, and each runs in **its own fresh context**:

- **Priority** (`roadmap`): order whole initiatives Now/Next/Later.
  This is the only priority call and the only durable planning surface.
- **Shaping** (`ideate`, optional): brainstorm a shapeless idea into Approved EARS requirements, or kill it.
- **Build order** (`plan`): decompose a multi-track requirement set into dependency-ordered tracks.
- **Spec** (`design`): per track, requirements + ADRs + technical design → contracts + build plan + feature files → handoff.
- **Build** (`implement`): read the validated specification cold, write tests first, implement to green, verify, and audit.

`orchestrate` chains plan → design → implement across tracks through fresh child-agent contexts.
The `write-*` skills run inside the drafting work that `design` coordinates.
The `validate-artifacts` skill always runs in an isolated context with only the on-disk artifacts.
None of these supporting skills needs a user-started task when the host can create the required child-agent context.

**Defect repair** sits outside the flow.
A repair session restores code to the already-settled spec: reproduce it with a failing test, diagnose the root cause **without touching production code**, then stop and report the diagnosis for approval before any fix.
Pull the code to the spec, never the spec to the code.
A fix that would require changing a requirement, ADR, feature file, or contract is not a repair.
Escalate it to the artifact's owning workflow.
Follow the project's repair instructions if they exist.
Otherwise, use the reproduce, diagnose, report, approve, and fix procedure in this section.

**One workflow skill per context.**
`ideate`, `plan`, `design`, and `implement` are deliberate context boundaries.
If one has already run in the current context, run the next in a **fresh** context.
The cold read exposes design assumptions before implementation starts.
`orchestrate` is the sole exception because it chains the others through genuinely fresh child-agent contexts.

The organizing principle across every run is to **protect the main context**.
Push read-heavy and parallel work to child agents when the host provides them.
Pass child agents paths and a scoped task, never inlined contents.
Use a fresh context when independence or a clean slate is required.
Keep inline the load-bearing reasoning and anything interactive with the user.

**Ground conclusions in evidence, not assumption, and do not give up early.**
Before you declare something impossible, required, blocked, or "gated" (any negative or limiting claim), prove it: reproduce it, or cite the authoritative doc that says so.
A plausible inference is a hypothesis to test, not a conclusion.
Research and verify **before you down-scope, defer, or call something a residual**.

## Host capabilities

Inspect the capabilities that the current host provides before delegating work.

- **Child agents:** Use them for independent reading and drafting when available.
- **Context isolation:** Use an isolated child context for adversarial validation.
- **Context inheritance:** Use an inheriting child context when settled conversation decisions must carry forward.
- **Workspace isolation:** Run concurrent writing tasks only when each task has an isolated workspace.
- **Task resumption:** Resume a child task when supported, or start a replacement from the on-disk artifacts.
- **Structured input:** Use it for real user choices when configured and available, or use plain text.

When child agents are unavailable, do ordinary drafting sequentially in the current context.
When isolated validation is unavailable, ask the user to run `validate-artifacts` in a separate fresh task and relay its findings.
When workspace isolation is unavailable, run writing tasks sequentially without adding a new user gate.

Recommend an execution profile only for a child agent you are about to start or for the next fresh context at handoff.
Render the recommendation as:

- Complexity: standard | high
- Context: fresh
- Parallelism: sequential | independent
- Focus: <specific risk areas>

## Documentation hierarchy

Read documentation in this order before any task.
The workflow configuration can relocate these defaults.

1. The glossary (default `docs/Glossary.md`): term definitions and navigation.
2. Approved requirements (default `docs/requirements/*.md`): durable product and system obligations in EARS form.
3. Relevant ADRs (default `docs/ADRs/`): architectural invariants and settled decisions in RFC 2119 language.
4. Relevant Gherkin feature files (default `docs/Features/*.feature`): executable behavioral invariants derived from requirements.

The glossary only defines what terms mean, not behavioral rules.
Requirements own product obligations, and ADRs own architectural decisions.
Feature files specify executable behavior from requirements.
When requirements, ADRs, or feature files conflict, stop and report the conflict to the user.
Do not resolve it yourself.

## Diagram artifacts

PlantUML source files use the `.puml` extension and live beside the artifact that they support.
Agents MUST read the `.puml` source and MUST NOT read rendered images.
Rendered images are temporary human-review output and MUST NOT enter version control.
Markdown artifacts link to each related `.puml` file with a relative Markdown link.
The local Prism review server discovers diagrams from these links and renders them in the human review page.

A replacement diagram owns only its graph-shaped enumeration.
The surrounding prose still owns rationale, consequences, risks, conditions, and open questions.
Do not repeat diagram-owned edges, transitions, or order as a prose list or table.
If prose and a diagram conflict, stop and reconcile both sources.

Use these diagram rules:

- Use a C4 Context or Container diagram to complement an ADR only when relationship count or review risk justifies it.
- Use a state diagram to replace an ADR lifecycle transition list.
- Use a dependency graph for roadmap initiatives and initiative-plan tracks.
- Use an activity diagram for build order.
- Use a component diagram for a build-plan reuse map.
- Use a class diagram to complement real contract interfaces when type relationships need visual review.
- Use an object diagram only when one concrete object graph resolves an important ambiguity.
- Use a sequence diagram to complement a handoff when call order across a plug point affects correctness.
- Do not add diagrams to requirements or Gherkin feature files.

Use the Prism review server for human review when its tools are available.
Call `present_review` at a visual-review gate and pass the project-relative artifact path.
The tool is for the human and returns no rendered image to the agent.
If the tool is unavailable, present the source artifacts and continue with the normal gate.

Existing projects can contain inline Mermaid diagrams from older Prism versions.
Convert a Mermaid diagram when its owning workflow next edits that artifact.
Verify every node, edge, label, and state before removing the Mermaid block.
Do not migrate unrelated artifacts without an explicit request.

## Cross-session lifecycles

The **rule** is fixed here.
The mechanics live in the named skill.

- **Roadmap state** (envisioned → planned → in-progress → shipped): `roadmap`.
  Status flips fire inside whichever session triggers them, standalone features included.
- **Requirement file status** (Draft → Approved → Superseded or Withdrawn): `ideate` or `write-requirements` creates Draft files.
  The user approves product intent before `plan` or `design` consumes it.
  A semantic change creates a new flat requirement number and supersedes the old section.
  Requirements do not gain an implementation status.
  Mechanics live in `write-requirements`.
- **ADR status** (Proposed → Accepted): created `Proposed` by a planning or design session.
  **Only the implementation session** flips it `Accepted`, at the user's confirmation of correctness.
  The flip is a file edit and does not wait for a commit.
  Acceptance means the decision survived being built.
  Mechanics in `write-adr`.
- **Track status** (not-started → in-progress → done, or blocked/deferred): `design` flips a track `in-progress` at its start, and `implement` flips it `done` at landing, in both the spine DAG and the track file.
  Mechanics in `plan`, `design`, and `implement`.
- **Plan folders** are scratch with a gated end of life: created by `plan`, deleted only when the last track lands.
  Deletion sits behind the **graduate-before-delete** gate.
  Every open question and cross-cutting concern must graduate to a requirement, ADR, feature file, user doc, or tracker issue.
  An explicitly killed item also satisfies the gate.
  The anti-rot rule prohibits deletion before the roadmap node is `shipped`.
  Mechanics in `implement`'s last-track gate.

## Durable artifacts must not reference non-durable identifiers

Everything under the plans directory (default `docs/plans/`) is **scratch** and is deleted after implementation.
Scratch identifiers include track names, build steps, section numbers, handoffs, spikes, and locked-decision labels.
So **nothing durable may reference it**: not code, comments, requirements, READMEs, ADRs, commit messages, or test assertions.
A future session has zero context for `T4 § 5` once that file is gone.

- **State the obligation and cite the requirement.** State the rationale and cite the ADR.
  Do not cite the plan section that scheduled the work.
  Put missing architectural rationale in an ADR.
- **Describe deferred work by what it is**: "Planned", never "T9".
- **Allowed durable references:** requirements, ADRs, the glossary, feature files, and named project rules.
  Plan tracks, steps, and sections are not.
- **The roadmap's one exception:** an *in-flight* roadmap node may carry a deep-link to its live plan folder.
  This is a navigation convenience, removed when the node ships.

This applies as you write, not as a later cleanup pass.

## User-facing docs and runbooks

The user-guide directory (default `docs/user-guide/`) is the source-of-truth for install, configure, and use.
Any change to observable behavior MUST update it in the same change.
Mark unshipped capabilities **Planned**.
Link to requirements for obligations and ADRs or the glossary for rationale and terms.

An **operational capability** (build, sign, publish, host, rotate, migrate) MUST ship with an operator runbook living with the tooling it documents.
It MUST be accurate to the real commands, never guesswork.
**Needing to read source to learn a capability is a missing-runbook signal.**
It MUST surface the guarantees a consumer relies on, flag genuinely-unsettled decisions (key custody, hosting, certificates) as **TBD** rather than papering over them, and give the operator's *procedure*.
The procedure is numbered and copy-pasteable, with exact commands or a UI click-path, not just the pipeline's shape.

## Backlog

The project's issue tracker (default: GitHub issues) is the durable record for **all work below initiative level**: defects and small buildable follow-ups.
The roadmap stays initiative-level.
Requirements stay product-obligation level.
ADRs stay decisions.
Issues are the sub-initiative backlog.
A repair session works from a defect issue, and its landing `fix(scope):` commit references it.
Graduate-before-delete turns a closing plan's loose ends into follow-up issues.
Closing issues is user-initiated: prepare and propose, never close unasked.

Use different labels for the two types.
The workflow configuration can name the project's vocabulary.

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
Cite the requirement, ADR, track, or section after the explanation as the paper trail.

The user reviews as an informed engineer, not as a co-author of the spec's vocabulary.
So "the session cache is wiped on restart, so signing out one device would silently sign out the others" lands where "the `SessionRegistry` isn't persisted" does not.
Keep the rigor in the artifacts, and keep the conversation in plain language.
This governs the *wording*, never the delivery mechanism (see below).

### How to deliver the question

The rule above governs *framing*.
This governs *delivery*.
They are independent, and the framing never changes.

**Default: structured input when available.**
If workflow config sets `Interaction style: structured`, use the host's structured input capability at a gate or decision fork.
If the host lacks structured input, present the options as plain text.
Put your recommendation first and mark it `(Recommended)`.
Keep each option's label short and let its description carry the trade-off.

**Opt-out: plain text.**
If workflow config sets `Interaction style: plain-text`, present the same options as a short numbered list and let the user answer in prose.
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

Cite a requirement for the obligation and an ADR for rationale where they apply.
Never cite a plan.
No test counts or "tests green" noise.

Never push.
Committing is user-initiated.
**Do not proactively propose a commit on your own, including at the end of a workflow session**, which is exactly the moment the pull to do so is strongest.
Only when the user asks do you prepare and propose the message, following these conventions and any applicable project commit instructions.
The `orchestrate` skill is an exception after the user explicitly sets its per-run commit dial.
