Feature: Session cost attributed per Prism target and role

  Rule: Each Prism call that names a target attributes the following cost to that target and the caller's role
    # Requirement: [Attribute cost at each Prism call](../requirements/run-statistics.md#6)
    # ADR: [Attribute run cost per Prism call and delimit runs from observed events](../ADRs/workflow-records/per-call-run-attribution.md)

    Example: A coordinator call on a slice with an open review wave attributes the following cost to that wave
      Given a slice whose latest review wave is not accepted
      When the root session updates that slice's review as coordinator and then keeps working
      Then session consumption reports that cost under that wave and the coordinator role
      And the attribution is exact

    Example: An undeclared delivery call during design attributes the following cost to the next design run
      Given a slice in design whose two design audits have started
      When a subagent that declares no role reads that slice's change map
      Then session consumption reports its following cost under design run 3 of that slice and the delivery role
      And the attribution is approximate

    Example: A call naming only an initiative attributes the following cost to the initiative's root slice
      Given an initiative whose root slice has no active work and no review
      When the root session reads the initiative
      Then session consumption reports its following cost under the root slice and the coordinator role
      And the attribution is approximate because the role was inferred

  Rule: A subagent inherits the starter's target and role until its own first Prism call
    # Requirement: [Inherit attribution into a subagent](../requirements/run-statistics.md#7)

    Example: A subagent's reading before its first Prism call counts toward the wave it was started for
      Given the root session's current target is a review wave with the coordinator role
      When the root session starts a subagent that reads files before its first Prism call
      Then that subagent's cost before its first Prism call is reported under the same wave and role

  Rule: Interleaved slices are approximate
    # Requirement: [Mark interleaved slice attribution as approximate](../requirements/run-statistics.md#8)

    Example: Naming a second slice while the first is still active makes both slices approximate
      Given two slices with active work in coordination state
      When the root session names the first slice and then the second slice with declared roles
      Then the cost attributed to each slice is marked approximate

  Rule: Cost without a target stays unattributed
    # Requirement: [Report unattributed cost](../requirements/run-statistics.md#9)

    Example: Cost before the first Prism call is reported as unattributed
      Given a session that works before making any Prism call
      When session consumption is summarized
      Then that cost is reported as the session's unattributed cost
      And attributed and unattributed tokens and tool calls add up to the session's totals

  Rule: A call into a project whose run statistics are off attributes nothing to that project
    # Requirement: [Switch run statistics off](../requirements/run-statistics.md#2)
    # ADR: [Keep traces local and share only finished content-free run records](../ADRs/workflow-records/shared-run-records.md)

    Example: A call naming a slice of a project with collection off leaves the cost unattributed
      Given a second project whose workflow config switches run statistics off
      And a slice of that project whose latest review wave is not accepted
      When the root session updates that slice's review as coordinator with that project as its project root
      Then session consumption reports no target from that project
      And the following cost is reported as unattributed

  Rule: Failed reads and writes lower coverage instead of blocking the host
    # Requirement: [Report coverage instead of misleading zeros](../requirements/run-statistics.md#12)
    # Requirement: [Never block the host action](../requirements/run-statistics.md#18)

    Example: An unreadable review ledger attributes the call to its slice with partial coverage
      Given a slice whose review ledger cannot be read
      When the root session updates that slice's review as coordinator
      Then the hook lets the call continue
      And the following cost is reported under that slice with partial attribution

    Example: A refused attribution write leaves the cost unattributed and below exact
      Given the trace store refuses to store a Prism call's attribution
      When the root session keeps working after that call
      Then the hook lets the call continue
      And the cost is reported as unattributed with partial coverage

    Example: A call into a project whose workflow config cannot be read lowers the following cost
      Given a second project whose workflow config is larger than its bound
      And the root session has updated a slice review as delivery in its own project
      When the root session reads a review of the second project with that project as its project root
      Then the hook lets the call continue
      And session consumption reports no target from the second project
      And the following cost stays with the earlier slice with partial attribution

  Rule: Codex attribution below the session is partial
    # Requirement: [Limit Codex attribution to provable totals](../requirements/run-statistics.md#14)

    Example: A Codex call is attributed with partial coverage and a subagent thread's cost before its first call stays unattributed
      Given a Codex session whose root thread updates a slice's review as coordinator
      And a Codex subagent thread that makes no Prism call
      When session consumption is summarized
      Then the root thread's following cost and time are reported under that slice's wave with partial attribution
      And the subagent thread's cost and time are reported as unattributed with partial coverage
