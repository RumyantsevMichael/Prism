Feature: Repository intelligence providers

  Rule: Native repository intelligence is always available
    # Requirement: [Provide a native baseline with safe symbolic-link identity](../requirements/repository-intelligence-providers.md#6)
    # Requirement: [Reject unsupported non-file paths](../requirements/repository-intelligence-providers.md#7)
    # ADR: [Symlink snapshot identity](../ADRs/repository-intelligence/symlink-snapshot-identity.md)

    Example: A project without runtime assets gets lexical context
      Given a project with nonignored text source
      And no external repository intelligence provider is available
      And the native semantic runtime is unavailable
      When repository context is planned automatically
      Then native lexical matches are returned
      And live source is used for token accounting
      And unavailable semantic and structural coverage is reported

    Example: Symbolic links preserve complete snapshot verification
      Given a project with nonignored text source and a symbolic link
      When the native repository snapshot is verified
      Then the symbolic-link value participates in freshness verification
      And the symbolic link is not exposed as searchable source

    Example: Unsupported non-file paths keep the snapshot incomplete
      Given a project with a Git submodule path
      When the native repository snapshot is verified
      Then the native repository scan is incomplete

    Example: Symbolic links remain bounded
      Given a project whose symbolic links exceed a native scan limit
      When the native repository snapshot is verified
      Then the native repository scan is incomplete

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

    Example: Automatic selection prepares native semantic analysis
      Given more than one registered external provider is healthy
      When repository context is planned automatically
      Then native source reads are used
      And native semantic and structural analysis is prepared in private storage
      And no external provider executable is invoked
      And the plan identifies every contributor

    Example: Native runtime failure preserves lexical results
      Given the native semantic runtime fails during retrieval
      When repository context is planned automatically
      Then native lexical matches remain available
      And the plan reports degraded semantic capabilities
      And no numeric fit estimate is available

    Example: Explicit unavailable selection fails visibly
      Given CodeGraph is explicitly selected
      And CodeGraph is unavailable
      When repository context is planned
      Then the request fails with a CodeGraph availability diagnostic
      And Prism does not silently select another external provider

  Rule: Native semantic evidence remains bound to verified source
    # Requirement: [Search reusable code and non-code concepts locally](../requirements/repository-intelligence-providers.md#8)
    # Requirement: [Prepare immutable private generations](../requirements/repository-intelligence-providers.md#9)

    Example: Complete native evidence supplies a numeric estimate
      Given native semantic retrieval and applicable structure are complete
      And all required hints and source ranges are resolved
      When repository context is planned automatically
      Then live verified source supplies the numeric token estimate
      And similarity scores do not change that estimate

    Example: A source edit invalidates an expected snapshot
      Given concept search returned a repository snapshot
      And a source file changes
      When concept search requires that previous snapshot
      Then the request fails with a stale_snapshot diagnostic

    Example: Cached preparation works offline
      Given runtime assets and a complete native index are cached
      And the repository snapshot is unchanged
      When concept search runs without network access
      Then the existing generation supplies semantic results

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
