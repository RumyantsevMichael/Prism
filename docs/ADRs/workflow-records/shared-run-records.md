# Keep traces local and share only finished content-free run records

Status: Proposed
Created: 2026-10-22

## Requirements

[Collect run statistics by default](../../requirements/run-statistics.md#1) requires collection whenever Prism hooks are installed.
[Switch run statistics off](../../requirements/run-statistics.md#2) requires a project-level off switch that keeps existing records readable.
[Count each model message once](../../requirements/run-statistics.md#4) requires per-message usage from host transcripts.
[Record one immutable record per finished run](../../requirements/run-statistics.md#10) requires append-only shared run records.
[Report totals through existing reads](../../requirements/run-statistics.md#11) requires totals computed from records at read time.
[Report coverage instead of misleading zeros](../../requirements/run-statistics.md#12) requires coverage marks on every statistic.
[Record unfinished runs later](../../requirements/run-statistics.md#13) requires recovery of runs without an observed end.
[Limit Codex attribution to provable totals](../../requirements/run-statistics.md#14) requires session-level Codex totals.
[Store only content-free counts](../../requirements/run-statistics.md#15) requires an allowlisted record shape.
[Keep run records after initiative cleanup](../../requirements/run-statistics.md#16) requires storage outside the scratch plans folder.
[Never block the host action](../../requirements/run-statistics.md#18) requires failure isolation.

## Problem

[Use same-session facts and privacy-bounded local traces](../repository-intelligence/same-session-facts-and-local-tracing.md) requires session tracing to remain local and limits transcript reads to bounded metadata.
Run statistics must leave the machine as shared project records so that collaborators see the same totals.
Accurate token counts need per-message usage that only host transcripts expose, and the trace currently excludes subagent executions.
Coordination files are scratch and are deleted when an initiative ships, so they cannot hold statistics.
A separate effort is designing a shared record store with an append-only seam, and run statistics must not depend on its internals.

## Decision

This ADR amends [Use same-session facts and privacy-bounded local traces](../repository-intelligence/same-session-facts-and-local-tracing.md) as follows, and that ADR's other invariants remain in force.
Raw trace events, transcript reads, and in-progress run state MUST remain local to the plugin data directory.
Only finished run records MAY leave local storage, and only into the project's own shared Prism records.
Prism MUST NOT send traces, run records, or statistics to any service outside the project's own records.
Session tracing MUST be enabled whenever Prism's hooks are installed, unless the project's workflow configuration switches run statistics off.
When run statistics are switched off, Prism MUST NOT trace executions for run statistics and MUST NOT write run records, and existing run records MUST remain readable.
The trace MUST observe subagent executions as separate executions for run statistics, keyed by the host's subagent identifier, while subagent events remain excluded from root pre-edit summaries.
Run-statistics events and gaps MUST be stored apart from the root session trace that pre-edit summaries read, so they never change pre-edit coverage, reason codes, or trace limits.
A Claude Code transcript MAY be read only for per-message usage counts, message timestamps, and message identifiers of the main session and its subagent transcripts.
A Codex transcript MAY be read only for its bounded first `session_meta` record and the latest bounded `token_count` record.
Transcript reads MUST be bounded in bytes and in time within the hook timeout, MUST happen in memory, and MUST persist only counts, timestamps, and message identifier digests.
A read cut short by either bound MUST lower the affected token measures below `exact` instead of reporting the last complete totals as exact.
An unrecognized transcript format MUST yield `unavailable` coverage for the affected token measures instead of zero.
Token usage MUST be counted once per model message identifier, regardless of how many transcript records repeat it.
Prism MUST write run records only through `appendRecord(projectRoot, {kind: "runs", initiative, slice}, id, entry)`, MUST read them back only through `listRecordEntries(projectRoot, key)`, which returns `[{id, entry}]` in id order, and MUST compute totals from those records at read time.
The run record key MUST be `slice/<initiative>/<slice>/runs/<run-id>`, with one record for each slice a run's cost is attributed to.
The record store keeps each key at `.prism/initiatives/<initiative>/slices/<slice>/runs/<run-id>.json`, where every slice, including the root slice, has a folder under `slices/` keyed by its slug, and writes each record by temporary file and rename.
A run record MUST be immutable, and an append to an existing key MUST leave the existing record unchanged.
A run record MUST contain only counts, durations, timestamps, coverage marks, host, model, role, random run and session-group identifiers, and Prism target identifiers.
A run record MUST NOT contain prompts, source text, command text, model responses, transcript content, transcript paths, raw host session identifiers, session correlation keys, user names, or machine names.
Run record storage MUST be independent of the initiative plans folder, so that coordination cleanup leaves run records readable.
Prism MUST NOT expose the run record storage layout to skills or MCP callers.
Every run MUST have a random run identifier created locally when the run starts, so that repeated finalization of the same run appends the same keys.
A run record MUST be appended to the project whose shared records the attributing Prism call read its target facts from, because a slice identifier is meaningful only within that project.
The local trace MAY keep that project's canonical root for this purpose, and a run record MUST NOT contain it.
Before appending a record to a project, Prism MUST read that project's run statistics switch, and a switched-off project MUST receive no record.
A recorded run MUST be sealed in the local trace, so later events of its execution start a new run, and an event that would fall inside a sealed run MUST be refused and recorded as a loss instead of being dropped silently.
Once a run-statistics trace reaches its own size limit, the trace store MUST refuse every later event to that trace, so nothing lands inside a run that limit sealed, and each refused event is recorded as a loss, while the root session trace that pre-edit summaries read keeps its own limit behavior and still accepts a later event that fits.
A closed run whose trace has reached its own size limit is sealed by that limit, so it MUST be recorded once with every measure at most `partial`, and its session MUST then stop being pending.
The finalizer and pending-marker clearing MUST decide this by the same predicate, the trace's own persisted limit flag, so a seal refused because the shared trace directory is full leaves the run pending and writes no record.
Each session with an unrecorded run MUST have a local, content-free pending marker whose age is the age of the session's last observed event, so that recovery finds quiet sessions without reading every trace.
Finalization MUST remove a session's pending marker only after every closed run of that session is recorded or skipped by a switched-off destination, and only through a claim that later recovery treats as pending, so that a finalizer killed at any point and an append concurrent with the removal both leave the session recoverable.
Every wait in hook finalization MUST end within the hook time limit, and because `appendRecord` takes no deadline, the finalizer MUST NOT call it while the entry's lock is younger than the lock's stale age, leaving that run pending instead.
Source snapshots MUST NOT count Prism-managed record files under `.prism/initiatives/`, including their locks and temporary files, so that a record appended during a review never makes the review's source stale.
Only transient lock and temporary files MAY be git-ignored through `.prism/.gitignore`, and run records MUST NOT be, so that committed records stay shareable.
Recovery MUST NOT end the calling session's own last run by the quiet-period rule, because a session that is calling Prism is still running.
A failure to trace, read a transcript, finalize, or append MUST NOT block the host action and MUST lower the coverage of the affected statistics.
An append that the trace store refuses, including one refused because the trace directory lock stays busy, MUST be recorded as a durable loss that does not depend on that lock, and a read MUST then report the affected execution's measures below `exact` and MUST NOT drop that execution's row.

## Rationale

Separating local raw traces from shared derived records keeps the original privacy boundary for everything that can contain identity or content.
Per-message transcript usage is the only host source that counts each model call once and separates the token categories.
The existing Codex capacity resolution already reads the latest `token_count` record, so session token totals add no new transcript surface.
Immutable keyed records let several users and sessions record concurrently without write conflicts, and totals computed on read cannot drift.
An append seam keeps collection and reads independent of where the record store keeps records.
Default-on collection is the only way to measure without manual work, and records hold no person.

## Alternatives

### Keep statistics local only

Declined because collaborators could not see where a project's effort went.

### Store statistics in coordination state or the initiative record

Declined because coordination files are deleted at cleanup and a mutable shared document serializes every writer behind one revision.

### Sum the host tool result's token figure

Declined because it reports only the last message's context size and counts the conversation instead of the work.

### Record every run in the project where the host session started

Declined because a session that starts in one checkout and works on an initiative in another working tree would write records beside no initiative and outside the branch that carries the work.

### Scan every local trace at each recovery

Declined because the trace directory holds every project's traces up to its size limit, which a hook cannot read within its time limit.

### Upload statistics to a hosted service

Declined because the user ruled out any destination outside the project's own records.

### Opt-in collection

Declined because opt-in statistics are rarely enabled, and the requirement is collection by default.

## Consequences

Collaborators see the same totals once records reach the shared project records.
The Claude Code transcript format is an undocumented host detail, so a host update can make token measures `unavailable` until Prism recognizes the new format.
Codex token totals exist only per session, and Codex has no cache-write category, so that measure is `unavailable` on Codex.
Run records accumulate without retention because shipped initiatives must stay measurable.
The record store writes records into the working tree, so records are shared only when the project shares that tree.
Hooks do more work at execution end, and finalization that exceeds the hook time limit moves to the next Prism run in the project.
A run whose record entry is locked by another writer waits for a later Prism run, and one killed by its host leaves its lock for up to 30 seconds.
Edits under `.prism/initiatives/` are never reviewed as source, because only Prism writes there.
The local trace holds the canonical root of each project a Prism call named, which it did not hold before.
A run whose trace is evicted by local retention before recovery is never recorded.

## Mechanism

Hooks append content-free events for every root and subagent execution to the local trace, including Prism calls with their target identifiers and caller role.
At an observed execution end, the hook finalizes the run: it reads the bounded transcript usage, builds one record per attributed slice, and appends each through the seam.
When a run ends without an observed end or finalization fails, the next Prism hook or MCP read in the project finalizes it from the local trace, following [Attribute run cost per Prism call](per-call-run-attribution.md).
Reads list the records under a slice, initiative, or session group and aggregate them on demand.
The lifecycle is shown in [run-record-lifecycle.puml](run-record-lifecycle.puml).

## Decision Log

2026-10-22: Proposed during run-statistics design.
2026-10-22: Design audit of run-measures added the separate run-statistics trace and the time bound on transcript reads.
2026-10-22: The user set the local adapter layout to `.prism/initiatives/<initiative>/slices/<slice>/runs/<run-id>.json`, written by temporary file and rename, behind one adapter module exposing `append`, `list`, and `read`.
2026-10-22: Implementation review of run-measures added the lock-independent loss record for refused appends.
2026-10-22: The user named the record store PR #47 seam, `appendRecord` and `listRecordEntries`, and required the local adapter to mirror those exact signatures.
2026-10-23: Design of run-records settled the record destination project, run sealing, the pending marker, and the calling session's open run.
2026-10-23: Design audit of run-records excluded managed record files from source snapshots as PR #47 does, git-ignored only their locks and temporary files, made pending-marker removal crash-safe through a claim, and bounded the record lock wait in the caller.
2026-10-23: Implementation review of run-records sealed a closed run in a full trace by its limit.
2026-10-23: Design audit of run-records made a full trace refuse every later event and keyed limit sealing on the trace's own limit flag alone, excluding a full shared directory.
2026-10-23: Design re-audit of run-records scoped that refusal to run-statistics traces, so the root pre-edit trace keeps its limit behavior.
2026-11-02: The temporary local adapter was replaced by the merged record store in `src/server/workflow/record-store.mjs`.
