Feature: Launched sessions from the review app

  Rule: A launch starts a headless orchestration of the chosen initiative only after a confirmation outside the browser
    # Requirement: [Launch an initiative's orchestration](../requirements/launched-sessions.md#1)
    # Requirement: [Confirm a launch outside the web page](../requirements/launched-sessions.md#5)
    # Requirement: [Open a launch window on confirmation](../requirements/launched-sessions.md#6)
    # Decision: [Launched sessions](../ADRs/workflow-records/launched-sessions.md)

    # Contract clauses: 27, 28, 31, 32
    Example: The first launch asks, and a second launch soon after does not
      Given the person's review page shows the initiative "reports"
      And Claude Code is installed on the person's computer
      When the person launches "reports" with Claude Code and confirms in the operating system's dialog
      Then a headless Claude Code session runs the orchestrate skill for "reports" in its checkout
      And the initiative's history records the launch
      And a launch of another initiative in the next 30 minutes starts without a dialog

    Example: A declined dialog starts nothing
      Given the person's review page shows the initiative "reports"
      When the person launches "reports" and declines the operating system's dialog
      Then no session starts
      And the history records nothing

  Rule: A computer without a native dialog refuses every launch
    # Requirement: [Refuse a launch without a confirmation outside the page](../requirements/launched-sessions.md#8)

    # Contract clauses: 27, 30
    Example: A computer without a graphical display
      Given the review app runs without a graphical display
      When the person launches an initiative
      Then the launch is refused with the reason that no confirmation can be shown outside the browser

  Rule: Every launched session shows what it is doing, and a stop ends all of it
    # Requirement: [Show every launched session](../requirements/launched-sessions.md#10)
    # Requirement: [Stop a launched session](../requirements/launched-sessions.md#11)
    # Requirement: [Show the terminal resume command](../requirements/launched-sessions.md#14)

    # Contract clauses: 15, 18, 19, 38
    Example: A running session is stopped from the Launched sessions place
      Given a launched Codex session of "reports" runs and has started a command of its own
      When the person stops it in the Launched sessions place
      Then the host and the command it started end
      And the place shows the session as stopped with the command that continues it in a terminal

    Example: A session the host refused an action to ends blocked
      Given a launched Claude Code session whose host refused a command it needed
      When the session ends
      Then the place shows the session as blocked with the host's reason

  Rule: An answer given on this computer moves a launched session forward
    # Requirement: [Resume a launched session on a gate answer](../requirements/launched-sessions.md#12)
    # Requirement: [Resume only on answers given on this machine](../requirements/launched-sessions.md#13)

    # Contract clauses: 21, 22, 26
    Example: The person answers the question of a session that has ended
      Given a launched session asked a question and then ended
      When the person answers the question in the review app on this computer
      Then the same host session resumes headless without another confirmation

    Example: A teammate answers on another computer
      Given a launched session asked a question and then ended
      When a teammate's answer arrives through the shared records
      Then the session stays as it is
      And the place says the answer waits for a resume on this computer
