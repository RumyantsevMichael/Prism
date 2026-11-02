# Run statistics

Status: Approved
Created: 2026-10-22
Approved: 2026-10-22

## Problem

Prism users cannot see how much wall time, active time, tokens, and tool calls each review wave, design run, slice, and initiative consumes.
A manual measuring pass on the session-store-safety slice found that the coordinator session used about four times the tokens of all review workers together, so leaving coordinator cost unattributed hides most of the effort.
Host tool results report only the last message's context size, first-to-last timestamps include idle gaps of days, and coordinators reuse reviewer identities across waves, so the obvious measurements are wrong.
Shared per-project collaboration is planned, so statistics kept only on one user's machine cannot answer where a project's effort went.

## Goals

- Measure wall time, active time, input, cache-write, cache-read, and output tokens, and tool calls for every Prism run without manual work.
- Attribute coordinator, delivery, design, and review cost to the wave, design run, slice, and initiative that the cost served.
- Keep the statistics with the project's other Prism records so collaborators see the same totals.
- Report the statistics through the existing review, initiative, and session consumption reads and the review browser.

## Non-goals

- Store prompts, source text, command text, model responses, transcripts, transcript paths, or the identity of a person.
- Upload statistics to any service outside the project's own records.
- Convert tokens to money.
- Backfill statistics for runs that finished before this capability.
- Attribute Codex subagent cost separately from its root session.
- Track cost of sessions that never name an initiative, such as ideation or roadmap work, beyond the session's unattributed total.
- Add MCP tools or change any skill.

## Design questions

- How a host execution's end is observed on each supported host, and when an execution without an observed end counts as ended.
- How a design run is delimited from other delivery work on the same slice.
- How the existing local-tracing ADR is amended to separate local traces from shared derived run records.

<a id="1"></a>
## 1. Collect run statistics by default

Pattern: Optional feature

Disposition: Active

Requirement: Where Prism host hooks are installed and the project's workflow configuration does not switch run statistics off, Prism shall collect run statistics for every host session and subagent execution that works in the project.

Rationale: Opt-in statistics are rarely enabled, and the first goal is to measure, while records hold only counts and no person.

