---
name: orchestrate
description: "Drive a whole initiative end to end: plan (if needed), then design → implement per track, running every independent track concurrently, by spawning and orchestrating subagent sessions. Invoke to run a multi-track initiative with every human gate still live."
disable-model-invocation: true
argument-hint: '[initiative]'
---

# Orchestrate an initiative

This is **orchestration**: the same `plan` → `design` → `implement` flow the `workflow` overview skill defines.
You run it as a chain of **subagent sessions** you spawn and orchestrate, instead of sessions the user opens and closes by hand.

Project settings for this workflow live in `.claude/workflow-config.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project's own CLAUDE.md conventions.
The session map and lifecycle rules live in the `workflow` overview skill.

It is the **one exception** to "one workflow skill per session", because this skill's entire job is to *chain* the others.
It never authors an ADR, plan, contract, or line of code itself.
Every artifact still comes from a `plan`, `design`, or `implement` subagent running that skill in **its own**, genuinely fresh context (a true `Agent` call, never a continuation of yours).
Orchestration replaces the *manual session switch* only.
It does not relax a single gate, validation pass, or freshness requirement those skills already impose.

Run this **inline with the user**.
You are the orchestrator, not a worker, and you never resolve a *content* question on the user's behalf yourself.
The subagents do that resolving where it is theirs to do, within the limits step 1 sets.
Delegate all reading, drafting, and building to the subagents.
Your own context stays just the loop state (which track, which phase, the autonomy contract, and what is pending on the user).

**"Orchestrator, not worker" is about decisions, not about motion.** Spawning the next subagent, moving from one track to the next, or resuming a subagent with an answer: none of that is a decision, so none of it needs permission.
The whole point of this skill is to remove the manual session-switch.
Re-introducing a "may I continue?" prompt at every step recreates the toil it exists to remove.
The only things that ever stop the chain are: a subagent escalating a real question (step 1's dial), a terminal Gate that the underlying skill itself requires the user to accept, or a track ending unfinished.
Outside those three, keep moving without asking.
When one of the three *does* stop the chain, deliver it per **"How to deliver the question"** in the `workflow` overview skill: a structured prompt by default, plain text if workflow-config says so.
That delivery is for real forks only, never for the motion above.

## 1. Set this run's autonomy contract

Before touching the initiative, ask the user to set the three dials below **for this run only**.
This is a per-session opt-in, not a change to any other skill's or session's defaults: standing authorization must be scoped, and this run is its scope.

- **Decision autonomy**: how much a `plan`/`design` subagent may resolve without escalating:
  - **Conservative** (default): resolve only what is answerable from existing ADRs, the glossary, the product strategy document (if any), or the initiative's own settled artifacts, citing the source.
    Escalate any new tradeoff, scope cut, or conflict between settled docs (the `workflow` overview skill's conflict rule).
  - **Broad**: also resolve a tradeoff or scope call itself when confident it fits the initiative's already-settled direction, and report what it decided (and why) instead of blocking on it.
    Still hard-escalates anything that would itself need to become a new ADR, anything reaching outside its own track, and any doc conflict.

Neither level touches the terminal **Gates**: `plan` acceptance, `design`'s right-size check, and `implement`'s correctness confirmation always stop and wait for the user.
This dial governs in-flight judgment calls only, never those structural checkpoints.

- **Commit / push**: two orthogonal dials, both **off** by default:
  - **Commit**: if on, once a track lands clean *and* the user has confirmed correctness at `implement`'s gate (step 4c), you may run the commit yourself instead of only proposing the message.
    It shortens the "should I commit" round-trip.
    It never moves the correctness confirmation itself, which still always happens.
  - **Push**: if on, you may push after committing.
    Stays off even when commit is on unless the user separately grants it.
    A push is visible to others and harder to reverse than a local commit, so it earns its own opt-in.

- **Track continuation**: how many chains run at once:
  - **Auto** (default): run every currently-eligible track's full chain concurrently (the DAG's "frontier", see step 4), and the moment any track lands, immediately start any of its dependents that just became eligible.
    This is the normal mode: the point of orchestrating is to not be a manual, one-track-at-a-time session, and "start an eligible track" is not a decision.
  - **Stepwise**: run one chain at a time and ask before starting the next, even when the DAG would allow more.
    Pick this only when the user wants tighter checkpointing than the dials above already give them.

State the levels back to the user plainly before spawning anything, and carry them through every subagent you spawn this run (folded into each stop-and-return instruction).
If the user changes a dial mid-run, it applies from that point forward, not retroactively.

## 2. Resolve the initiative

- `<plans dir>/<initiative>/plan.md` exists (plans dir default `/docs/plans/`) → multi-track.
  Read the spine's Mermaid DAG for track order and status.
  Go to step 4.
- No plan, and the work is genuinely multi-track → go to step 3.
- No plan, single self-contained feature → it is its own one-track chain.
  Go to step 4 treating the feature itself as the only "track" (no plan phase, no DAG, and `design` and `implement` both already handle a standalone feature this way).

## 3. Plan phase (only when no plan exists)

Spawn a subagent named `plan-<initiative>` loading the `plan` skill for this initiative.
State a model/effort for it yourself, in the model/effort recommendation format the `workflow` overview skill defines.
There is no upstream recommendation to inherit here.
Instruct it explicitly, at the decision-autonomy level set in step 1:

> Resolve anything answerable from existing ADRs, the glossary, the product strategy document, or this initiative's own settled artifacts yourself.
> Cite what you used and keep going, because that is applying settled context, not making a new decision.
> [Conservative: stop and return anything beyond that.]
> [Broad: also resolve a tradeoff or scope call yourself when you are confident it fits the initiative's already-settled direction, and report what you decided and why instead of blocking.]
> Stop and return only what is genuinely undecided anywhere, with the context needed to answer it: a new tradeoff (conservative), or anything that would itself need to become a new ADR, anything reaching outside this initiative, or a conflict between settled docs (both levels).
> Do not guess past those.

Run the **orchestrator loop** (below) until it reports reaching its Gate.
Present the plan (tracks, DAG, release-readiness checklist) to the user yourself, plainly.
This is `plan`'s own hard gate, not yours to wave through.
Proceed only once they accept.

## 4. Track chains, run frontier-parallel

The **frontier** is every not-yet-`done` track whose dependencies are all `done`, read straight off the spine's DAG and status classes.
The DAG can branch, so the frontier often holds more than one track at once: exploit that parallelism, never by preference (ordering within a dependency chain is still `plan`'s own rule, unchanged here, and only tracks with **no** dependency edge between them run concurrently).

At **Track continuation: Auto** (the default), run every track currently in the frontier through 4a-4c **concurrently**, each as its own named subagent chain (`design-<track>`, `implement-<track>`).
The moment any track reaches `done`, recompute the frontier, because its dependents may just have become eligible.
Then start their chains immediately, without waiting for any other chain still in flight to finish.
At **Stepwise**, run one chain at a time and ask before starting the next, even if the frontier holds more than one track.

You will often be holding several subagents open at once.
The orchestrator loop does not change.
Broker whichever subagent returns a question or reaches a gate next, in whatever order they actually come back.
Never block one track's chain on another unless the DAG forces it.

**Two correctness hazards parallel chains introduce, both yours to manage:**

- **Worktree isolation.** The moment more than one chain is in flight, spawn every `design-<track>` and `implement-<track>` subagent with worktree isolation (`Agent`'s `isolation: "worktree"`).
  Concurrent chains writing to the same working tree (code, contracts, even two `<track>.md` files at once) will otherwise collide.
  A single chain running alone needs no isolation.
  Isolation cuts collisions but also **visibility**, so you own the merge at each boundary: when the user accepts `design-<track>`'s gate, merge that worktree back into the main tree **before** spawning `implement-<track>`.
  The implement subagent reads the prep bundle from the main tree, never from a sibling worktree.
  Likewise a track's implementation reaches the main tree by merging its worktree at the 4c gate, after the user's correctness confirmation.
  Merge one track at a time.
  If a merge conflicts with a track that landed while this one was in flight, reapply what is mechanical and surface the rest to the user, and never silently drop either side.
- **The spine `plan.md` is shared state every concurrent chain wants to edit** (each track's own status flip: `design` marks itself started, `implement` marks itself done).
  Two subagents flipping their own node's status near-simultaneously can race and clobber each other's one-line edit even across worktrees, since the spine is initiative-level, not track-level.
  After any subagent reports a status-changing action, re-read the live spine and confirm its node matches what it reported.
  If a concurrent write clobbered it, reapply the missing one-line edit yourself immediately.
  This is a mechanical repair, not a new judgment call.
  Never let it become an excuse to re-derive a track's status from anything but what that track's own subagent just told you.

Within-skill parallelism (`design`'s own contracts/build-plan/feature-files fan-out, `plan`'s spike legwork) already happens inside those skills and needs no wiring here.

### 4a. Design

Spawn a subagent named `design-<track>` loading the `design` skill for `<initiative>/<track>`, with the same decision-autonomy-scoped instruction as step 3 and your own model/effort call, in the format the `workflow` overview skill defines.
Run the orchestrator loop until it reaches its Gate (artifacts presented, right-size check stated).

Present the artifacts and the right-size check to the user yourself.
**Wait for explicit acceptance.** `design`'s gate is not yours to wave through, at any autonomy level.
Note the model/effort its handoff recommends for implementation.
Carry it forward verbatim in 4b rather than guessing fresh.

### 4b. Implement

On acceptance, spawn a **new** subagent named `implement-<track>`, a true fresh `Agent` call sharing no history with the design subagent, loading `implement` for the same track, using the model/effort design's handoff recommended.
Same autonomy-scoped stop-and-return instruction for `// OPEN:` seam confirmations and anything else `implement` calls out as needing the user.

