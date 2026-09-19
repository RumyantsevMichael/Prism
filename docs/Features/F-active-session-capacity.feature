Feature: Active session capacity

  Rule: Active capacity uses correlated host facts
    # Requirement: [Capture allowlisted active-session facts](../requirements/active-session-capacity.md#1)
    # Requirement: [Resolve same-session capacity](../requirements/active-session-capacity.md#2)
    # ADR: [Same-session facts and local tracing](../ADRs/repository-intelligence/same-session-facts-and-local-tracing.md)

    Example: Matching Codex facts resolve capacity
      Given an enabled Codex hook recorded allowlisted facts for the active session
      And the hook emitted a SHA-256 correlation key and plugin data directory as additional context
      And the host directly attested complete capacity with total compaction scope
      And the MCP request supplies that correlation key and plugin data directory
      When active session capacity is resolved
      Then the exact effective capacity is returned with provenance
      And the bounded transcript session metadata supplies the active host version and provider

    Example: Complete explicit total-scope capacity recovers matched identity
      Given matching active-session facts contain complete identity but no directly attested threshold
      And the caller supplies a complete explicit capacity
      And total compaction scope is explicitly attested
      When active session capacity is resolved
      Then the explicit capacity is returned
      And the result identifies explicit input as its source

    Example: A child-directory hook uses the transcript project root
      Given a root Codex session transcript names the canonical project root
      And the correlated hook runs from a child directory
      When active session facts are recorded
      Then the facts are keyed to the canonical transcript project root

    Example: A same-parent subagent cannot replace root capacity
      Given supported capacity was recorded for a root Codex execution
      And a Codex subagent reports the same parent session identifier
      When the subagent hook is handled
      Then no capacity record is written for the subagent
      And the supported root capacity remains available

  Rule: Unproved active capacity fails closed
    # Requirement: [Reject unproved active-session capacity](../requirements/active-session-capacity.md#3)

    Example: Cross-session facts are unsupported
      Given stored facts exist under another valid correlation key
      When active session capacity is resolved
      Then the result is UNSUPPORTED
      And the result reason code is NO_SESSION_FACTS

    Example: A known registry default does not prove active capacity
      Given matching active-session identity has no directly attested threshold
      And the caller supplies no complete capacity override
      When active session capacity is resolved
      Then the result is UNSUPPORTED
      And no registry threshold produces a FIT classification

    Example: A partial active override is invalid
      Given matching active-session facts attest complete capacity
      And the caller supplies only one active capacity override
      When active session capacity is resolved
      Then the request is rejected without merging caller and host values

    Example: A narrower accounting scope cannot be contradicted
      Given matching active-session facts attest body-after-prefix compaction scope
      And the caller claims total compaction scope
      When active session capacity is resolved
      Then the result is UNSUPPORTED

    Example: Stale facts are unsupported
      Given stored facts exceed the allowed age
      When active session capacity is resolved
      Then the result is UNSUPPORTED
      And the result contains no fit classification

  Rule: Fact retention is bounded
    # Requirement: [Bound local fact retention](../requirements/active-session-capacity.md#4)
    # ADR: [Use same-session facts and privacy-bounded local traces](../ADRs/repository-intelligence/same-session-facts-and-local-tracing.md)

    Example: Oldest eligible facts are removed first
      Given active-session fact storage exceeds its age or aggregate byte limit
      When another fact record is stored
      Then expired records are removed
      And remaining excess records are removed by modification time and file name

    Example: Fact replacement accounts for simultaneous files
      Given a stored fact record and its replacement would exceed the aggregate byte limit while both exist
      When Prism attempts the atomic replacement
      Then Prism rejects the replacement before creating its temporary file
      And the stored fact record remains unchanged

    Example: Fact observations remain monotonic
      Given a newer fact record already exists for the same session
      When an older observation or an equal-time material conflict is stored
      Then Prism rejects the candidate
      And the newer fact record remains unchanged

    Example: Linked storage is rejected
      Given the fact directory or target record is a symbolic link
      When Prism reads or writes active-session facts
      Then Prism rejects the linked path
      And Prism does not read, replace, delete, or change permissions outside the plugin data directory

    Example: A stale lock with a proven-dead owner is recovered
      Given an aged fact-retention lock belongs to a process confirmed dead
      When another fact record is stored
      Then Prism reclaims the abandoned lock
      And the new record is stored under exclusive ownership

    Example: An aged empty publication lock is recovered
      Given a crash left an aged empty fact-retention lock before owner publication
      When another fact record is stored
      Then Prism quarantines the empty lock
      And the new owner publishes complete ownership atomically

    Example: An active or unknown lock owner remains exclusive
      Given an aged fact-retention lock belongs to an active process or an owner whose liveness is unknown
      When another fact record is stored
      Then Prism reports the fact store as busy
      And the existing owner and fact records remain unchanged
