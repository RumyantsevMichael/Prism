Feature: Session store safety

  Rule: Both session stores use one safety unit
    # Requirement: [Share one store safety unit](../requirements/session-store-safety.md#1)
    # ADR: [Share one safety unit between the session stores](../ADRs/repository-intelligence/shared-session-store-safety.md)

    Example: A path-safety rule applies to both stores
      Given the session trace store and the host-session fact store
      When either store checks a record path, opens a record, creates a private file, or takes the retention lock
      Then the store uses the shared store safety unit
      And the store keeps no private copy of those checks

  Rule: Each session store keeps its observable behavior
    # Requirement: [Preserve store behavior](../requirements/session-store-safety.md#2)

    Example: An invalid trace lock owner makes the trace unavailable
      Given an aged session trace lock with an invalid owner record
      When a hook appends a trace event
      Then the append reports that the trace is unavailable
      And the lock owner record remains unchanged

    Example: An invalid fact lock owner keeps the fact store busy
      Given an aged fact-retention lock with an invalid owner record
      When a hook stores active-session facts
      Then Prism reports the fact store as busy
      And the lock owner record remains unchanged

    Example: The trace store accepts a padded owner record within its limit
      Given an aged session trace lock whose padded owner record is between 129 and 256 bytes and names a dead process
      When a hook appends a trace event
      Then the trace store reclaims the lock and appends the event

    Example: The fact store refuses a padded owner record above its limit
      Given an aged fact-retention lock whose padded owner record is between 129 and 256 bytes and names a dead process
      When a hook stores active-session facts
      Then Prism reports the fact store as busy
      And the lock owner record remains unchanged
