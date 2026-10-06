# Repository intelligence

Prism can plan repository context and compare that plan with the capacity of a target implementation session.

## Choose a repository provider

Use `list_repository_intelligence_providers` to inspect the registered native, CodeGraph, and CodeNib providers for one project.
Discovery is read-only and never creates or updates an external index.

| Provider | Role | Numeric `FIT` |
|---|---|---|
| Native | Bundled local semantic, lexical, code, and document analysis with verified source | Yes, when all required evidence is complete |
| CodeGraph | Adds lexical and typed structural evidence from an existing index | No |
| CodeNib | Adds hybrid semantic, lexical, and graph evidence | Yes, when all required evidence is complete |

Use `provider: auto` with `plan_repository_context` for normal operation.
Automatic selection prepares bundled native analysis without invoking external indexers.
The first analysis downloads pinned runtime and model assets, then inference runs locally.
The default manifest contains published archives for all five supported platforms.
Prism verifies each downloaded archive against its pinned size and hash.
Subsequent analysis works offline when those verified assets remain cached.
Prism uses external evidence only after the adapter binds it to the same normalized source snapshot identity as native.
For CodeNib, this binding requires the same canonical project root, verified CodeNib source access, the same concrete commit, and a fresh complete native snapshot after CodeNib verifies its manifest.
CodeNib and native can use different private fingerprint schemes, so Prism does not compare those raw fingerprints.
Use `provider: native` to avoid every external executable.
Use `provider: codegraph` or `provider: codenib` when that exact contributor is required.
An unavailable explicit provider fails visibly instead of selecting another external provider.

```json
{
  "projectRoot": "/absolute/project",
  "provider": "auto",
  "task": "Add request validation.",
  "hints": {
    "files": ["src/service.mjs"],
    "symbols": ["handleRequest"],
    "concepts": ["validation policy"],
    "expectedModifiedFiles": ["src/service.mjs"]
  }
}
```

The native provider searches Git-tracked and nonignored text files when Git is available.
It uses a bounded filesystem scan outside Git repositories.
It records symbolic-link values within the native scan limits for freshness checks without following targets or exposing links as searchable source.
An enumerated path that is neither a regular file nor a symbolic link, such as a Git submodule path, makes the native scan incomplete.
An unsafe, aliased, or colliding Git path also makes the native scan incomplete.
Prism verifies the whole native snapshot before it returns a plan, so a change to an unselected source file also rejects the plan.
Native plans can support numeric `FIT` when semantic retrieval, applicable structure, source freshness, hints, and source ranges are complete.

CodeGraph requires an executable version greater than or equal to `1.6.0` and less than `1.7.0`.
CodeGraph also requires a complete current `.codegraph` index for the exact project root.
Prism uses CodeGraph lexical and symbol-graph evidence but does not claim that CodeGraph provides embedding-based semantic search.
Therefore, CodeGraph improves discovery but cannot support a numeric `FIT` result under the current policy.
Explicit CodeGraph selection never runs initialization, synchronization, or indexing commands against the external index.
Bundled native analysis runs the SDK against a private snapshot mirror and leaves the project's `.codegraph` and CodeNib indexes unchanged.
Prism caps CodeGraph context nodes, edges, entry points, and explicit symbol matches.
Evidence that reaches a cap without an affirmative completeness signal cannot support a numeric estimate.

CodeNib `0.2.3` remains optional and supplies hybrid and graph evidence when its required views and verified source are available.
Prism rejects a different CodeNib executable identity or version.
Native still supplies the final source rendered for token accounting.
Prism rejects unsafe external source paths and applies its own limits when CodeNib returns more search or hint-resolution results than requested.
Prism rejects POSIX absolute paths, Windows drive paths, Windows drive-relative paths, UNC paths, traversal paths, and paths outside the canonical project root.
CodeNib graph evidence cannot support a numeric estimate when seed or node limits bound it, when CodeNib reports a graph note or error, or when a graph source range remains incomplete.
Any caller concept that no contributor resolves prevents a numeric estimate.
When provider reads expand into overlapping ranges, Prism merges the ranges and counts the final merged rendering once.

### Search for reusable concepts

Before changing targets, call `capture_repository_snapshot` or reuse the caller's original baseline.
For before-change reuse searches, pass the returned `snapshotId` from the first `search_repository_concepts` request:

```json
{
  "projectRoot": "/absolute/project",
  "snapshotId": "<retained snapshot ID>",
  "query": "retry temporary network failures within a total deadline",
  "filters": {"domains": ["code", "configuration"]},
  "limit": 10
}
```

