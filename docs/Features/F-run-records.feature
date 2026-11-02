Feature: Finished runs become immutable shared run records

  Rule: An ended run adds one record for each slice its cost was attributed to
    # Requirement: [Record one immutable record per finished run](../requirements/run-statistics.md#10)
    # ADR: [Keep traces local and share only finished content-free run records](../ADRs/workflow-records/shared-run-records.md)

    Example: A stopped subagent adds one record for each slice it served under the same run identifier
      Given a subagent that inherited a review wave of one slice and then named another slice
      When the subagent stops
      Then each of the two slices has one run record with the same run identifier
      And the first slice's record holds the inherited wave cost under the coordinator role

    Example: An ended session adds its own record beside its subagent's
      Given a root session that worked on a review wave of a slice whose subagent run is already recorded
      When the session ends
      Then that slice has a second run record for the root session's run
      And cost before the session's first Prism call adds no record

    Example: A record goes to the project whose records the Prism call read
      Given a session started in one project that names a slice of another working tree
      When the session ends
      Then the other working tree holds the run record
      And the starting project holds no run record

    Example: A run after a quiet period still serves the slice of the session's earlier Prism call
      Given a session that worked on a slice, went quiet for over 30 minutes, and continued without another Prism call
      When the session ends
      Then that slice has one run record for each of the two runs

  Rule: A run record is never changed after it is added
    # Requirement: [Record one immutable record per finished run](../requirements/run-statistics.md#10)
    # ADR: [Keep traces local and share only finished content-free run records](../ADRs/workflow-records/shared-run-records.md)

    Example: Repeated finalization leaves every record as it was
      Given an ended session whose runs are recorded
      When the end is reported again and session consumption is read
      Then the same records exist with unchanged content

  Rule: A run record holds only content-free counts and identifiers
    # Requirement: [Store only content-free counts](../requirements/run-statistics.md#15)
    # Requirement: [Report coverage instead of misleading zeros](../requirements/run-statistics.md#12)

    Example: A record carries measures with coverage marks and no content or identity
      Given a session whose prompts, commands, responses, and transcript paths contain private text
      When its runs are recorded
      Then every record holds only counts, durations, timestamps, coverage marks, host, role, run identifier, and Prism target identifiers
      And no record contains private text, a project path, a transcript path, or a session identifier

  Rule: A run without an observed end is recorded by a later Prism run in the project and is in progress until then
    # Requirement: [Record unfinished runs later](../requirements/run-statistics.md#13)
    # ADR: [Attribute run cost per Prism call and delimit runs from observed events](../ADRs/workflow-records/per-call-run-attribution.md)

    Example: Another session's next Prism hook records a session that went quiet
      Given a Claude Code session whose last event is two hours old and which never ended
      When another session in the project makes its next hooked call
      Then the quiet session's run is recorded

    Example: A session left claimed by an interrupted finalizer is still recorded
      Given a quiet session whose pending marker an interrupted finalizer claimed while a run was still unrecorded
      When another session in the project makes its next hooked call
      Then the quiet session's run is recorded
      And no claim remains for the quiet session

    Example: A quiet session whose trace is full is recorded once
      Given a quiet session whose run-statistics trace reached its event limit before its run was sealed
      When another session in the project makes its next hooked call and then another
      Then the quiet session's run is recorded once with partial coverage
      And the quiet session is no longer pending

    Example: A late event never lands inside a run its full trace sealed
      Given a quiet session whose run was recorded after its trace reached its limit
      When an earlier event of that run arrives late
      Then the trace refuses the event
      And the recorded run is unchanged

    Example: A full shared trace directory leaves a quiet session pending
      Given a quiet session whose run is unrecorded
      And the shared trace directory is at its size limit
      When another session in the project finalizes quiet sessions
      Then no record is written for the quiet session's run
      And the quiet session is still pending

    Example: A quiet Codex session is recorded with attribution below the session marked partial
      Given a Codex session whose last event is two hours old
      When another session in the project makes its next hooked call
      Then the Codex session's run is recorded with partial attribution
      And its cache-write tokens are unavailable

    Example: The calling session's own run is in progress
      Given a session that is still working on a review wave
      When it reads its session consumption
      Then its observed counts are reported as in progress
      And no record is added for its run

  Rule: A failure to record lets the host continue and lowers coverage
    # Requirement: [Never block the host action](../requirements/run-statistics.md#18)

    Example: A refused record stays in progress below exact until a later read records it
      Given a slice whose run records cannot be written
      When a session that worked on that slice ends
      Then the host action continues
      And session consumption reports that run in progress with partial coverage
      And a read after the records become writable adds the record

  Rule: Run records never make a review's source stale
    # Requirement: [Record one immutable record per finished run](../requirements/run-statistics.md#10)
    # ADR: [Keep traces local and share only finished content-free run records](../ADRs/workflow-records/shared-run-records.md)

    Example: A record appended after a snapshot leaves the snapshot current
      Given a project whose source snapshot was captured for a review
      When a session that worked on a slice ends and its run record, a stray entry lock, and a temporary file appear
      Then the snapshot is still current
      And the project's Prism record ignore file ignores only lock and temporary files

  Rule: Run records outlive initiative cleanup
    # Requirement: [Keep run records after initiative cleanup](../requirements/run-statistics.md#16)

    Example: Records stay readable after the plans folder and coordination state are removed
      Given an initiative whose runs are recorded
      When coordination cleanup removes the initiative's plans folder and coordination state
      Then every run record remains readable with unchanged content

  Rule: Switching run statistics off stops new records and keeps existing ones
    # Requirement: [Switch run statistics off](../requirements/run-statistics.md#2)

    Example: A session ending while collection is off adds no record
      Given a project with one recorded run whose run statistics are then switched off
      When another session works on the same slice and ends
      Then no record is added
      And the existing record remains readable with unchanged content
