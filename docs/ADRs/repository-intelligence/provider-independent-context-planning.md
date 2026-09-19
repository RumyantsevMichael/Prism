# Keep repository context planning provider-independent

Status: Proposed
Created: 2026-09-17

## Requirements

[Resolve supported session capacity](../../requirements/session-fit.md#1) requires exact supported capacity values with provenance.
[Reject unsupported capacity combinations](../../requirements/session-fit.md#2) prohibits fit classification from guessed capacity values.
[Classify repository context fit](../../requirements/session-fit.md#3) requires deterministic budget policy.
[Accept an adjustable implementation reserve](../../requirements/session-fit.md#4) requires a caller override for implementation headroom.
[Provide a native baseline](../../requirements/repository-intelligence-providers.md#1) requires repository discovery without an external executable.
[Select and compose providers](../../requirements/repository-intelligence-providers.md#3) requires native source with optional external evidence.
[Resolve same-session capacity](../../requirements/active-session-capacity.md#2) requires deterministic active-host capacity precedence.
[Summarize pre-edit repository consumption](../../requirements/session-consumption-tracing.md#3) requires coverage-aware measurements for later calibration.
The initiating user request also requires explainable repository-context estimates based on symbol-level hybrid retrieval and bounded structural expansion.

## Problem

Prism decides atomic fit before implementation but has no measured view of the source context that implementation must read.
Repository search providers expose different retrieval, graph, source, and token representations.
A provider-specific design would make fit policy depend on one index implementation and its release lifecycle.

## Decision

Prism MUST own a provider-independent context plan and its deterministic classification policy.
A repository-intelligence provider MUST supply repository identity, ranked source anchors, bounded graph neighbors, and bounded source reads.
The context planner MUST preserve selection reasons and provider diagnostics for each context item.
The context planner MUST merge overlapping source ranges before it counts their rendered read cost.
The context planner MUST return a `null` estimate when a compact location omits source required by that estimate.
The context planner MUST classify context as `mustRead`, `likelyRead`, or `possibleRead` with deterministic rules.
The context planner MUST expose the token-counting method and whether that method uses an exact model tokenizer.
Context items MUST keep stable source identities and reasons so later session traces can compare predicted and actual reads.
Prism MUST treat CodeNib as an optional provider and MUST NOT expose CodeNib-specific data in the context plan.
Prism SHOULD use a provider's deterministic hybrid rank and bounded graph expansion when the provider reports those capabilities.
Session-fit policy MUST remain separate from context-plan generation.
Prism MUST resolve supported session capacity from explicit overrides, host model data, or an exact bundled registry entry.
Prism MUST preserve the source of every resolved capacity value.
Prism MUST NOT classify fit when the host, provider, model, or version combination is unsupported.
The fit evaluator MUST accept target-session costs without assuming whether implementation resumes an existing worker or starts a fresh worker.

## Rationale

The boundary lets Prism replace CodeNib without changing workflow consumers or persisted plan data.
Merged source ranges measure repository context more directly than file counts or changed-file estimates.
Provider diagnostics keep partial indexes and retrieval fallbacks visible to design and review.
Separate fit arithmetic lets Prism resolve host capacity without coupling repository retrieval to one session lifecycle.

## Alternatives

### Put fit policy inside CodeNib

Declined because CodeNib does not own Prism's implementation-session budget or workflow gates.

### Build search and embeddings inside Prism

Declined because mature providers already supply lexical, semantic, and structural repository views.

### Count whole files and changed files

Declined because implementation agents can read symbols that they never modify and can avoid unrelated parts of large files.

### Require exact model tokenization in the first release

Declined because Prism does not know the target model tokenizer in every supported host.
The first release uses an explicit replaceable estimator when an exact tokenizer is unavailable.

### Require a fresh implementation worker

Declined because the current workflow can resume the same delivery worker.
The evaluator accepts the costs of the actual target session instead.

### Read arbitrary host configuration files

Declined because host configuration can contain secrets and repository-controlled paths can cross trust boundaries.
Host adapters expose only allowlisted effective capacity facts.

## Consequences

Prism ships a bounded native lexical provider, so context planning does not require a separately installed index.
Native-only planning reports semantic and structural gaps and does not produce estimates that can support `FIT`.
Automatic selection can add one healthy external contributor and retries once with native after an external runtime failure.
Explicit external selection fails visibly when that provider is unavailable.
CodeNib is a beta dependency, so its adapter must contain API changes and report incompatible responses.
The first adapter requires CodeNib `0.2.3` and validates the MCP server identity and required response fields at runtime.
CodeNib semantic retrieval requires its optional semantic installation and model data.
CodeNib graph edges do not distinguish every Prism relationship, so the adapter preserves generic `reference` evidence without inventing call semantics.
CodeNib source reads require a verified source fingerprint and can become unavailable after implementation edits.
CodeNib onboarding MUST use its read-only CodeGraph path because generic graph preparation can create project files.
CodeGraph contributes lexical and symbol-graph evidence only from a compatible complete index for the exact project root.
Prism never initializes, synchronizes, or updates a CodeGraph index during discovery or planning.
The planner can produce useful context estimates before Prism knows the session budget.
Token estimates remain conservative approximations until a host or provider supplies an exact tokenizer.
Supported capacity defaults require registry maintenance when a host or model changes.
Explicit active-session values remain authoritative over bundled defaults.
Enabled same-session hooks can supply allowlisted active capacity facts without changing provider contracts.
Local session instrumentation can add search, read, first-edit, edit, test, compaction, and completion events without storing user content.

## Mechanism

The Prism MCP process opens the native provider and zero or one selected external contributor for one project.
The provider returns normalized anchors and relationships while it retains provider-specific plans and response shapes internally.
The planner merges overlapping ranges, reads each merged range once, and counts the rendered provider response.
The planner returns the repository commit, classified items, lower and expected and upper estimates, and diagnostics.
The session-capacity resolver selects an exact registry entry and applies allowlisted explicit overrides.
The fit evaluator subtracts target-session startup, design, and implementation-reserve costs from the resolved compaction threshold.
The fit evaluator compares the remaining repository read budget with the context plan's lower and upper estimates.
The slice code view is [context-plan.puml](../../../plans/repository-intelligence/context-planning/context-plan.puml).
The session-fit code view is [session-fit.puml](../../../plans/repository-intelligence/session-fit/session-fit.puml).
The provider-selection code view is [provider-selection.puml](../../../plans/repository-intelligence/provider-selection/provider-selection.puml).
The active-session capacity code view is [active-session-capacity.puml](../../../plans/repository-intelligence/active-session-capacity/active-session-capacity.puml).
The session trace code view is [session-consumption-tracing.puml](../../../plans/repository-intelligence/session-consumption-tracing/session-consumption-tracing.puml).

## Decision Log

2026-09-17: Proposed a provider-independent context planner with CodeNib as the first optional adapter.
2026-09-19: Added deterministic capacity resolution and session-lifecycle-neutral fit evaluation after the user approved implementation.
2026-09-19: Added a native baseline, provider composition, CodeGraph support, same-session capacity facts, and local pre-edit tracing.