Domains are `code`, `instruction`, `documentation`, and `configuration`.
Optional path and kind filters restrict the candidate set.
Preparation still scans the eligible snapshot before applying these result filters.
Search defaults to ten results and permits at most fifty.
Each result identifies its path, selector, source range, source hash, and bounded excerpt.
Cosine similarity, lexical score, fused rank, model identity, and index revision have distinct meanings.
Similarity does not establish conceptual equivalence or approve an addition.

Native code structure covers JavaScript, TypeScript, Python, Go, Rust, Java, C#, C, and C++ through the pinned SDK.
Markdown sections and rules, JSON keys, and YAML keys have source locations and typed containment or reference relationships.
Unsupported constructs, missing dependencies, malformed files, unresolved links, and denied configuration reads are disclosed as incomplete structure.
Relevant incomplete structure prevents a numeric fit estimate.

If preparation exceeds ten seconds, search and planning return `preparing` with a stable preparation ID.
Call `get_repository_intelligence_status` with `projectRoot` and optional `waitMs` up to 30000, then repeat the original request.
Concurrent requests share preparation.
A `preparing` response is unfinished discovery, not an empty search result.
Keep the original `snapshotId` through retries and edits so new code cannot appear as preexisting reuse evidence.
Use `discover_repository_intelligence` for native runtime, model, index, and coverage status without starting downloads or preparation.

For live-source searches and context planning, pass a returned `snapshot` as `expectedSnapshot` to bind the source fingerprint.
This fingerprint differs from a retained evidence `snapshotId`.
On `stale_snapshot` during live-source discovery, repeat the search against current source and reassess the candidates.
Before-change discovery keeps its retained baseline instead of replacing it with current source.
On `corrupt_asset`, replace the affected private cache from the pinned release and retry.
On `unsupported_runtime` or `preparation_failed`, inspect the status diagnostic and retry after correcting the platform or download problem.
Degraded analysis supplies lexical results and explicitly withholds semantic fit eligibility.

Runtime archives include Node 24, so users do not need npm, Python, compilers, CodeNib, or a CodeGraph executable.
Assets, models, and indexes use the host plugin data directory when available, or the user's private Prism cache.
They are never stored in the target repository.
One helper runs per MCP server with two inference threads and exits after five idle minutes.
Native source limits remain 20,000 files, 64 MiB total, and 2 MiB per file.
Known omissions outside a managed change's scope limit coverage without blocking its affected-source gate.
Missing affected source and unknown omissions block that gate.
The SDK's stricter limits and omissions are reported independently of its completion flag.
The supported platforms are macOS and Linux on x64 and arm64, plus Windows x64.

### Prepare an external provider

Prepare external indexes outside Prism because provider discovery never changes them.

For CodeNib, install the supported release and prepare the project:

```bash
python -m pip install "codenib[graph,mcp]==0.2.3"
codenib codegraph init /absolute/project
```

For CodeGraph, install a compatible `1.6.x` release and create or synchronize the project `.codegraph` index with CodeGraph.
Set `PRISM_CODEGRAPH_COMMAND` when the CodeGraph executable is not on `PATH`.
Set `CodeNib command` in `.prism/workflow.md` when the CodeNib executable is not on the Prism MCP process `PATH`.
Set the project field to an absolute executable path without arguments, or use `n/a` to defer to the environment or default `PATH` lookup.
`PRISM_CODENIB_COMMAND` overrides the project field and may name a command on the Prism MCP process `PATH`.
The project field overrides the default `codenib` lookup when the environment variable is absent.
Prism reads this setting only from `.prism/workflow.md` under the requested project root and rejects a config file that resolves outside that root.

```markdown
## Repository intelligence
- CodeNib command: /absolute/path/to/codenib
```

Use `list_repository_intelligence_providers` to verify availability before planning.
For `not-installed`, fix the executable or command setting.
For `invalid-config`, set `CodeNib command` to an absolute executable path or `n/a`.
For `not-indexed`, `stale-index`, or `incomplete-index`, update the provider-owned index outside Prism.
For a snapshot mismatch, finish repository or index changes and retry planning.

## Resolve active session capacity

Use the read-only `resolve_session_capacity` tool with active mode when the target implementation session is the current Codex session.

```json
{
  "projectRoot": "/absolute/project",
  "session": {
    "mode": "active",
    "correlationKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "dataDirectory": "/absolute/plugin-data"
  }
}
```

