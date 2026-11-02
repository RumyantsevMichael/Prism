Feature: Review browser shows wave, slice, and initiative run totals

  Rule: Each review wave card shows the run totals of that wave
    # Requirement: [Show run statistics in the review browser](../requirements/run-statistics.md#17)
    # Requirement: [Report coverage instead of misleading zeros](../requirements/run-statistics.md#12)
    # ADR: [Keep traces local and share only finished content-free run records](../ADRs/workflow-records/shared-run-records.md)

    Example: A wave with recorded runs shows its measures beside their coverage marks
      Given a slice whose run records hold one run's cost for its first review wave
      When the user opens the slice's review ledger in the review browser
      Then the first wave card shows its runs, wall time, elapsed and summed active time, token categories, and tool calls
      And each shown measure carries its coverage mark
      And the wave's wall time is marked approximate
      And the card states the idle threshold that active time excludes

    Example: A wave without recorded runs says so instead of showing zero cost
      Given a slice whose second review wave has no run records
      When the user opens the slice's review ledger in the review browser
      Then the second wave card states that no run was recorded

  Rule: The slice page shows the slice's run totals, and a split parent also shows its descendants' totals
    # Requirement: [Show run statistics in the review browser](../requirements/run-statistics.md#17)
    # Requirement: [Report totals through existing reads](../requirements/run-statistics.md#11)

    Example: A leaf slice shows the totals of all its runs
      Given a leaf slice with two recorded runs
      When the user opens the slice in the review browser
      Then the slice page shows two runs with their wall time, elapsed and summed active time, token categories, and tool calls
      And a token category that was observed as zero shows zero marked exact

    Example: A split parent shows its own totals and its totals with descendants
      Given a split parent slice with one recorded run whose child slice has two recorded runs
      When the user opens the parent slice in the review browser
      Then the slice page shows one run for the parent's own work
      And it shows three runs for the parent including its descendants

    Example: A slice without records says that no run was recorded
      Given a slice with no run records
      When the user opens the slice in the review browser
      Then the slice page states that no run was recorded

  Rule: Unobserved measures show as unavailable, never as zero
    # Requirement: [Report coverage instead of misleading zeros](../requirements/run-statistics.md#12)

    Example: A slice whose run records cannot be read shows every measure as unavailable
      Given a slice whose run records cannot be read
      When the user opens the slice in the review browser
      Then every measure on the slice page is marked unavailable
      And no measure shows zero

  Rule: The initiative page shows the initiative's run totals
    # Requirement: [Show run statistics in the review browser](../requirements/run-statistics.md#17)
    # Requirement: [Report coverage instead of misleading zeros](../requirements/run-statistics.md#12)

    Example: Known sums stay visible and are marked partial when one slice's records cannot be read
      Given an initiative with three recorded runs across its slices and one slice whose run records cannot be read
      When the user opens the initiative in the review browser
      Then the initiative page shows three runs with the known token and tool-call sums
      And those measures are marked partial
