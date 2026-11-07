Feature: Choosing the review app's appearance

  Rule: The review app follows the operating system's theme until the person chooses one
    # Requirement: [Follow the operating system theme by default](../requirements/review-app-ui-kit.md#4)

    Example: The page switches to dark when the operating system does
      Given the person has never chosen a theme
      And the review page is open in a light operating system theme
      When the operating system switches to its dark theme
      Then the review page shows the dark theme without reloading

  Rule: A chosen theme applies to every surface and survives a reload and a restart
    # Requirement: [Let the person choose the theme](../requirements/review-app-ui-kit.md#3)

    Example: Choosing Dark from the Appearance menu
      Given the review page is open in a light operating system theme
      When the person chooses Dark in the status bar's Appearance menu
      Then the top bar, the status bar, the panels, and the rendered content show the dark theme
      And the review page still shows the dark theme after a reload

    Example: The choice survives a restart on another port
      Given the person chose Dark
      When the review app restarts on another port
      Then the review page at the new address shows the dark theme

  Rule: The person chooses compact or comfortable density, and compact is the default
    # Requirement: [Let the person choose the density](../requirements/review-app-ui-kit.md#5)

    Example: Comfortable density gives controls more room
      Given the review page shows the compact density
      When the person chooses Comfortable in the Appearance menu
      Then every control of the review page is taller
      And the review page still shows the comfortable density after a reload

  Rule: The Appearance menu works from the keyboard
    # Requirement: [Make every control usable from the keyboard](../requirements/review-app-ui-kit.md#7)

    Example: Opening the menu and choosing an item with keys
      Given focus is on the Appearance button
      When the person presses Enter, moves with the arrow keys, and presses Enter on Dark
      Then the dark theme applies and focus returns to the Appearance button