Active resolution requires the bundled hooks in `hooks/hooks.json` to be enabled and trusted by the host.
Codex skips plugin hooks until the user reviews and trusts their current definition through `/hooks`.
After a Prism install or update, trust the current hook definition and start a new root Codex task.
Send the first prompt so Codex records the effective context window.
The first subsequent tool call refreshes Prism's active capacity facts.
After it stores a fact record successfully, the hook emits a SHA-256 session correlation key and absolute plugin data directory as bounded developer context.
Pass both exact values to active capacity, fit, and consumption requests.
The hook stores only hashed session and project identities plus allowlisted model and capacity facts in the plugin data directory.
It does not store prompts, source, commands, responses, credentials, or transcripts.
The raw session identifier never appears in additional context, MCP input, or persisted public output.
Fact cleanup runs during writes, removes records older than 30 days, and evicts the oldest eligible records by modification time and file name before the fact directory exceeds 16 MiB.

The Codex adapter reads the first bounded `session_meta` transcript record to correlate the session, canonical project root, root execution, CLI version, and model provider.
On `PreToolUse`, it also reads the latest record from a bounded 256 KiB transcript tail to obtain the effective `model_context_window` reported after the first model call.
It persists neither the transcript path nor transcript content.
The active model comes from the hook event.
Prism requests the effective layered Codex configuration for the event working directory through the local app-server and stores only allowlisted capacity values and provenance.
An explicit effective threshold and scope take precedence over a registry default.
When the effective configuration proves that no threshold override exists, Prism uses only the exact host version, provider, and model registry threshold policy.
An explicit context-window override uses that profile's reviewed default percentage after the transcript effective window is verified.
Missing, timed-out, malformed, or ambiguous effective configuration keeps capacity unsupported.
Prism rejects `body_after_prefix` accounting.
If correlated facts contain complete identity but no exact threshold, the caller may supply both capacity overrides and `compactionScope: "total"`.
Active override objects must contain both `contextWindowTokens` and `compactionThresholdTokens`.
Prism rejects partial objects instead of merging them with hook facts.
A stored `body_after_prefix` scope cannot be overridden by claiming `total`.

Active capacity returns `UNSUPPORTED` with a stable reason code when facts are absent, stale, associated with another key, cross-project, malformed, or do not prove exact total-scope capacity.
Using another valid key normally returns `NO_SESSION_FACTS` because storage is keyed by the digest.
Use explicit session input when the key or data directory does not appear, active evidence stays unsupported, or a different implementation session is the target.

## Summarize pre-edit consumption

Use `summarize_session_consumption` to inspect content-free observations from the same active host session.

```json
{
  "projectRoot": "/absolute/project",
  "correlationKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "dataDirectory": "/absolute/plugin-data"
}
```

Use the exact correlation key and plugin data directory that the enabled session hook adds to developer context.
The key identifies the active session without exposing its raw host session identifier, and Prism also requires the canonical project identity to match.
The bundled hooks observe supported searches, source reads, successful edits, failed edit attempts, tests, compaction, and session boundaries.
The trace stores hashed identities, relative source ranges, numeric counts, coverage, and provenance in the plugin data directory.
It never stores prompts, source text, commands, tool output, model responses, credentials, or transcripts.
Hook project roots are resolved to their canonical filesystem paths before trace identities are created.
Claude traces use canonical `CLAUDE_PROJECT_DIR` even when the hook working directory changes.
Codex traces use the canonical project root from the correlated transcript and never use the hook working directory as a substitute when correlation fails.

For Codex, Prism reads only the first bounded `session_meta` transcript record to classify the event as root or subagent execution.
The classifier reads at most 256 KiB and persists no transcript content.
Correlated transcript metadata identifies Codex before any Claude compatibility variable is considered.
Codex-specific markers without a root-correlated transcript fail closed, while a hook with no Codex marker can use canonical `CLAUDE_PROJECT_DIR` as positive Claude identity without `CLAUDE_VERSION`.
Subagent action details are excluded from the root trace and replaced with a content-free coverage gap.
An absent, malformed, or mismatched classification creates a coverage gap when the stable root identity remains known and otherwise the event is ignored instead of being merged into another trace.

