---
name: orchestrate
description: Drive a whole initiative end to end — plan (if needed), then design → implement per track, running every independent track concurrently — by spawning and orchestrating subagent sessions. Invoke to run a multi-track initiative with every human gate still live.
disable-model-invocation: true
argument-hint: [initiative]
---

# Orchestrate an initiative

This is **orchestration**: the same `plan` → `design` → `implement` flow the
`workflow` overview skill defines, run as a chain of **subagent sessions** you
spawn and orchestrate, instead of sessions the user opens and closes by hand.

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill). Read it first if it exists; it overrides the default paths below. If absent, use the defaults and the project's own CLAUDE.md conventions.

It is the **one exception** to "one workflow skill per session" — this skill's
entire job is to *chain* the others. It never authors an ADR, plan, contract, or
line of code itself; every artifact still comes from a `plan`, `design`, or
`implement` subagent running that skill in **its own**, genuinely fresh context
(a true `Agent` call, never a continuation of yours). Orchestration replaces the
*manual session switch* only — it does not relax a single gate, validation pass,
or freshness requirement those skills already impose.

Run this **inline with the user** — you are the orchestrator, not a worker, and you
never resolve a *content* question on the user's behalf yourself. The
subagents do that resolving where it's theirs to do, within the limits step 1
sets. Delegate all reading, drafting, and building to the subagents; your own
context stays just the loop state (which track, which phase, the autonomy
contract, what's pending on the user).

**"Orchestrator, not worker" is about decisions, not about motion.** Spawning the
next subagent, moving from one track to the next, resuming a subagent with an
answer — none of that is a decision, so none of it needs permission. The whole
point of this skill is to remove the manual session-switch; re-introducing a
"may I continue?" prompt at every step recreates the toil it exists to remove.
The only things that ever stop the chain are: a subagent escalating a real
question (step 1's dial), a terminal Gate that the underlying skill itself
requires the user to accept, or a track ending unfinished. Outside those three,
keep moving without asking.

## 1. Set this run's autonomy contract

Before touching the initiative, ask the user to set the three dials below **for
this run only** — a per-session opt-in, not a change to any other skill's or
session's defaults: standing authorization must be scoped, and this run is its
scope.

- **Decision autonomy** — how much a `plan`/`design` subagent may resolve
  without escalating:
  - **Conservative** (default) — resolve only what's answerable from existing
    ADRs, the glossary, the product strategy document (if any), or the
    initiative's own settled artifacts, citing the source. Escalate any new
    tradeoff, scope cut, or conflict between settled docs (the `workflow`
    overview skill's conflict rule).
  - **Broad** — also resolve a tradeoff or scope call itself when confident it
    fits the initiative's already-settled direction, and report what it
    decided (and why) instead of blocking on it. Still hard-escalates anything
    that would itself need to become a new ADR, anything reaching outside its
    own track, and any doc conflict.

  Neither level touches the terminal **Gates** — `plan` acceptance, `design`'s
  right-size check, `implement`'s correctness confirmation always stop and wait
  for the user. This dial governs in-flight judgment calls only, never those
  structural checkpoints.

- **Commit / push** — two orthogonal dials, both **off** by default:
  - **Commit** — if on, once a track lands clean *and* the user has confirmed
    correctness at `implement`'s gate (step 4c), you may run the commit
    yourself instead of only proposing the message. It shortens the
    "should I commit" round-trip; it never moves the correctness confirmation
    itself, which still always happens.
  - **Push** — if on, you may push after committing. Stays off even when
    commit is on unless the user separately grants it — a push is visible to
    others and harder to reverse than a local commit, so it earns its own
    opt-in.

- **Track continuation** — how many chains run at once:
  - **Auto** (default) — run every currently-eligible track's full chain
    concurrently (the DAG's "frontier" — see step 4), and the moment any track
    lands, immediately start any of its dependents that just became eligible.
    This is the normal mode: the point of orchestrating is to not be a manual,
    one-track-at-a-time session, and "start an eligible track" is not a
    decision.
  - **Stepwise** — run one chain at a time and ask before starting the next,
    even when the DAG would allow more. Pick this only when the user wants
    tighter checkpointing than the dials above already give them.

State the levels back to the user plainly before spawning anything, and carry
them through every subagent you spawn this run (folded into each
stop-and-return instruction). If the user changes a dial mid-run, it applies
from that point forward, not retroactively.

## 2. Resolve the initiative

- `<plans dir>/<initiative>/plan.md` exists (plans dir default `/docs/plans/`)
  → multi-track; read the spine's Mermaid DAG for track order and status. Go to
  step 4.
- No plan, and the work is genuinely multi-track → go to step 3.
- No plan, single self-contained feature → it is its own one-track chain; go to
  step 4 treating the feature itself as the only "track" (no plan phase, no
  DAG — `design` and `implement` both already handle a standalone feature this
  way).

## 3. Plan phase (only when no plan exists)

Spawn a subagent named `plan-<initiative>` loading the `plan` skill for this
initiative. State a model/effort for it yourself — there is no upstream
recommendation to inherit here. Instruct it explicitly, at the
decision-autonomy level set in step 1:

> Resolve anything answerable from existing ADRs, the glossary, the product
> strategy document, or this initiative's own settled artifacts yourself —
> cite what you used and keep going; that's applying settled context, not
> making a new decision. [Conservative: stop and return anything beyond that.]
> [Broad: also resolve a tradeoff or scope call yourself when you're confident
> it fits the initiative's already-settled direction, and report what you
> decided and why instead of blocking.] Stop and return only what's genuinely
> undecided anywhere — a new tradeoff (conservative) or anything that would
> itself need to become a new ADR, anything reaching outside this initiative,
> or a conflict between settled docs (both levels) — with the context needed
> to answer it. Do not guess past those.

Run the **orchestrator loop** (below) until it reports reaching its Gate. Present the
plan (tracks, DAG, release-readiness checklist) to the user yourself, plainly —
this is `plan`'s own hard gate, not yours to wave through. Proceed only once
they accept.

## 4. Track chains, run frontier-parallel

The **frontier** is every not-yet-`done` track whose dependencies are all
`done` — read straight off the spine's DAG and status classes. The DAG can
branch, so the frontier often holds more than one track at once; that is
exactly the parallelism to exploit, never by preference (ordering within a
dependency chain is still `plan`'s own rule, unchanged here — only tracks with
**no** dependency edge between them run concurrently).

At **Track continuation: Auto** (the default), run every track currently in
the frontier through 4a–4c **concurrently**, each as its own named subagent
chain (`design-<track>`, `implement-<track>`). The moment any track reaches
`done`, recompute the frontier — its dependents may just have become eligible
— and start their chains immediately, without waiting for any other chain
still in flight to finish. At **Stepwise**, run one chain at a time and ask
before starting the next, even if the frontier holds more than one track.

You will often be holding several subagents open at once. The
orchestrator loop doesn't change — broker whichever subagent returns a
question or reaches a gate next, in whatever order they actually come back;
never block one track's chain on another unless the DAG forces it.

**Two correctness hazards parallel chains introduce, both yours to manage:**

- **Worktree isolation.** The moment more than one chain is in flight, spawn
  every `design-<track>` and `implement-<track>` subagent with worktree
  isolation (`Agent`'s `isolation: "worktree"`) — concurrent chains writing to
  the same working tree (code, contracts, even two `<track>.md` files at once)
  will otherwise collide. A single chain running alone needs no isolation.
  Isolation cuts collisions but also **visibility**, so you own the merge at
  each boundary: when the user accepts `design-<track>`'s gate, merge that
  worktree back into the main tree **before** spawning `implement-<track>` —
  the implement subagent reads the prep bundle from the main tree, never from
  a sibling worktree. Likewise a track's implementation reaches the main tree
  by merging its worktree at the 4c gate, after the user's correctness
  confirmation. Merge one track at a time; if a merge conflicts with a track
  that landed while this one was in flight, reapply what is mechanical and
  surface the rest to the user — never silently drop either side.
- **The spine `plan.md` is shared state every concurrent chain wants to edit**
  (each track's own status flip — `design` marks itself started, `implement`
  marks itself done). Two subagents flipping their own node's status near-
  simultaneously can race and clobber each other's one-line edit even across
  worktrees, since the spine is initiative-level, not track-level. After any
  subagent reports a status-changing action, re-read the live spine and
  confirm its node matches what it reported; if a concurrent write clobbered
  it, reapply the missing one-line edit yourself immediately. This is a
  mechanical repair, not a new judgment call — never let it become an excuse to
  re-derive a track's status from anything but what that track's own subagent
  just told you.

Within-skill parallelism — `design`'s own contracts/build-plan/feature-files
fan-out, `plan`'s spike legwork — already happens inside those skills and
needs no wiring here; this step is only about running independent **tracks**
concurrently.

### 4a. Design

Spawn a subagent named `design-<track>` loading the `design` skill for
`<initiative>/<track>`, with the same decision-autonomy-scoped instruction as
step 3 and your own model/effort call. Run the orchestrator loop until it reaches
its Gate (artifacts presented, right-size check stated).

Present the artifacts and the right-size check to the user yourself. **Wait for
explicit acceptance** — `design`'s gate is not yours to wave through, at any
autonomy level. Note the model/effort its handoff recommends for
implementation; carry it forward verbatim in 4b rather than guessing fresh.

### 4b. Implement

On acceptance, spawn a **new** subagent named `implement-<track>` — a true
fresh `Agent` call sharing no history with the design subagent — loading
`implement` for the same track, using the model/effort design's handoff
recommended. Same autonomy-scoped stop-and-return instruction for
`// OPEN:` seam confirmations and anything else `implement` calls out as
needing the user.

**Validation gaps route back to design, never to you or to implement itself.**
If the implement subagent reports a step-1 spec gap, resume `design-<track>`
(it's still addressable) with the gap; once it confirms the fix, resume
`implement-<track>`. If the design subagent is no longer resumable, spawn a
fresh one — the artifacts on disk are the authority either way, so a cold read
recovers the same context.

Run the orchestrator loop until `implement` reaches its Gate.

### 4c. Track gate

Relay the gate's **gated vs. unfinished** classification to the user exactly as
the subagent stated it — do not soften, relabel, or decide a re-scope yourself,
at any autonomy level; sizing and scope calls belong to the user here exactly
as in a manual session.

- **Unfinished work remains** → stop the chain for this track. Surface it
  plainly and wait; do not auto-respawn or auto-rescope.
- **Track lands clean** → get the user's explicit correctness confirmation —
  this always happens, regardless of the commit dial. Then:
  - **Commit off** (default) → prepare the commit message (per the Git conventions in the `workflow` overview skill) and
    propose it; never run it.
  - **Commit on** → prepare the message and run the commit yourself. If
    **push** is also on, push it; otherwise stop after the local commit and
    say so.

  Then apply the **track continuation** dial from step 1: **Auto** → recompute
  the frontier and immediately start every chain that just became eligible, no
  prompt, alongside whatever other chains are still in flight; **Stepwise** →
  ask before starting the next one. Either way, say plainly what landed and
  what's next so the user can interrupt at will — silence isn't the goal,
  asking permission for routine motion is what to avoid.

Continue until the DAG is exhausted (every track `done`) or the user stops
you.

Update the roadmap as the initiative's status changes.

---

## The orchestrator loop

Every subagent call in this skill follows the same shape:

1. Spawn or resume the subagent with the relevant skill and the
   autonomy-scoped stop-and-return instruction from step 1.
2. Read what it returns.
   - **A question for the user** → relay it in plain language, not a
     transcription of the subagent's internal vocabulary (see "Presenting
     decisions to the user" in the `workflow` overview skill). Get their
     answer. Resume the subagent (`SendMessage` to its name) with that answer.
     Go to 2.
   - **It reached its skill's Gate** → stop looping; that gate's acceptance is
     the user's call, handled in the calling step above.

## Conventions

- **Default to motion.** Outside the three stop conditions named at the top
  (an escalated question, a terminal Gate, an unfinished track), do not pause
  to check in — spawn the next subagent, resume one with an answer, start
  every track the frontier just made eligible. If you notice yourself about to
  ask "should I proceed?" with no real decision attached, that's the failure
  mode this skill exists to avoid.
- **The autonomy contract is set once, at step 1, and applies uniformly.**
  Don't let an individual subagent or track silently run at a different
  level — if the work seems to call for more or less autonomy mid-run, ask the
  user to change the dial rather than deciding it yourself.
- **Resolve from documentation, escalate per the chosen level.** Even at
  *broad*, a subagent never decides something that would itself need to become
  a new ADR, that reaches outside its own track, or that conflicts with a
  settled doc — those always escalate. You relay what crosses that line and
  never resolve it yourself, even when the answer seems obvious to you — you
  don't have the subagent's depth of reading on this track, so "obvious" from
  where you sit is not the same bar.
- **Every hard gate from `plan`/`design`/`implement` still applies, unchanged,
  at any autonomy level.** This skill adds an orchestrator (and, optionally, a
  commit/push actor), never a shortcut around plan acceptance, design's
  right-size check, or implement's correctness confirmation.
- **Spikes need no separate handling.** Ordering spikes belong to `plan`,
  track-feasibility spikes to `design` — each already runs its own inline,
  exactly as their skills specify. Do not lift spike-running into this skill.
- **Parallel by default for independent tracks.** Unlike a manual,
  one-track-per-session cadence (`roadmap`'s own caution is about *human*
  review bandwidth, not subagent throughput), this skill exists precisely to
  remove that bottleneck — run every track in the current frontier
  concurrently per step 4, worktree-isolated, and grow the frontier the moment
  a track lands. Only `plan` and a track's own design-then-implement order stay
  strictly sequential; everything else the DAG doesn't force, run at once.
- **Commit/push only ever run at the levels step 1 set, and issue filing is
  never autonomous.** No dial is offered for filing or closing tracker issues
  (default: GitHub issues; workflow-config may name another tracker) — always
  prepare and propose those, regardless of the commit/push dials.
- **A subagent's "fresh" requirement is real, not ceremonial.** Never reuse an
  `implement` subagent across tracks, and never let a `design` subagent's
  context leak into its track's `implement` subagent — that independence is
  what makes `implement`'s validation pass a fair check, per `implement`'s own
  rationale.

## Gate

This skill has no gate of its own — it ends when the DAG is exhausted (all
tracks `done`, initiative graduated and `shipped` per `implement`'s last-track
gate) or when the user stops the chain. Every gate inside it belongs to the
phase that defines it, unaffected by the autonomy contract.
