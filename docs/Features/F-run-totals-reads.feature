Feature: Prism reads report run totals from run records

  Rule: A review read reports totals for its slice, each review wave, and each design run
    # Requirement: [Report totals through existing reads](../requirements/run-statistics.md#11)
    # Requirement: [Report the run measures](../requirements/run-statistics.md#3)
    # ADR: [Keep traces local and share only finished content-free run records](../ADRs/workflow-records/shared-run-records.md)

    Example: A slice's review read adds wave, design-run, and slice totals and keeps its earlier content
      Given a slice whose run records hold cost for one review wave, one design run, and plain slice work
      When the caller reads the slice's review
      Then the read reports the review content it reported before
      And it reports the slice total over all of the slice's runs
      And it reports a separate total for the review wave and for the design run

  Rule: An initiative read reports totals for each slice, each split parent with its descendants, and the initiative
    # Requirement: [Report totals through existing reads](../requirements/run-statistics.md#11)

    Example: A split parent's total includes the runs of its descendant slices
      Given a split parent slice with its own run record and a child slice with two run records
      When the caller reads the initiative
      Then the parent's own total counts one run
      And the parent's total with its descendants counts three runs
      And the initiative total includes every slice's runs

  Rule: Aggregates report elapsed active time and summed agent active time
    # Requirement: [Report elapsed and summed active time for aggregates](../requirements/run-statistics.md#19)
    # ADR: [Attribute run cost per Prism call and delimit runs from observed events](../ADRs/workflow-records/per-call-run-attribution.md)

    Example: Overlapping parallel work counts once in elapsed active time and fully in summed active time
      Given two runs of one slice whose active intervals overlap for 30 seconds
      When the caller reads the slice's totals
      Then the summed active time adds both runs' active time
      And the elapsed active time counts the overlapping 30 seconds once

  Rule: An aggregate's wall time is the calendar span of its runs
    # Requirement: [Report the run measures](../requirements/run-statistics.md#3)
    # Requirement: [Report elapsed and summed active time for aggregates](../requirements/run-statistics.md#19)

    Example: A slice's wall time spans its first run start to its last run end
      Given a slice whose first run starts at 0 seconds and ends at 120 seconds and whose second run spans 600 to 630 seconds
      When the caller reads the slice's totals
      Then the slice's wall time is 630 seconds rather than the sum of its runs' wall times

    Example: A review wave's wall time is approximate because segments store no start or end time
      Given a review wave whose only segment is active from 0 to 60 seconds
      When the caller reads the slice's totals
      Then the wave's wall time is 60 seconds marked approximate

  Rule: Totals mark coverage instead of reporting misleading zeros
    # Requirement: [Report coverage instead of misleading zeros](../requirements/run-statistics.md#12)

    Example: A slice without run records reports no runs and unavailable measures
      Given a slice that has no run record
      When the caller reads the initiative
      Then that slice counts zero runs
      And its time, token, and tool-call measures are unavailable rather than zero

    Example: An unreadable run record lowers coverage while the read still succeeds
      Given a slice whose run records cannot be read because one exceeds the size limit
      When the caller reads the initiative
      Then the read succeeds
      And that slice's measures are unavailable
      And the initiative total is marked partial

    Example: A run record outside the allowed shape is skipped and marks its slice partial
      Given a slice with one valid run record and one record holding a field outside the allowed shape
      When the caller reads the initiative
      Then that slice counts one run
      And its measures are marked partial

  Rule: A session consumption read reports the session's recorded totals apart from in-progress cost
    # Requirement: [Report totals through existing reads](../requirements/run-statistics.md#11)
    # Requirement: [Record unfinished runs later](../requirements/run-statistics.md#13)

    Example: An ended session's recorded totals count only its own runs
      Given a session that worked on a slice and ended, in a slice that also holds another session's run records
      When the session reads its consumption summary
      Then the recorded totals count only the session's own run
      And nothing is reported in progress for that run
