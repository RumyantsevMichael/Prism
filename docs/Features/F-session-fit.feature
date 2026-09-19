Feature: Repository context fit

  Rule: Supported session capacity is inspectable
    # Requirement: [Resolve supported session capacity](../requirements/session-fit.md#1)
    # ADR: [Provider-independent context planning](../ADRs/repository-intelligence/provider-independent-context-planning.md)

    Example: A supported session uses registered capacity
      Given a supported host, provider, model, and version
      When repository fit is evaluated
      Then the result identifies the context window and compaction threshold
      And the result identifies the source of each capacity value

    Example: An explicit capacity override takes precedence
      Given a supported session with an explicit compaction threshold
      When repository fit is evaluated
      Then the result uses the explicit compaction threshold
      And the result identifies the override as its source

  Rule: Unsupported sessions do not produce fit decisions
    # Requirement: [Reject unsupported capacity combinations](../requirements/session-fit.md#2)

    Example: An unknown model is unsupported
      Given a host, provider, model, and version without an exact supported entry
      When repository fit is evaluated
      Then the result is UNSUPPORTED
      And the result contains no repository fit classification

  Rule: Complete context estimates use deterministic budget arithmetic
    # Requirement: [Classify repository context fit](../requirements/session-fit.md#3)
    # Requirement: [Accept an adjustable implementation reserve](../requirements/session-fit.md#4)

    Example: The upper estimate fits the repository read budget
      Given a complete context estimate whose upper bound does not exceed the repository read budget
      When repository fit is evaluated
      Then the fit classification is FIT

    Example: The lower estimate exceeds the repository read budget
      Given a complete context estimate whose lower bound exceeds the repository read budget
      When repository fit is evaluated
      Then the fit classification is SPLIT

    Example: The estimate overlaps the repository read budget
      Given a complete context estimate whose bounds contain the repository read budget
      When repository fit is evaluated
      Then the fit classification is UNCERTAIN

    Example: An incomplete estimate stays uncertain
      Given a context estimate with an unavailable bound
      When repository fit is evaluated
      Then the fit classification is UNCERTAIN

    Example: Invalid arithmetic input is rejected
      Given a context estimate or target-session cost with an invalid numeric value
      When repository fit is evaluated
      Then the request fails without a fit classification