**Validation gaps route back to design, never to you or to implement itself.** If the implement subagent reports a step-1 spec gap, resume `design-<track>` (it is still addressable) with the gap.
Once it confirms the fix, resume `implement-<track>`.
If the design subagent is no longer resumable, spawn a fresh one.
The artifacts on disk are the authority either way, so a cold read recovers the same context.

Run the orchestrator loop until `implement` reaches its Gate.

### 4c. Track gate

Relay the gate's **gated vs. unfinished** classification to the user exactly as the subagent stated it.
Do not soften, relabel, or decide a re-scope yourself, at any autonomy level.
Sizing and scope calls belong to the user here exactly as in a manual session.

- **Unfinished work remains** → stop the chain for this track.
  Surface it plainly and wait, and do not auto-respawn or auto-rescope.
- **Track lands clean** → get the user's explicit correctness confirmation, which always happens, regardless of the commit dial.
  Then:
  - **Commit off** (default) → prepare the commit message (per the Git conventions in the `workflow` overview skill) and propose it, never run it.
  - **Commit on** → prepare the message and run the commit yourself.
    If **push** is also on, push it.
    Otherwise stop after the local commit and say so.

Then apply the **track continuation** dial from step 1.
**Auto** → recompute the frontier and immediately start every chain that just became eligible, no prompt, alongside whatever other chains are still in flight.
**Stepwise** → ask before starting the next one.
Either way, say plainly what landed and what is next so the user can interrupt at will.
Silence is not the goal, and asking permission for routine motion is what to avoid.