The first successful edit closes the pre-edit window.
Failed edit attempts keep the window open.
For Codex, only a root-correlated exact `apply_patch` `PostToolUse` event under a reviewed trace behavior profile proves success.
The bundled trace behavior registry supports exact Codex versions `0.147.0` and `0.155.0-alpha.9.2` with provider `openai`.
Each profile records the exact tagged upstream source used to verify its lifecycle and response-shape contract in `src/server/session/session-trace-behavior-registry.json`.
Codex versions without an exact profile and unknown host edits remain attempts even when response fields look successful.
Claude `PostToolUse` events use the documented successful lifecycle after positive Claude project classification.
Tool classification uses exact built-in and explicit provider names instead of suffix matching.
When a tool exposes an edit path, its canonical resolution must stay beneath the stable project root.
Shell and unknown tools add coverage gaps because Prism does not inspect their command text.
When Codex omits a rendered token count for a supported read or search, Prism estimates tokens with the shared `utf8-bytes-divided-by-3` counter only when the exact behavior profile documents a model-facing string and that string is no larger than one mebibyte.
Only the numeric estimate is stored, and the summary remains partial because the estimate is not tokenizer-exact.
Prism does not serialize object responses for estimation.
If no bounded string count can be produced, the summary reports partial coverage and unavailable consumption instead of a false zero.
Events are ordered by occurrence time with stable tie breakers before the first edit and summary are derived, so delayed delivery cannot turn an observed pre-edit read into a false zero.
Trace cleanup runs during append, removes traces older than 30 days and owned stale temporary files, counts owned active temporary files, and evicts the oldest eligible trace files by modification time and file name before aggregate trace storage exceeds 64 MiB.
Trace storage rejects symbolic-link directories and records, rejects multiply linked records, and uses no-follow opens where supported.
Cleanup and commit use token-owned locks, reclaim an aged lock only when its matching process is confirmed dead, and fail an append that loses ownership before commit.
The summary is measurement evidence for future calibration and does not change the current deterministic fit formula.

## Evaluate repository fit

Use the read-only `evaluate_repository_fit` tool after `plan_repository_context` returns its token estimate.
Use `session.mode: active` for the same current session when active facts are available.
Supply the exact harness, harness version, provider, and model when the target is another session.
Supply the context already present in that session and the design context that implementation will receive.
Override the implementation reserve when the registered default does not fit the project workflow.

```json
{
  "session": {
    "harness": "codex-cli",
    "harnessVersion": "0.147.0",
    "provider": "openai",
    "model": "gpt-5.6-sol"
  },
  "costs": {
    "baseSessionContextTokens": 20000,
    "featureDesignContextTokens": 10000,
    "implementationReserveTokens": 90000
  },
  "tokenEstimate": {
    "lower": 140000,
    "expected": 145000,
    "upper": 150000
  }
}
```

The bundled registry supports only the exact Codex host, version, provider, and model tuples recorded in `src/server/session/session-capacity-registry.json`.
For the bundled 272000-token Codex profiles, the 95 percent usable input window is recorded separately from the default 90 percent automatic-compaction threshold of 244800 tokens.
Supply both capacity overrides for an unregistered host, provider, model, or version combination.
Prism returns `UNSUPPORTED` without a fit classification when neither path establishes exact capacity.

### Claude Code on AWS Bedrock

Claude Code on AWS Bedrock is supported today through explicit session input when the caller supplies the exact effective context window and compaction threshold.
This explicit path is separate from the verified Codex tuples in the bundled registry.
Prism does not claim an automatic bundled Bedrock tuple in this milestone.
The effective Claude Code threshold can depend on host settings and environment, including the auto-compact window or percentage, maximum output tokens, context-window override, and compaction-disable flags.
Supply the exact Claude Code version, Bedrock model identifier, both capacity values, and an explicit implementation reserve for fit evaluation.
Use this field template and replace every uppercase placeholder with the exact value from the target execution.

```text
session.harness = "claude-code"
session.harnessVersion = EXACT_CLAUDE_CODE_VERSION
session.provider = "aws-bedrock"
session.model = EXACT_BEDROCK_MODEL_IDENTIFIER
session.capacityOverrides.contextWindowTokens = EXACT_EFFECTIVE_CONTEXT_WINDOW_INTEGER
session.capacityOverrides.compactionThresholdTokens = EXACT_EFFECTIVE_COMPACTION_THRESHOLD_INTEGER
costs.implementationReserveTokens = EXPLICIT_IMPLEMENTATION_RESERVE_INTEGER
```

`FIT` means the upper estimate fits the repository read budget.
`SPLIT` means the lower estimate exceeds the repository read budget.
`UNCERTAIN` means the estimate overlaps the budget or contains unavailable bounds.
Inspect the returned provenance before accepting the decision.
