Feature: Review loop decisions follow from the findings

  Rule: A review wave is accepted with its low findings deferred by the user's decision
    # Requirement: [Accept a wave with deferred low findings](../requirements/review-loop-decisions.md#1)

    Example: Accepting a wave records each low finding as deferred with its decision and follow-up
      Given a slice whose only unresolved review findings are two low findings
      And the user chose to accept them with deferred findings at the slice's decision gate
      When the coordinator accepts the review wave citing that gate and a follow-up issue for each finding
      Then the wave is accepted
      And each low finding is recorded as deferred with that gate and its follow-up issue
      And the slice can complete

    Example: A choice given in conversation counts once the coordinator records it on the gate
      Given the user chose in conversation to accept the low findings with deferred findings
      And the coordinator closed the gate recording that choice
      When the coordinator accepts the review wave citing that gate and a follow-up for each finding
      Then the wave is accepted with the findings deferred

  Rule: Prism refuses to defer anything but low findings the user chose to accept, each with a follow-up
    # Requirement: [Refuse deferring other findings](../requirements/review-loop-decisions.md#2)

    Example: Deferring a high finding is refused and names it
      Given a slice with an unresolved high finding and the user's choice to accept with deferred findings
      When the coordinator accepts the review wave deferring the high finding
      Then Prism refuses, naming the high finding and that it is not low
      And no finding changes

    Example: Deferring without the user's choice is refused
      Given a slice whose decision gate the user answered by continuing the review
      When the coordinator accepts the review wave citing that gate with deferred low findings
      Then Prism refuses, naming each finding and that the gate did not choose to accept them

    Example: A low finding left without a follow-up is refused
      Given a slice with two unresolved low findings and the user's choice to accept them
      When the coordinator accepts the review wave giving a follow-up for only one of them
      Then Prism refuses, naming the other finding and its missing follow-up

  Rule: Readers see deferred findings apart, with their decision and follow-up
    # Requirement: [Show deferred findings](../requirements/review-loop-decisions.md#3)

    Example: Reading a review through Prism lists the deferred findings
      Given a slice accepted with two deferred low findings
      When a caller reads the slice's review through Prism
      Then each deferred finding is listed with its severity, its decision gate, and its follow-up

    Example: The review browser shows deferred findings in their own column
      Given a slice accepted with two deferred low findings
      When the user opens the slice's findings board in the review browser
      Then the deferred findings appear in a deferred column after the verified one
      And they do not count as unresolved

  Rule: At the review wave limit Prism asks the decision itself with a summary of the findings
    # Requirement: [Ask the review loop decision with a summary](../requirements/review-loop-decisions.md#4)

    Example: The third wave is refused and Prism records one decision with the summary
      Given a slice that had two review waves since its design was accepted
      When the coordinator starts a third review wave without an answered decision
      Then Prism refuses and names the decision gate it recorded for the slice
      And the gate summarizes the unresolved findings by severity, what each wave raised and closed, and the files named in more than one wave

    Example: Asking again names the same pending decision
      Given Prism recorded a review loop decision for a slice that is still unanswered
      When the coordinator starts another review wave without an answered decision
      Then Prism names the same decision gate and records no other

  Rule: The decision offers only the options Prism can carry out
    # Requirement: [Offer only options that apply](../requirements/review-loop-decisions.md#5)

    Example: Accepting is not offered while a medium finding is unresolved
      Given a slice at the review wave limit with an unresolved medium finding
      When Prism records the review loop decision
      Then it offers continuing the review and returning the slice to design
      And it does not offer accepting with deferred findings
      And it never offers narrowing the slice

    Example: Accepting is offered while every unresolved finding is low
      Given a slice at the review wave limit whose unresolved findings are all low
      When Prism records the review loop decision
      Then it also offers accepting with deferred low findings

  Rule: The recommendation follows a stated rule over the findings
    # Requirement: [Recommend by a stated rule](../requirements/review-loop-decisions.md#6)

    Example: Only low findings left recommends accepting
      Given a slice at the review wave limit whose unresolved findings are all low
      When Prism records the review loop decision
      Then it recommends accepting with deferred findings and says why

    Example: A latest wave raising as many serious findings as the one before recommends redesign
      Given the latest wave raised one medium finding and the wave before it raised one high finding
      When Prism records the review loop decision
      Then it recommends returning the slice to design and says the review is not converging

    Example: A latest wave raising fewer serious findings recommends continuing
      Given the latest wave raised one medium finding and the wave before it raised two high findings
      When Prism records the review loop decision
      Then it recommends continuing the review and says the review is converging

  Rule: Returning to design from the decision blocks the slice with its findings as defects
    # Requirement: [Return to design from the review loop decision](../requirements/review-loop-decisions.md#7)

    Example: A return to design without a named clause carries every unresolved finding
      Given the user chose to return a slice to design at its review loop decision
      And no unresolved finding names a contract clause
      When the coordinator returns the slice to design citing that gate
      Then the slice is blocked for a design revision
      And each unresolved finding is one of its defects

    Example: A decision to continue does not return the slice
      Given the user chose to continue the review at the slice's review loop decision
      When the coordinator returns the slice to design citing that gate
      Then Prism refuses and the slice stays in progress