Related: [run-statistics.md§2](#2), [run-statistics.md§14](#14)

<a id="2"></a>
## 2. Switch run statistics off

Pattern: Optional feature

Disposition: Active

Requirement: Where the project's workflow configuration switches run statistics off, Prism shall neither collect run statistics nor write run records for that project, while keeping existing run records readable.

Rationale: A project must be able to stop sharing statistics without losing what was already recorded.

Related: [run-statistics.md§1](#1)

<a id="3"></a>
## 3. Report the run measures

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall report wall time, active time, input tokens, cache-write tokens, cache-read tokens, output tokens, and tool calls as separate measures for each run and each reported aggregate.

Rationale: Token categories have different cost and context effects, and time and tool calls show effort that tokens alone hide.

Related: [run-statistics.md§4](#4), [run-statistics.md§5](#5), [run-statistics.md§11](#11)

<a id="4"></a>
## 4. Count each model message once

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall count the token usage of each host model message exactly once, regardless of how many host records or observations contain that message.

Rationale: Host transcripts repeat a message's usage across records, and summing a tool result's context size counts the conversation instead of the work.

Related: [run-statistics.md§3](#3)

<a id="5"></a>
## 5. Exclude idle gaps from active time

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall count as active time every interval between consecutive observed events of an execution, except an interval longer than five minutes during which no tool call of that execution was running, and shall report that five-minute threshold with the measure.

Rationale: First-to-last timestamps include idle gaps of days, while a long test run is work rather than idleness.

Related: [run-statistics.md§3](#3), [run-statistics.md§12](#12), [run-statistics.md§19](#19)

<a id="6"></a>
## 6. Attribute cost at each Prism call

Pattern: Event-driven

Disposition: Active

Requirement: When an execution makes a Prism call that names an initiative, slice, design run, or review wave, Prism shall attribute that execution's usage, time, and tool calls from that call until its next such call to the named target and to the role that the calling actor holds for that target at that moment.

Rationale: Coordinators reuse reviewer identities across waves and one actor can coordinate and deliver, so only the target and role current at each call identify what the cost served.

Related: [run-statistics.md§7](#7), [run-statistics.md§8](#8), [run-statistics.md§9](#9)

<a id="7"></a>
## 7. Inherit attribution into a subagent

Pattern: Event-driven

Disposition: Active

Requirement: When an execution starts a subagent, Prism shall attribute the subagent's usage, time, and tool calls before its own first Prism call to the target and role current in the starting execution.

Rationale: A review or delivery worker reads and reasons before its first Prism call, and that cost serves the slice it was started for.

Related: [run-statistics.md§6](#6), [run-statistics.md§8](#8)

<a id="8"></a>
## 8. Mark interleaved slice attribution as approximate

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an execution makes a Prism call naming a slice while a different slice it named earlier still has active work in coordination state, then Prism shall mark the attribution of that execution's cost to either slice as approximate.

Rationale: A coordinator working on parallel slices spends cost between calls that the latest call's slice only approximates.

Related: [run-statistics.md§6](#6), [run-statistics.md§12](#12)

<a id="9"></a>
## 9. Report unattributed cost

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall report each session's cost that no Prism call or subagent start attributes to a target as that session's unattributed cost, without dropping it or distributing it to targets.

Rationale: Silently dropping or spreading unbound cost would misstate where effort went.

Related: [run-statistics.md§6](#6), [run-statistics.md§7](#7)

<a id="10"></a>
## 10. Record one immutable record per finished run

Pattern: Event-driven

Disposition: Active

Requirement: When a run ends, Prism shall add one immutable run record to the project's shared Prism records for each slice its cost is attributed to, without changing any existing run record.

Rationale: Immutable per-run records let several users and sessions record concurrently without conflicting writes.

Related: [run-statistics.md§11](#11), [run-statistics.md§13](#13), [run-statistics.md§15](#15), [run-statistics.md§16](#16)

<a id="11"></a>
## 11. Report totals through existing reads

Pattern: Event-driven

Disposition: Active

Requirement: When a caller reads a review, an initiative, or a session consumption summary through Prism, Prism shall return run statistics totals computed from the run records at read time for each review wave, design run, slice, split parent including its descendants, initiative, and session that the read covers.

Rationale: Totals computed on read cannot drift from the records, and existing reads keep skills free of storage details.

Related: [run-statistics.md§3](#3), [run-statistics.md§10](#10), [run-statistics.md§12](#12), [run-statistics.md§17](#17)

<a id="12"></a>
## 12. Report coverage instead of misleading zeros

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall mark each reported run statistic as `exact`, `approximate`, `partial`, or `unavailable`, and shall report a measure it could not observe as `unavailable` instead of zero.

Rationale: Host transcript formats are undocumented and can change, so a missing measurement must stay visible.

Related: [run-statistics.md§8](#8), [run-statistics.md§13](#13), [run-statistics.md§14](#14), [session-consumption-tracing.md§3](session-consumption-tracing.md#3)

<a id="13"></a>
## 13. Record unfinished runs later

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an execution ends without Prism recording its run, then Prism shall record that run from its observed events the next time Prism runs in that project, and until then shall report its observed counts as in progress, separately from recorded totals.

Rationale: Crashed or abandoned sessions still consumed effort that the statistics must not lose.

Related: [run-statistics.md§10](#10), [run-statistics.md§12](#12)

<a id="14"></a>
## 14. Limit Codex attribution to provable totals

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Prism cannot separate a Codex subagent's cost from its root session's cost, then Prism shall record the session's totals and shall mark attribution below the session as `partial`.

Rationale: Codex subagents share the root session identifier, so only session totals are provable there.

Related: [run-statistics.md§12](#12), [session-consumption-tracing.md§5](session-consumption-tracing.md#5)

<a id="15"></a>
## 15. Store only content-free counts

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall store in run records only counts, durations, timestamps, coverage marks, host, model, role, run identifiers, and Prism target identifiers.

Rationale: Run records are shared with collaborators, so they must carry no prompts, content, transcript paths, or person identity.

Related: [run-statistics.md§10](#10), [session-consumption-tracing.md§1](session-consumption-tracing.md#1)

<a id="16"></a>
## 16. Keep run records after initiative cleanup

Pattern: Event-driven

Disposition: Active

Requirement: When orchestration removes a shipped initiative's coordination files, Prism shall keep that initiative's run records readable.

Rationale: Seeing what a shipped initiative cost is a main use of the statistics.

Related: [run-statistics.md§10](#10)

<a id="17"></a>
## 17. Show run statistics in the review browser

Pattern: Event-driven

Disposition: Active

Requirement: When the user opens a review wave, slice, or initiative in the review browser, the review browser shall show its run statistics totals and their coverage marks.

Rationale: The user wants to see where Prism spends effort without calling tools.

Related: [run-statistics.md§11](#11), [run-statistics.md§12](#12), [review-finding-provenance.md§1](review-finding-provenance.md#1)

<a id="18"></a>
## 18. Never block the host action

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Prism fails to collect or record run statistics, then Prism shall let the host action continue and shall reduce the coverage mark of the affected statistics.

Rationale: Measurement must not disrupt the work it measures.

Related: [run-statistics.md§12](#12), [session-consumption-tracing.md§4](session-consumption-tracing.md#4)

<a id="19"></a>
## 19. Report elapsed and summed active time for aggregates

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall report each aggregate's active time both as elapsed active time, counting overlapping active intervals of its executions once, and as summed agent active time, adding every execution's active time.

Rationale: Parallel workers make elapsed time and total agent effort diverge, and both answer different questions about where effort went.

Related: [run-statistics.md§3](#3), [run-statistics.md§5](#5), [run-statistics.md§11](#11)
