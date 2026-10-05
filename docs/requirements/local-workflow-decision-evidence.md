# Local workflow decision evidence

Status: Draft
Created: 2026-09-26
Approved: n/a

## Problem

Prism records some session consumption, but an operator cannot reconstruct why agents selected providers or returned null context estimates.
Fit, review, and pause decisions can also lack a clear local history, so failure analysis depends on sensitive transcripts.

## Goals

- Explain provider selection and context-plan uncertainty with stable reasons.
- Preserve the fit, review, and pause decisions that connect a plan to its outcome.
- Keep root and subagent decisions distinct without storing user content.
- Return an ordered local decision history with explicit coverage gaps.

## Non-goals

- Upload usage data.
- Store prompts, source text, commands, tool output, model responses, credentials, or transcripts.
- Infer a worker's motive when the worker did not record one.
- Use a diagram metric to decide `FIT` or `SPLIT` automatically.

## Design questions

- Which checkpoint should capture skill decisions that do not pass through an MCP tool?
- Should decision recording use the existing session-trace enablement or a separate project setting?
- How can an operator keep a redacted case summary after bounded decision records expire?

<a id="1"></a>
## 1. Keep decision recording opt-in

Pattern: State-driven

Disposition: Active

Requirement: While local decision recording is disabled, Prism shall not persist workflow decision records.

Rationale: Operators must choose when a project records its workflow decisions.

Related: [Record allowlisted session events](session-consumption-tracing.md#1).

<a id="2"></a>
## 2. Record supported workflow checkpoints

Pattern: Complex

Disposition: Active

Requirement: While local decision recording is enabled, when a workflow checkpoint completes, Prism shall store its project, execution, time, outcome, and provenance locally.

Rationale: An ordered decision history needs a stable project and execution identity without a transcript.

Related: [Keep decision recording opt-in](#1), [Isolate root execution observations](session-consumption-tracing.md#5).

<a id="3"></a>
## 3. Explain provider selection

Pattern: Event-driven

Disposition: Active

Requirement: When Prism completes a context-plan request, Prism shall record the requested provider, selected provider if any, and each observed exclusion reason.

Rationale: A later audit must distinguish an agent's explicit choice from provider unavailability.

Related: [Discover registered providers safely](repository-intelligence-providers.md#2), [Select and compose providers](repository-intelligence-providers.md#3).

<a id="4"></a>
## 4. Explain context estimate eligibility

Pattern: Event-driven

Disposition: Active

Requirement: When Prism returns a context plan, Prism shall record its range counts, estimate bounds, and each reason an estimate is null.

Rationale: A null estimate must identify its cause while keeping observed source size separate from fit evidence.

Related: [Preserve uncertainty](repository-intelligence-providers.md#4), [Report observed source-range size separately from fit estimates](partial-context-estimates.md#1).

<a id="5"></a>
## 5. Record atomic fit evidence

Pattern: Event-driven

Disposition: Active

Requirement: When a design worker submits a fit result, Prism shall record its diagram readability judgment, any split assessment, and supporting evidence.

Rationale: A later review must see whether diagram complexity affected the atomic-fit decision.

Related: [Assess diagram readability before atomic fit](slice-complexity-assessment.md#1), [Classify repository context fit](session-fit.md#3).

<a id="6"></a>
## 6. Record review outcomes

Pattern: Event-driven

Disposition: Active

Requirement: When a reviewer submits a result, Prism shall record its phase, finding identifiers, dispositions, and evidence references.

Rationale: Review outcomes connect earlier fit decisions to later corrections and splits.

Related: [Record atomic fit evidence](#5).

<a id="7"></a>
## 7. Record pause ownership

Pattern: Event-driven

Disposition: Active

Requirement: When an orchestrator completes a pause checkpoint, Prism shall record its state revision, active work, and authoritative recovery locations.

Rationale: An audit must distinguish a current checkpoint from an older recovery file.

Related: [Produce a current pause checkpoint](pause-recovery-checkpoints.md#1).

<a id="8"></a>
## 8. Return a coverage-aware decision history

Pattern: Event-driven

Disposition: Active

Requirement: When an operator requests a decision history, Prism shall return ordered records and coverage gaps with root and subagent executions distinct.

Rationale: Missing observations must not appear as evidence that an agent made no decision.

Related: [Summarize pre-edit repository consumption](session-consumption-tracing.md#3), [Record supported workflow checkpoints](#2).

<a id="9"></a>
## 9. Reject unproved decision identity

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Prism cannot prove a decision's project or execution identity, then Prism shall reject its record and report the reason to the caller.

Rationale: A decision from another project or agent must not enter the wrong history.

Related: [Isolate root execution observations](session-consumption-tracing.md#5), [Prove host behavior and stable project identity](session-consumption-tracing.md#9).

<a id="10"></a>
## 10. Exclude user content

Pattern: Event-driven

Disposition: Active

Requirement: When Prism persists a decision record, Prism shall exclude prompts, source text, command text, tool output, model responses, credentials, and transcripts.

Rationale: Local failure analysis needs outcomes and reasons, not project content.

Related: [Record allowlisted session events](session-consumption-tracing.md#1).

<a id="11"></a>
## 11. Bound local retention

Pattern: Event-driven

Disposition: Active

Requirement: When Prism stores decision records, Prism shall enforce a 30-day age limit and a 64-MiB total storage limit.

Rationale: Decision evidence must not grow without a storage bound.

Related: [Bound aggregate trace retention](session-consumption-tracing.md#6).
