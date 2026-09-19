Feature: Session consumption tracing

  Rule: Tracing stores no user content
    # Requirement: [Record allowlisted session events](../requirements/session-consumption-tracing.md#1)
    # ADR: [Same-session facts and local tracing](../ADRs/repository-intelligence/same-session-facts-and-local-tracing.md)

    Example: A supported source read records metadata only
      Given local session tracing is enabled
      When a supported source read completes
      Then the trace records the relative path, range, rendered token count, and provenance
      And the trace does not store source, prompts, commands, responses, credentials, or transcripts

  Rule: The pre-edit window closes on a confirmed mutation
    # Requirement: [Identify the first successful edit](../requirements/session-consumption-tracing.md#2)

    Example: A failed edit keeps the window open
      Given a traced session has not completed an edit
      When an edit attempt fails
      Then the session has no first-edit event
      And later source reads remain in the pre-edit summary

    Example: A successful edit closes the window once
      Given a traced session has not completed an edit
      When a repository mutation succeeds after its pre-tool attempt with the same host identifier
      Then one first-edit event is recorded
      And both host event phases remain recorded
      And later mutations do not create another first-edit event

    Example: A reviewed Codex lifecycle closes the window without response-text inference
      Given a root Codex transcript reports exact version 0.147.0 or 0.155.0-alpha.9.2 with provider openai
      When an exact apply_patch PostToolUse event is observed
      Then one first-edit event is recorded
      And response text is not inspected to prove mutation success

    Example: An unsupported Codex version keeps the window open
      Given a traced Codex session has not completed an edit
      When an apply_patch PostToolUse event has no exact trace behavior profile
      Then the session has no first-edit event
      And instrumentation coverage is partial

    Example: An unknown host edit keeps the window open
      Given a hook event cannot be classified as Codex or Claude
      When an edit response reports a success-like field
      Then the session has no first-edit event
      And instrumentation coverage is partial

  Rule: Summaries are coverage-aware
    # Requirement: [Summarize pre-edit repository consumption](../requirements/session-consumption-tracing.md#3)
    # Requirement: [Isolate and limit traces](../requirements/session-consumption-tracing.md#4)
    # Requirement: [Mark approximate rendered-token observations](../requirements/session-consumption-tracing.md#7)
    # Requirement: [Order observations by occurrence](../requirements/session-consumption-tracing.md#10)

    Example: Overlapping reads are deduplicated
      Given a traced session reads overlapping ranges before its first edit
      And the hook emitted that session's SHA-256 correlation key
      When session consumption is summarized with that correlation key
      Then unique source ranges are counted once
      And the summary reports its instrumentation coverage

    Example: Unsupported mutations reduce coverage
      Given a traced session may mutate the repository through an unsupported tool
      When session consumption is summarized
      Then coverage is partial
      And missing observation is not reported as zero consumption

    Example: Subagent observations do not enter the root summary
      Given a Codex subagent shares the root session identifier
      When the subagent completes a supported tool action
      Then the root execution trace excludes that action detail
      And instrumentation coverage is partial

    Example: Approximate Codex string response counts stay content-free
      Given a root Codex read response has no rendered token count
      When its exact behavior profile documents a string response within one MiB
      Then the trace stores only the approximate numeric count
      And instrumentation coverage is partial

    Example: Codex response objects are not serialized for counting
      Given a root Codex read response has an object response and no rendered token count
      When session consumption is summarized
      Then rendered token consumption is unavailable
      And instrumentation coverage is partial

    Example: Delayed observations use event chronology
      Given a source read occurred before the first successful edit but arrived later
      When session consumption is summarized
      Then the read remains in the pre-edit summary
      And the first-edit boundary uses the earliest successful edit time

  Rule: Host and path classification fail closed
    # Requirement: [Prove host behavior and stable project identity](../requirements/session-consumption-tracing.md#9)

    Example: A correlated Codex transcript overrides compatibility variables
      Given Codex exports Claude compatibility variables
      When a valid root transcript correlates the session and canonical project
      Then the event is classified as Codex

    Example: Claude uses a stable documented project root
      Given a Claude hook changes its working directory beneath CLAUDE_PROJECT_DIR
      When a supported repository action is observed
      Then the trace identity remains bound to the canonical CLAUDE_PROJECT_DIR

    Example: An edit path resolves outside the project
      Given an edit path traverses an in-project symbolic link to another directory
      When the host reports successful completion
      Then the trace records no successful edit
      And instrumentation coverage is partial

  Rule: Aggregate trace retention is bounded
    # Requirement: [Bound aggregate trace retention](../requirements/session-consumption-tracing.md#6)

    Example: Oldest eligible traces are removed first
      Given trace records and owned temporary files exceed the age or aggregate byte limit
      When Prism appends another trace event
      Then expired traces and stale owned temporary files are removed
      And remaining excess traces are removed by age and file name

    Example: An active temporary file counts toward the quota
      Given an owned temporary trace file is not stale
      When another append would exceed 64 MiB
      Then the append fails closed without deleting the active temporary file

  Rule: Trace storage preserves writer authority
    # Requirement: [Protect trace storage authority](../requirements/session-consumption-tracing.md#11)

    Example: A symbolic-link trace record is rejected
      Given a trace record path is a symbolic link
      When Prism reads or appends that trace
      Then Prism does not follow or replace the link target

    Example: A live lock is not taken over because of age
      Given a token-owned trace lock is old and its process remains alive
      When another writer attempts to append
      Then the second writer reports the lock unavailable

    Example: A writer loses its lock before commit
      Given a trace writer no longer owns the persisted lock token
      When it reaches the commit boundary
      Then it neither commits nor acknowledges the append

  Rule: MCP reads use the hook-emitted correlation key and plugin data directory
    # Requirement: [Resolve traces by session correlation key](../requirements/session-consumption-tracing.md#8)

    Example: The same active trace is found without exposing its raw session identifier
      Given an enabled hook emitted a valid session correlation key and plugin data directory
      When the caller requests consumption for that key, data directory, and canonical project root
      Then Prism returns only the trace that matches both identities