Continue until the DAG is exhausted (every track `done`) or the user stops you.

Update the roadmap as the initiative's status changes.

---

## The orchestrator loop

Every subagent call in this skill follows the same shape:

1. Spawn or resume the subagent with the relevant skill and the autonomy-scoped stop-and-return instruction from step 1.
2. Read what it returns.
   - **A question for the user** → relay it in plain language, not a transcription of the subagent's internal vocabulary (see "Presenting decisions to the user" in the `workflow` overview skill).
     Get their answer.
     Resume the subagent (`SendMessage` to its name) with that answer.
     Go to 2.
   - **It reached its skill's Gate** → stop looping.
     That gate's acceptance is the user's call, handled in the calling step above.

## Conventions

- **Default to motion.** Outside the three stop conditions named at the top (an escalated question, a terminal Gate, an unfinished track), do not pause to check in.
  Spawn the next subagent, resume one with an answer, and start every track the frontier just made eligible.
  If you notice yourself about to ask "should I proceed?" with no real decision attached, that is the failure mode this skill exists to avoid.
- **The autonomy contract is set once, at step 1, and applies uniformly.** Do not let an individual subagent or track silently run at a different level.
  If the work seems to call for more or less autonomy mid-run, ask the user to change the dial rather than deciding it yourself.
- **Resolve from documentation, escalate per the chosen level.** Even at *broad*, a subagent never decides something that would itself need to become a new ADR, that reaches outside its own track, or that conflicts with a settled doc.
  Those always escalate.
  You relay what crosses that line and never resolve it yourself, even when the answer seems obvious to you.
  You do not have the subagent's depth of reading on this track, so "obvious" from where you sit is not the same bar.
- **Every hard gate from `plan`/`design`/`implement` still applies, unchanged, at any autonomy level.** This skill adds an orchestrator (and, optionally, a commit/push actor), never a shortcut around plan acceptance, design's right-size check, or implement's correctness confirmation.
- **Spikes need no separate handling.** Ordering spikes belong to `plan`, and track-feasibility spikes to `design`.
  Each already runs its own inline, exactly as their skills specify.
  Do not lift spike-running into this skill.
- **Parallel by default for independent tracks.** Unlike a manual, one-track-per-session cadence (`roadmap`'s own caution is about *human* review bandwidth, not subagent throughput), this skill exists precisely to remove that bottleneck.
  Run every track in the current frontier concurrently per step 4, worktree-isolated, and grow the frontier the moment a track lands.
  Only `plan` and a track's own design-then-implement order stay strictly sequential.
  Everything else the DAG does not force, run at once.
- **Commit/push only ever run at the levels step 1 set, and issue filing is never autonomous.** No dial is offered for filing or closing tracker issues (default: GitHub issues, and workflow-config may name another tracker).
  Always prepare and propose those, regardless of the commit/push dials.
- **A subagent's "fresh" requirement is real, not ceremonial.** Never reuse an `implement` subagent across tracks, and never let a `design` subagent's context leak into its track's `implement` subagent.
  That independence is what makes `implement`'s validation pass a fair check, per `implement`'s own rationale.

## Gate

This skill has no gate of its own.
It ends when the DAG is exhausted (all tracks `done`, initiative graduated and `shipped` per `implement`'s last-track gate) or when the user stops the chain.
Every gate inside it belongs to the phase that defines it, unaffected by the autonomy contract.
