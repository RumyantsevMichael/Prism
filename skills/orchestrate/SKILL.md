---
name: orchestrate
description: "Run an initiative through plan, design, and implementation in fresh child-agent contexts. Use for multi-track work with all human gates active."
disable-model-invocation: true
argument-hint: '[initiative]'
---

# Orchestrate an initiative

This is **orchestration**: the same `plan` → `design` → `implement` flow the `workflow` overview skill defines.
You run it as a chain of **child-agent contexts** when the host provides them.

Project settings for this workflow live in `.prism/workflow.md` at the project root (created by the `workflow-init` skill).
Read it first if it exists.
It overrides the default paths and stack assumptions below.
If absent, use the defaults and the project instructions that apply to this task.
The context map and lifecycle rules live in the `workflow` overview skill.

It is the **one exception** to "one workflow skill per context" because it chains the other skills.
It never authors an ADR, plan, contract, or line of code itself.
Every artifact still comes from a `plan`, `design`, or `implement` worker running that skill in its own genuinely fresh context.
Orchestration replaces manual context switching only.
It does not relax a single gate, validation pass, or freshness requirement those skills already impose.

Run this **inline with the user**.
You are the orchestrator, not a worker, and you never resolve a *content* question on the user's behalf yourself.
The child agents resolve content where it is theirs to do, within the limits step 1 sets.
Delegate reading, drafting, and building to child agents when the host provides them.
Your own context stays just the loop state (which track, which phase, the autonomy contract, and what is pending on the user).

**"Orchestrator, not worker" is about decisions, not motion.**
Starting or resuming a child agent needs no permission when no decision is open.
The whole point of this skill is to remove manual context switching.
Re-introducing a "may I continue?" prompt at every step recreates the toil it exists to remove.
The only stops are an escalated question, a required terminal Gate, or an unfinished track.
Outside those three, keep moving without asking.
When one stop occurs, deliver it per **"How to deliver the question"** in the `workflow` overview skill.
That delivery is for real forks only, never for the motion above.

## 1. Set this run's autonomy contract

Before touching the initiative, ask the user to set the three dials below **for this run only**.
This is a per-run opt-in and does not change defaults for another task.

