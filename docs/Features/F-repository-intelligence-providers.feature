Feature: Repository intelligence providers

  Rule: Native repository intelligence is always available
    # Requirement: [Provide a native baseline](../requirements/repository-intelligence-providers.md#1)
    # ADR: [Provider selection and native baseline](../ADRs/repository-intelligence/provider-selection-and-native-baseline.md)

    Example: A project without an external index gets lexical context
      Given a project with nonignored text source
      And no external repository intelligence provider is available
      When repository context is planned automatically
      Then native lexical matches are returned
      And live source is used for token accounting
      And unavailable semantic and structural coverage is reported

  Rule: Provider discovery is read-only and inspectable
    # Requirement: [Discover registered providers safely](../requirements/repository-intelligence-providers.md#2)

    Example: Registered providers report deterministic availability
      Given native, CodeGraph, and CodeNib are registered
      When repository intelligence providers are listed
      Then every provider reports its availability and capabilities
      And providers are ordered by identifier
      And no provider index is created or updated

  Rule: Selection composes native source with optional external evidence
    # Requirement: [Select and compose providers](../requirements/repository-intelligence-providers.md#3)
    # Requirement: [Preserve uncertainty](../requirements/repository-intelligence-providers.md#4)

    Example: Automatic selection uses one healthy external provider
      Given more than one registered external provider is healthy
      When repository context is planned automatically
      Then native source reads are used
      And at most one external provider contributes retrieval evidence
      And the plan identifies every contributor

    Example: Automatic external failure falls back to native
      Given the automatically selected external provider fails during retrieval
      When repository context is planned automatically
      Then planning retries once with native only
      And the plan records the external failure

    Example: Explicit unavailable selection fails visibly
      Given CodeGraph is explicitly selected
      And CodeGraph is unavailable
      When repository context is planned
      Then the request fails with a CodeGraph availability diagnostic
      And Prism does not silently select another external provider

  Rule: CodeGraph contributes only from a healthy index
    # Requirement: [Use CodeGraph without managing its index](../requirements/repository-intelligence-providers.md#5)

    Example: A current CodeGraph index contributes graph evidence
      Given a compatible CodeGraph index is complete and current for the exact project root
      When CodeGraph is selected for repository context planning
      Then CodeGraph nodes and edges are normalized into provider-independent evidence
      And native reads supply the selected source

    Example: A stale CodeGraph index is unavailable
      Given CodeGraph reports pending repository changes
      When provider availability is checked
      Then CodeGraph reports a stale-index diagnostic
      And Prism does not run an index update
