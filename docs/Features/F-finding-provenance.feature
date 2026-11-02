Feature: Review reads select the findings a wave raised

  Rule: A finding keeps the review wave that raised it for the life of the review record
    # Requirement: [Keep the raising wave](../requirements/review-finding-provenance.md#1)

    Example: A finding fixed, verified, and reopened in later waves still names its raising wave
      Given a reviewer raised a finding in the first review wave
      And the finding was fixed and verified in the second wave
      When a reviewer reopens the finding in the third wave
      Then the finding's raising wave is still the first wave

    Example: Carrying a lane into a later wave leaves each finding's raising wave unchanged
      Given a clean review lane whose findings were raised in the first and second waves
      When the coordinator carries that lane into a later wave
      Then each finding's raising wave is unchanged

  Rule: A review read with a wave selected returns only the findings that wave raised
    # Requirement: [Select findings by raising wave](../requirements/review-finding-provenance.md#2)

    Example: Reading a review through Prism for one wave omits findings that wave only changed
      Given a review whose first wave raised one finding and whose second wave verified it and raised another
      When a caller reads the review's findings through Prism with the second wave selected
      Then only the finding raised in the second wave is returned

    Example: Reading a review for a wave that raised nothing returns no findings
      Given a review whose third wave only reopened an earlier finding
      When a caller reads the review's findings through Prism with the third wave selected
      Then no finding is returned

    Example: The review browser shows only the findings the selected wave raised
      Given a review whose first wave raised one finding and whose second wave verified it and raised another
      When the user selects the second wave as the raising wave in the review browser
      Then the findings board shows only the finding raised in the second wave
      And the raising-wave choices list only the waves that raised a finding