- **Decision autonomy**: how much a `plan` or `design` child agent may resolve without escalating:
  - **Conservative** (default): resolve only what Approved requirements, existing ADRs, the glossary, strategy, or settled initiative artifacts answer.
    Cite the source.
    Escalate any new tradeoff, scope cut, or conflict between settled docs (the `workflow` overview skill's conflict rule).
  - **Broad**: also resolve a tradeoff or scope call itself when confident it fits the initiative's already-settled direction, and report what it decided (and why) instead of blocking on it.
    Still hard-escalates anything that needs a requirement change or new ADR, anything outside its track, and any durable-document conflict.

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
  - **Auto** (default): run every eligible track concurrently only when the host provides isolated workspaces.
    Without isolated workspaces, run eligible tracks sequentially and start each next eligible track without another prompt.
  - **Stepwise**: run one chain at a time and ask before starting the next, even when the DAG would allow more.
    Pick this only when the user wants tighter checkpointing than the dials above already give them.

State the levels and detected execution mode before starting work.
Carry the levels through every child agent this run.
If the user changes a dial mid-run, it applies from that point forward, not retroactively.

Detect one execution mode from the host capabilities:

- **Parallel mode:** child agents and isolated workspaces are available.
- **Sequential mode:** child agents are available, but isolated workspaces are not.
- **Manual mode:** child agents are unavailable.

In manual mode, present the next skill target and artifact paths as a handoff for a fresh user-started task.
Resume orchestration when the user returns with that task's result.

## 2. Resolve the initiative

- `<plans dir>/<initiative>/plan.md` exists (plans dir default `docs/plans/`) → multi-track.
  Read the spine's Mermaid DAG for track order and status.
  Go to step 4.
- No plan, and the work is genuinely multi-track → go to step 3.
- No plan, single self-contained feature → it is its own one-track chain.
  Go to step 4 treating the feature itself as the only "track" (no plan phase, no DAG, and `design` and `implement` both already handle a standalone feature this way).

## 3. Plan phase (only when no plan exists)

Start a child agent named `plan-<initiative>` and instruct it to run `plan` for this initiative.
Give it an execution profile in the format that the `workflow` overview skill defines.
In manual mode, present the same instruction and artifact paths as a fresh-task handoff instead.
There is no upstream recommendation to inherit here.
Instruct it explicitly, at the decision-autonomy level set in step 1:

> Resolve anything answerable from Approved requirements, existing ADRs, the glossary, the product strategy document, or settled initiative artifacts yourself.
> Cite what you used and keep going, because that is applying settled context, not making a new decision.
> [Conservative: stop and return anything beyond that.]
> [Broad: also resolve a tradeoff or scope call yourself when you are confident it fits the initiative's already-settled direction, and report what you decided and why instead of blocking.]
> Stop and return only what is genuinely undecided, with the context needed to answer it.
> This includes a new tradeoff at conservative autonomy, a requirement change, a new ADR, work outside the initiative, or a durable-document conflict.
> Do not guess past those.

Run the **phase loop** below until the phase reports reaching its Gate.
Present the plan (tracks, DAG, release-readiness checklist) to the user yourself, plainly.
This is `plan`'s own hard gate, not yours to wave through.
Proceed only once they accept.

## 4. Track chains, run frontier-parallel

The **frontier** is every not-yet-`done` track whose dependencies are all `done`, read straight off the spine's DAG and status classes.
The DAG can branch, so the frontier often holds more than one track at once: exploit that parallelism, never by preference (ordering within a dependency chain is still `plan`'s own rule, unchanged here, and only tracks with **no** dependency edge between them run concurrently).

In parallel mode with **Track continuation: Auto**, run every frontier track concurrently through its own named child-agent chain.
In sequential mode, run one frontier track at a time and start the next eligible track without asking.
The moment any track reaches `done`, recompute the frontier because its dependents may now be eligible.
In parallel mode, start those chains without waiting for unrelated active chains.
In sequential mode, add them to the eligible queue.
At **Stepwise**, run one chain at a time and ask before starting the next, even if the frontier holds more than one track.

In parallel mode, you will often hold several child agents open at once.
The orchestrator loop does not change.
Broker whichever child agent returns a question or reaches a gate next.
Never block one track's chain on another unless the DAG forces it.

**Two correctness hazards parallel chains introduce, both yours to manage:**

- **Workspace isolation.**
  When multiple chains are active, give each design and implementation child agent an isolated workspace.
  Concurrent chains writing to the same working tree (code, contracts, even two `<track>.md` files at once) will otherwise collide.
  A single chain running alone needs no isolation.
  Isolation cuts collisions but also **visibility**, so you own integration at each boundary.
  When the user accepts `design-<track>`'s gate, integrate its workspace into the main workspace before starting `implement-<track>`.
  The implementation child agent reads the prep bundle from the main tree, never from a sibling workspace.
  Integrate a track's implementation at the 4c gate after the user's correctness confirmation.
  Use the host's isolated-workspace integration capability.
  A host adapter can implement this capability with Git worktrees.
  Integrate one track at a time.
  If integration conflicts with landed work, reapply mechanical changes and show the remaining conflicts to the user.
  Never silently drop either side.
- **The spine `plan.md` is shared state every concurrent chain wants to edit** (each track's own status flip: `design` marks itself started, `implement` marks itself done).
  Two child agents can race when they update different nodes in the shared spine.
  After any child agent reports a status change, re-read the live spine and confirm its node matches the report.
  If a concurrent write clobbered it, reapply the missing one-line edit yourself immediately.
  This is a mechanical repair, not a new judgment call.
  Derive a track status only from that track's child-agent report.

Within-skill parallelism already happens inside `design` and `plan` when the host supports it.

### 4a. Design

Start a child agent named `design-<track>` and instruct it to run `design` for `<initiative>/<track>`.
Give it the decision-autonomy instruction and an execution profile.
In manual mode, present the same instruction and artifact paths as a fresh-task handoff instead.
Run the phase loop until it reaches its Gate with artifacts presented and the right-size check stated.

Present the artifacts and the right-size check to the user yourself.
**Wait for explicit acceptance.**
`design`'s gate is not yours to wave through at any autonomy level.
Note the execution profile that its handoff recommends for implementation.
Carry it forward verbatim in 4b rather than guessing fresh.

### 4b. Implement

On acceptance, start a **new** child agent named `implement-<track>` with no design conversation history.
Instruct it to run `implement` for the same track with the handoff's execution profile.
In manual mode, present the same instruction and handoff path for a fresh user-started task.
Same autonomy-scoped stop-and-return instruction for `// OPEN:` seam confirmations and anything else `implement` calls out as needing the user.

**Specification gaps route to their owning workflow, never to you or implementation itself.**
If implementation reports a requirement gap, route it to `write-requirements` for user approval.
If implementation reports a design gap, resume `design-<track>` with the gap.
Once design confirms the fix, resume `implement-<track>`.
If either child task cannot resume, start a replacement from the on-disk artifacts.
The artifacts on disk are the authority either way, so a cold read recovers the same context.

Run the phase loop until `implement` reaches its Gate.

### 4c. Track gate

Relay the gate's **gated vs. unfinished** classification exactly as the child agent stated it.
Do not soften, relabel, or decide a re-scope yourself, at any autonomy level.
Sizing and scope calls belong to the user here exactly as in a manual session.

- **Unfinished work remains** → stop the chain for this track.
  Surface it plainly and wait, and do not auto-respawn or auto-rescope.
- **Track lands clean** → get the user's explicit correctness confirmation, which always happens, regardless of the commit dial.
  Then:
  - **Commit off** (default) → prepare the commit message and propose it, but never run it.
  - **Commit on** → prepare the message and run the commit yourself.
    If **push** is also on, push it.
    Otherwise stop after the local commit and say so.

Then apply the **track continuation** dial from step 1.
**Auto** → recompute the frontier without a prompt.
In parallel mode, start every eligible chain.
In sequential mode, start the next eligible chain.
**Stepwise** → ask before starting the next one.
Either way, say plainly what landed and what is next so the user can interrupt at will.
Silence is not the goal, and asking permission for routine motion is what to avoid.

Continue until the DAG is exhausted (every track `done`) or the user stops you.

Update the roadmap as the initiative's status changes.

---

## The phase loop

Use this loop for every child-agent phase:

1. Start or resume the child agent with the relevant skill and autonomy-scoped instruction from step 1.
2. Read what it returns.
   - **A question for the user** → relay it in plain language, not the child agent's internal vocabulary.
     Get their answer.
     Resume or message the child agent with that answer through the host's supported mechanism.
     Go to 2.
   - **It reached its skill's Gate** → stop looping.
     That gate's acceptance is the user's call, handled in the calling step above.

In manual mode, replace each child-agent action with this result path:

1. Present the skill, execution profile, and artifact paths as a fresh-task handoff.
2. Wait for the user to relay the fresh task's result.
3. If the result contains a question, broker the answer and issue a new fresh-task handoff with that answer.
4. If the result reports a specification gap, issue a new handoff to the owning design phase.
5. After design updates the artifacts, issue a new implementation handoff from the on-disk artifacts.
6. Stop only when the relayed result reaches the phase Gate or reports unfinished work.

## Conventions

- **Default to motion.**
  Outside the three named stop conditions, do not pause to check in.
  Start the next child agent, resume one with an answer, and start every track the frontier just made eligible.
  If you notice yourself about to ask "should I proceed?" with no real decision attached, that is the failure mode this skill exists to avoid.
- **The autonomy contract is set once and applies uniformly.**
  Do not let a child agent or track silently use another level.
  If the work seems to call for more or less autonomy mid-run, ask the user to change the dial rather than deciding it yourself.
- **Resolve from documentation, escalate per the chosen level.**
  Even at *broad*, a child agent never changes an Approved requirement or creates an ADR-level decision itself.
  Those actions always escalate.
  You relay what crosses that line and never resolve it yourself, even when the answer seems obvious to you.
  You do not have the child agent's depth of reading on this track.
- **Every hard gate from `plan`/`design`/`implement` still applies at each autonomy level.**
  This skill adds an orchestrator and an optional commit or push actor.
  It never bypasses plan acceptance, the design size check, or implementation correctness confirmation.
- **Spikes need no separate handling.**
  Ordering spikes belong to `plan`, and track-feasibility spikes belong to `design`.
  Each already runs its own inline, exactly as their skills specify.
  Do not lift spike-running into this skill.
- **Use the safest available concurrency.**
  Run the frontier concurrently only in parallel mode.
  In sequential mode, run one eligible track at a time and continue without a new prompt.
  Only `plan` and a track's own design-then-implement order stay strictly sequential.
  In parallel mode, run work concurrently when the DAG permits it.
- **Commit and push only run at the levels that step 1 sets.**
  Issue filing is never autonomous.
  No dial controls filing or closing tracker issues.
  Always prepare and propose those, regardless of the commit/push dials.
- **A child agent's "fresh" requirement is real, not ceremonial.**
  Never reuse an implementation context across tracks.
  Never let a design conversation leak into its track's implementation context.
  That independence makes the implementation cold read a fair check.

## Gate

This skill has no gate of its own.
It ends when the DAG is exhausted (all tracks `done`, initiative graduated and `shipped` per `implement`'s last-track gate) or when the user stops the chain.
Every gate inside it belongs to the phase that defines it, unaffected by the autonomy contract.
