Feature: One UI kit for the review app

  Rule: The catalog shows every shared control as it ships
    # Requirement: [Serve a catalog of the shared components](../requirements/review-app-ui-kit.md#10)

    # Contract clauses: 57, 58
    Example: Every control appears with its documentation and specimens
      Given the review app is running
      When the person opens the component catalog
      Then every shared control appears with its purpose, options, states, and keys
      And each control is shown with long text, an unbroken name, and many items where it holds items
      And every theme value is listed by name

  Rule: A diagram follows the chosen theme and keeps the colors its author set
    # Requirement: [Let the person choose the theme](../requirements/review-app-ui-kit.md#3)

    # Contract clauses: 64, 65
    Example: A diagram with an authored color in the dark theme
      Given a PlantUML diagram that colors one node pink and leaves the rest to PlantUML
      When the person views the diagram in the dark theme
      Then the diagram's sheet, boxes, lines, and text show the dark theme
      And the pink node stays pink

  Rule: The layout check names a catalog entry that breaks
    # Requirement: [Check the catalog layout](../requirements/review-app-ui-kit.md#11)

    # Contract clauses: 60, 61
    Example: An entry that escapes its container at a phone width
      Given a catalog entry is wider than a phone window
      When the layout check runs at the phone width in the dark theme
      Then the check fails
      And it names the entry, the phone width, and the dark theme

  Rule: A change that styles around the kit fails the test suite
    # Requirement: [Refuse styling that bypasses the kit](../requirements/review-app-ui-kit.md#12)

    # Contract clauses: 71
    Example: A raw color in a screen's stylesheet
      Given a contributor writes a hex color in a screen's stylesheet
      When the test suite runs
      Then it fails and names the file, the line, and the color

    # Contract clauses: 73
    Example: A button styled outside the kit
      Given a contributor writes button markup in a screen's script
      When the test suite runs
      Then it fails and names the file and the button

  Rule: Reduced motion makes every change instant
    # Requirement: [Respect reduced motion](../requirements/review-app-ui-kit.md#13)

    # Contract clauses: 9
    Example: Nothing animates when the operating system asks for reduced motion
      Given the operating system asks for reduced motion
      When the person opens any screen of the review page
      Then no element of the page animates or transitions
