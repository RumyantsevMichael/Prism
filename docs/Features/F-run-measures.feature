Feature: Run measures per execution

  Rule: Run statistics are collected by default for every session and subagent
    # Requirement: [Collect run statistics by default](../requirements/run-statistics.md#1)
    # Requirement: [Report the run measures](../requirements/run-statistics.md#3)
    # ADR: [Keep traces local and share only finished content-free run records](../ADRs/workflow-records/shared-run-records.md)

    Example: The session consumption summary reports separate measures for the root session and each subagent
      Given Prism hooks are installed and the workflow configuration does not mention run statistics
      And a host session starts one subagent that makes one tool call
      When session consumption is summarized for that session
      Then the root session reports wall time, active time, input, cache-write, cache-read, and output tokens, and tool calls
      And the root session's wall time runs from session start to its last observed event
      And the subagent reports the same measures separately from the root session
      And the subagent's source reads do not enter the root session's pre-edit summary
      And the stored trace contains no prompt, response, command, transcript path, or raw host identifier

    Example: A subagent with an unusable identifier stays out of the root session's pre-edit summary
      Given a host session whose subagent reports an identifier Prism cannot use
      When that subagent reads a source file and session consumption is summarized
      Then the root session's pre-edit summary is the same as without that subagent
      And the root session's run measures are partial

  Rule: The workflow off switch stops collection
    # Requirement: [Switch run statistics off](../requirements/run-statistics.md#2)

    Example: A project that switches run statistics off collects no run measures
      Given the workflow configuration switches run statistics off
      When a host session makes tool calls and starts a subagent
      Then session consumption reports run statistics collection as off
      And no execution reports run measures
      And no run statistics trace is stored for the session or the subagent

  Rule: Each model message counts once
    # Requirement: [Count each model message once](../requirements/run-statistics.md#4)

    Example: A message repeated across transcript records is counted once
      Given the host transcript repeats one model message's usage in two records
      When session consumption is summarized
      Then that message's input, cache-write, cache-read, and output tokens are each counted once

  Rule: Idle gaps are excluded from active time
    # Requirement: [Exclude idle gaps from active time](../requirements/run-statistics.md#5)

    Example: A twenty-minute pause without a running tool is not active time
      Given an execution waits twenty minutes with no tool call running
      When session consumption is summarized
      Then active time excludes the twenty-minute pause
      And wall time includes it
      And the five-minute idle threshold is reported with active time

    Example: A twelve-minute tool call is active time
      Given an execution runs one tool call for twelve minutes
      When session consumption is summarized
      Then active time includes the twelve minutes

  Rule: Unobserved measures are marked instead of reported as zero
    # Requirement: [Report coverage instead of misleading zeros](../requirements/run-statistics.md#12)
    # Requirement: [Never block the host action](../requirements/run-statistics.md#18)

    Example: An unrecognized transcript leaves token measures unavailable
      Given the host transcript format is not recognized
      When a tool call completes and session consumption is summarized
      Then the hook lets the tool call continue
      And every token measure is unavailable rather than zero
      And the tool call count is still reported as exact
      And the root session's pre-edit coverage and reasons are unchanged by run statistics

    Example: A usage read cut short by its time limit keeps the last totals as partial
      Given an earlier usage read counted the transcript completely
      And a later usage read runs out of its time limit
      When session consumption is summarized
      Then every token measure reports the earlier totals as partial
      And no token measure is reported as exact

  Rule: Codex reports provable session totals only
    # Requirement: [Limit Codex attribution to provable totals](../requirements/run-statistics.md#14)
    # ADR: [Attribute run cost per Prism call and delimit runs from observed events](../ADRs/workflow-records/per-call-run-attribution.md)

    Example: A Codex session reports session totals without a cache-write figure
      Given a Codex session whose transcript reports cumulative token usage
      When session consumption is summarized
      Then the session reports input, cache-read, and output tokens from that usage
      And cache-write tokens are unavailable
      And attribution below the session is partial

    Example: A Codex session with a subagent thread reports the totals of all its threads
      Given a Codex session whose root thread and one subagent thread each report cumulative token usage
      And each thread makes one tool call
      When session consumption is summarized
      Then the session reports input, cache-read, and output tokens summed over both threads
      And the session reports both tool calls
      And no separate subagent row is reported
      And attribution below the session is partial
