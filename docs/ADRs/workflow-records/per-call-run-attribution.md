# Attribute run cost per Prism call and delimit runs from observed events

Status: Proposed
Created: 2026-10-22

## Requirements

[Report the run measures](../../requirements/run-statistics.md#3) requires separate time, token, and tool-call measures.
[Exclude idle gaps from active time](../../requirements/run-statistics.md#5) requires a fixed idle threshold.
[Attribute cost at each Prism call](../../requirements/run-statistics.md#6) requires per-call target and role attribution.
[Inherit attribution into a subagent](../../requirements/run-statistics.md#7) requires subagent inheritance before its first Prism call.
[Mark interleaved slice attribution as approximate](../../requirements/run-statistics.md#8) requires approximation marks for parallel slices.
[Report unattributed cost](../../requirements/run-statistics.md#9) requires an unattributed session bucket.
[Record one immutable record per finished run](../../requirements/run-statistics.md#10) requires a defined run end.
[Record unfinished runs later](../../requirements/run-statistics.md#13) requires a rule for runs without an observed end.
[Limit Codex attribution to provable totals](../../requirements/run-statistics.md#14) requires partial attribution below the Codex session.
[Report elapsed and summed active time for aggregates](../../requirements/run-statistics.md#19) requires mergeable active intervals.

## Problem

Coordinators reuse reviewer identities across waves, and one actor can both coordinate and deliver, so an actor identifier cannot bind cost to a wave or slice.
Only `update_review` carries an explicit caller role, while other Prism calls name a target without a role.
Hosts observe execution ends differently, Codex exposes no session end, and crashed sessions never end.
A design run has no identifier of its own in Prism records.

## Decision

An execution MUST be a host root session or a host subagent, identified locally by the session and the host's subagent identifier.
A run MUST be the part of one execution from its first observed event, or from the end of its previous run, until its end.
A run MUST end at an observed host end event for that execution: session end for a root session, or subagent stop for a subagent.
A run without an observed end MUST count as ended when its last observed event is more than 30 minutes old and no tool call of that execution is running, or more than 24 hours old regardless.
Events observed after a run ended MUST start a new run of the same execution.
A Prism call MUST name a target when its arguments identify an initiative, alone or with a slice.
A call that names only an initiative MUST target the root slice of that initiative's record.
At each call that names a target, Prism MUST read the shared review ledger and coordination state for that slice as they are at that moment.
While the slice's latest review wave is unaccepted, a call by the `reviewer` or `coordinator` role that names the slice MUST target that wave, and the wave identifier MUST come from the review ledger.
Otherwise, while the slice's active coordination entry has the `design` activity, the target MUST be the design run numbered one more than the count of design-audit waves already started for that slice.
Otherwise the target MUST be the slice.
The caller's role MUST be the explicit actor role when the call carries one.
Without an explicit role, the role MUST be the role that the same execution explicitly declares for the same slice, in the same run or an earlier run of that execution.
Without any declaration, a root session MUST hold the `coordinator` role and a subagent MUST hold the `delivery` role, and that attribution MUST be marked `approximate`.
Prism MUST NOT bind an execution to a wave or slice by actor identifier.
An execution's usage, time, and tool calls from one target-naming call until its next target-naming call MUST belong to that call's target and role, continuing across the ends of that execution's runs.
A subagent's cost before its own first target-naming call MUST belong to the target and role current in the starting execution when it started.
When an execution names a slice while a different slice it named earlier still has an active coordination entry, attribution of that execution's cost to either slice in that run or a later run of that execution MUST be marked `approximate`.
Cost that no call or subagent start attributes MUST stay in the session's local unattributed total and MUST NOT be distributed to targets.
Active time MUST count every interval between consecutive observed events of an execution, except an interval longer than five minutes during which no tool call of that execution was running.
The five-minute threshold MUST be reported with active time.
A run record MUST keep its merged active intervals so that reads can report elapsed active time, counting overlaps once, and summed agent active time.
Codex usage, time, and tool calls MUST be recorded as session totals, and attribution below the session MUST be marked `partial` because Codex subagents share the root session identifier.
A Codex session total MUST combine every thread of the session, summing each thread's latest cumulative usage and counting tool calls across threads.
Each statistic MUST carry the lowest coverage of its inputs, ordered `exact`, `approximate`, `partial`, `unavailable`, and an unobserved measure MUST be `unavailable` rather than zero.

## Rationale

The target and role current at each call are the only facts that identify what the cost served when identities are reused.
Reading the shared ledger and coordination state at the call makes the wave and design-run boundaries agree across sessions and users.
Counting design-audit waves numbers design runs from shared facts without a new identifier or a skill change.
The explicit role in review updates is reliable, and an execution's own declaration covers its unlabelled calls without binding identities across waves.
A quiet-period end keeps crashed and Codex sessions measurable, and splitting a resumed execution into another run loses nothing because totals are summed on read.
Carrying a call's target and role across run ends keeps each run's record consistent with the session's own attribution, since a run end delimits records and does not change what the execution is working on.
Storing merged active intervals is the only way to count overlapping parallel work once at read time.

## Alternatives

### Bind workers to waves by actor identifier

Declined because coordinators reuse reviewer identities across waves.

### Add a role or target argument to Prism calls

Declined because it needs skill changes, which the requirements exclude.

### Spread unattributed cost across targets

Declined because it would misstate where effort went.

### End an unobserved run only at the next session start

Declined because a long-running Codex session would never record its runs.

### Store only summed active time

Declined because elapsed active time across parallel executions cannot be derived from sums.

## Consequences

Coordinator cost becomes visible per wave, design run, and slice.
Delivery and reviewer roles without an explicit declaration are approximate.
A session resumed after a 30-minute quiet period records several runs for one execution.
Codex statistics below the session are always `partial`.
Run records grow with the number of active intervals, so a run with very many intervals coalesces them and marks elapsed time `approximate`.

## Mechanism

The trace hook records each Prism call's target identifiers and explicit role, each subagent start with its starting execution, tool-call starts and ends, and execution ends.
Finalization replays one run's events, assigns each interval and model message to the current target and role, applies coverage marks, and builds one record per attributed slice for [shared run records](shared-run-records.md).
The run lifecycle and attribution order are shown in [run-record-lifecycle.puml](run-record-lifecycle.puml).

## Decision Log

2026-10-22: Proposed during run-statistics design.
2026-10-22: Design audit of run-measures defined the Codex session total as the sum over the session's threads.
2026-10-23: Design audit of run-records continued a call's target, role declaration, and interleaving across run ends of the same execution until its next target-naming call, matching the requirement that cost belongs to a call's target until the next such call.
2026-11-02: Ported onto managed records: targets come from `initiative` and `slice` arguments, and facts are read from `.prism`, or from the older plans location until a write moves them.
