# Slice review

Mode: implementation-review
Initiative: repository-intelligence
Slice: context-planning
Lane: implementation-review
Reporting slice: context-planning
Findings: docs/plans/repository-intelligence/context-planning/implementation-review/findings.md
Last updated: 2026-09-17T20:50:19+01:00
Review wave: implementation-closure-after-f005-2026-09-17

The findings file is authoritative for its reporting slice and lane.

## Findings

### F-001: CodeNib commit provenance uses the wrong manifest field

- Status: VERIFIED
- Severity: high
- Source: implementation-review
- Lane: implementation-review
- Reporting slice: context-planning
- Escalation target: context-planning
- First reported: implementation-review-2026-09-17
- Aliases: NONE
- Affected path: `server/codenib-provider.mjs:175-188`, `server/codenib-provider.mjs:245-246`, and `server/test/repository-intelligence.test.mjs:94-102`
- Evidence: CodeNib 0.2.3 returns the commit at `repo.commit`, but the adapter reads `payload.commit` and compares `this.manifest.commit`.
- Evidence: A healthy current CodeNib response therefore produces commit `unknown` and disables the search-to-manifest mismatch diagnostic.
- Evidence: The adapter test uses the non-current top-level `commit` shape, so it cannot detect this incompatibility.
- Condition to close: Normalize the current CodeNib manifest shape, preserve the real commit, compare search provenance against it, and test both success and mismatch.
- Review probe: Inline documented-shape probe returned `{ commit: "unknown" }` from `describe()` for `{ repo: { commit: "real-commit" } }`.
- Implementer evidence: `CodeNibRepositoryIntelligence.describe()` now reads `repo.commit`, stores normalized provenance, compares search provenance, and has success and mismatch tests.
- Status history:
  - implementation-review-2026-09-17: OPEN
  - implementation-correction-2026-09-17: IN PROGRESS
  - implementation-correction-2026-09-17: FIXED
  - implementation-rereview-2026-09-17: VERIFIED
- Review history:
  - implementation-review-2026-09-17: OPEN. The current adapter cannot produce the commit-bound plan required by the ADR.
  - implementation-rereview-2026-09-17: VERIFIED. `describe()` reads `repo.commit`, search compares `source.commit`, and the focused success and mismatch tests pass.

### F-002: Tool failures can become successful zero-context plans

- Status: VERIFIED
- Severity: blocker
- Source: implementation-review
- Lane: implementation-review
- Reporting slice: context-planning
- Escalation target: context-planning
- First reported: implementation-review-2026-09-17
- Aliases: NONE
- Affected path: `server/codenib-provider.mjs:6-18`, `server/codenib-provider.mjs:128-130`, and `server/codenib-provider.mjs:192-254`
- Evidence: `callTool()` does not reject an MCP `CallToolResult` with `isError: true`.
- Evidence: `search()` also accepts a structured `{ error: ... }` payload as an empty result and emits only `semantic_unavailable`.
- Evidence: The planner then returns lower, expected, and upper estimates of zero, which can support a false `FIT` decision.
- Condition to close: Reject MCP tool errors and unusable retrieval payloads, or return an explicit unusable-plan state that the fit policy cannot classify as `FIT`.
- Review probe: An inline provider probe with `{ error: "bm25 index not available" }` returned a successful zero-token plan.
- Implementer evidence: The MCP client rejects `isError`, the adapter rejects structured retrieval errors and unusable responses, and a regression test proves the error cannot produce a plan.
- Status history:
  - implementation-review-2026-09-17: OPEN
  - implementation-correction-2026-09-17: IN PROGRESS
  - implementation-correction-2026-09-17: FIXED
  - implementation-rereview-2026-09-17: VERIFIED
- Review history:
  - implementation-review-2026-09-17: OPEN. Provider failure violates the fail-closed behavior in the ADR and diagram.
  - implementation-rereview-2026-09-17: VERIFIED. The MCP client rejects `isError`, the adapter rejects retrieval errors and unusable search responses, and focused probes pass.

### F-003: Incomplete or invalid source context can still produce numeric estimates

- Status: VERIFIED
- Severity: high
- Source: implementation-review
- Lane: implementation-review
- Reporting slice: context-planning
- Escalation target: context-planning
- First reported: implementation-review-2026-09-17
- Aliases: NONE
- Affected path: `server/codenib-provider.mjs:21-39`, `server/codenib-provider.mjs:226-248`, `server/codenib-provider.mjs:251-333`, `server/codenib-provider.mjs:336-414`, and `server/repository-intelligence.mjs:21-45`, `server/repository-intelligence.mjs:182-207`
- Evidence: CodeNib graph and LSP tools return compact locations, so `sourceNode()` converts each location into a one-line source range.
- Evidence: An unresolved explicit file becomes a hard-coded range of lines 1 through 200, regardless of the file size.
- Evidence: The planner counts these shortened ranges as complete must-read or likely-read items without a missing-source amount.
- Evidence: A ranked result without `end_line` is normalized as a complete one-line range because `sourceNode()` defaults non-compact responses to complete.
- Evidence: An unresolved explicit symbol produces no required item and numeric lower, expected, and upper estimates of zero.
- Evidence: A source read that stops before the requested end silently replaces the selected range with the shorter response while retaining complete status.
- Evidence: The second correction now marks missing end lines, unresolved required symbols, and early-ending reads as incomplete, so those cases prevent numeric estimates.
- Evidence: `symbolIdentityMatches()` still treats `Other.Foo` as the exact requested symbol `Domain.Foo`, so ranked retrieval can suppress definition lookup and mark the wrong range as required context.
- Evidence: `completeNodeRange()` selects the nearest same-name range when no candidate contains the compact source line, so a location at line 30 resolves to a complete range at lines 48 through 60.
- Evidence: `read()` accepts `next_start_line: 50` after a response ending at line 20 and reports a complete lines 1 through 100 range, although lines 21 through 49 were never read.
- Evidence: The fourth correction handles qualified text stored in `node_name`, but CodeNib can return `node_name: "Foo"` with `qualified_name: "Other.Foo"`.
- Evidence: `hintReasons()` and the ranked-hit guard retry the comparison with the unqualified `node.name`, which marks `Other.Foo` as the explicit `Domain.Foo` reference and skips LSP lookup.
- Evidence: The fifth correction preserves the qualified identity for ranked hits and LSP filtering, but `completeNodeRange()` compares only unqualified display names.
- Evidence: A compact `Domain.Foo` LSP result at line 10 becomes a complete `Other.Foo` range at lines 9 through 18 when `search_regex` returns the same display name and file.
- Evidence: The sixth correction preserves qualified identity during compact range completion, but the planner removes it before graph expansion.
- Evidence: `neighbors()` then sends the unqualified display name `Foo` to CodeNib instead of the anchor identity `Domain.Foo`.
- Evidence: The seventh correction preserves qualified identity and signatures through the planner boundary for ranked anchors.
- Evidence: `completeNodeRange()` still replaces a compact LSP node with an unqualified `search_regex` candidate when their terminal names match.
- Evidence: This replacement removes `qualifiedName` and `signature`, sends `Foo` instead of `Domain.Foo` to graph expansion, and returns numeric estimates.
- Evidence: `sourceNode()` also marks an integer `end_line` as complete when it is less than `start_line`, then normalizes it to a one-line range.
- Evidence: A ranked range with lines 10 through 5 therefore becomes a complete line 10 anchor with numeric lower, expected, and upper estimates.
- Evidence: The eighth correction preserves compact identity metadata and marks inverted CodeNib ranges incomplete.
- Evidence: The provider-neutral `normalizeRange()` still repairs inverted, missing, zero, or otherwise invalid provider ranges without marking them incomplete.
- Evidence: An inline provider probe supplied lines 10 through 5 and received a complete line 10 item with numeric estimates of 2 tokens.
- Evidence: Missing-end, missing-start, and zero-start provider probes also returned complete normalized ranges with numeric estimates.
- Evidence: The planner replaces a requested range with any returned read range and treats an omitted `rangeComplete` as complete.
- Evidence: An inline provider probe requested lines 1 through 100 and returned lines 1 through 10 without `rangeComplete`, which produced a complete item and numeric estimates of 5 tokens.
- Evidence: A CodeNib result with only `end_line: 5` becomes a complete lines 1 through 5 node because `sourceNode()` invents the missing start line.
- Evidence: The tenth correction closes the provider-neutral completeness flag gap, but `CodeNibRepositoryIntelligence.read()` still accepts a verified response without `content`.
- Evidence: The adapter converts missing source to an empty string and counts the rendered metadata as a complete source response.
- Evidence: The adapter also accepts a different response file and different source commit and fingerprint when `source.verified` is true.
- Evidence: An end-to-end probe returned complete lines 1 through 10 and a numeric estimate of 56 tokens for missing content from the wrong file and source identity.
- Evidence: The eleventh correction rejects missing content and direct provenance mismatches, but it accepts an empty source string as complete content.
- Evidence: `describe()` accepts a manifest without a source fingerprint although the ADR requires verified source fingerprints.
- Evidence: A response with the requested `file` and a conflicting `file_path` passes because the adapter validates only the first truthy identity field.
- Evidence: Search responses can omit or mismatch their source commit and fingerprint while the planner still returns numeric estimates.
- Evidence: A mismatched search commit adds only `commit_mismatch`, so stale symbol ranges can still support a false `FIT` result.
- Evidence: The provider-neutral planner accepts a missing repository commit as `unknown` and returns numeric estimates despite the commit-bound plan contract.
- Evidence: The twelfth correction closes the recorded commit, fingerprint, search provenance, read identity, and empty-content gaps.
- Failure condition: The upper estimate can exclude most selected symbols or files, which can produce a false `FIT` result.
- Condition to close: Require a provider commit, a manifest fingerprint, nonempty source content, consistent file fields, and matching search and read provenance before numeric estimates.
- Review probe: Inline adapter and planner probes accepted empty content, a missing manifest fingerprint, conflicting file fields, missing or mismatched search provenance, and a missing provider commit.
- Implementer evidence: Every plan requires a concrete repository commit, CodeNib manifests require a source fingerprint, searches and reads require matching manifest-bound provenance, read path fields cannot conflict, empty content is rejected, and focused regression tests cover each path.
- Status history:
  - implementation-review-2026-09-17: OPEN
  - implementation-correction-2026-09-17: IN PROGRESS
  - implementation-correction-2026-09-17: FIXED
  - implementation-rereview-2026-09-17: REOPENED
  - implementation-correction-2-2026-09-17: IN PROGRESS
  - implementation-correction-2-2026-09-17: FIXED
  - implementation-rereview-2-2026-09-17: REOPENED
  - implementation-correction-3-2026-09-17: IN PROGRESS
  - implementation-correction-3-2026-09-17: FIXED
  - implementation-correction-4-2026-09-17: IN PROGRESS
  - implementation-correction-4-2026-09-17: FIXED
  - implementation-closure-review-2026-09-17: REOPENED
  - implementation-correction-5-2026-09-17: IN PROGRESS
  - implementation-correction-5-2026-09-17: FIXED
  - implementation-final-closure-review-2026-09-17: REOPENED
  - implementation-correction-6-2026-09-17: IN PROGRESS
  - implementation-correction-6-2026-09-17: FIXED
  - implementation-clean-review-2026-09-17: REOPENED
  - implementation-correction-7-2026-09-17: IN PROGRESS
  - implementation-correction-7-2026-09-17: FIXED
  - implementation-ultimate-closure-review-2026-09-17: REOPENED
  - implementation-correction-8-2026-09-17: IN PROGRESS
  - implementation-correction-8-2026-09-17: FIXED
  - implementation-provider-boundary-closure-review-2026-09-17: REOPENED
  - implementation-correction-9-2026-09-17: IN PROGRESS
  - implementation-correction-9-2026-09-17: FIXED
  - implementation-correction-10-2026-09-17: IN PROGRESS
  - implementation-correction-10-2026-09-17: FIXED
  - implementation-definitive-closure-review-2026-09-17: REOPENED
  - implementation-correction-11-2026-09-17: IN PROGRESS
  - implementation-correction-11-2026-09-17: FIXED
  - implementation-source-integrity-closure-review-2026-09-17: REOPENED
  - implementation-correction-12-2026-09-17: IN PROGRESS
  - implementation-correction-12-2026-09-17: FIXED
  - implementation-final-integrity-review-2026-09-17: VERIFIED
- Review history:
  - implementation-review-2026-09-17: OPEN. Bounded multi-window reads work, but their input ranges can already omit the selected context.
  - implementation-rereview-2026-09-17: REOPENED. The correction handles marked incomplete ranges but still treats three omitted-source paths as numerically complete.
  - implementation-rereview-2-2026-09-17: REOPENED. Qualified-name collisions, non-containing same-name matches, and discontinuous read windows still undercount required source.
  - implementation-closure-review-2026-09-17: REOPENED. The compact containment, source-gap, late-start, and LSP identity checks pass, but the normalized ranked-hit path discards a failed qualified comparison through its unqualified-name fallback.
  - implementation-final-closure-review-2026-09-17: REOPENED. Ranked identity and gap probes pass, but compact range completion can replace a qualified LSP result with a different qualified symbol.
  - implementation-clean-review-2026-09-17: REOPENED. Source identity and range probes pass, but end-to-end graph expansion drops the qualified anchor identity.
  - implementation-ultimate-closure-review-2026-09-17: REOPENED. LSP range completion discards identity metadata, and malformed ranked ranges can still produce numeric estimates.
  - implementation-provider-boundary-closure-review-2026-09-17: REOPENED. The adapter regressions pass, but the provider-neutral planner repairs malformed ranges and accepts uncovered reads as complete numeric context.
  - implementation-definitive-closure-review-2026-09-17: REOPENED. CodeNib source responses can omit content or identify another file and source while still producing complete numeric context.
  - implementation-source-integrity-closure-review-2026-09-17: REOPENED. Correction 11 passes its focused tests, but omitted and contradictory source identity still support numeric estimates.
  - implementation-final-integrity-review-2026-09-17: VERIFIED. The concrete commit, fingerprint, search provenance, read identity, content, and range closing conditions pass.

### F-004: Expected modification targets do not seed context discovery

- Status: VERIFIED
- Severity: high
- Source: implementation-review
- Lane: implementation-review
- Reporting slice: context-planning
- Escalation target: context-planning
- First reported: implementation-review-2026-09-17
- Aliases: NONE
- Affected path: `server/codenib-provider.mjs:40-43`, `server/codenib-provider.mjs:212-240`, and `server/mcp.mjs:211-212`
- Evidence: The public schema accepts `expectedModifiedFiles`, but the adapter only reads `files`, `symbols`, and `concepts`.
- Evidence: An expected primary implementation target disappears when ranked retrieval does not return it.
- Failure condition: The lower and upper estimates can omit the main file that implementation must read and change.
- Condition to close: Resolve every expected modification target as an explicit must-read anchor, report unresolved targets, and test a target absent from ranked search.
- Review probe: NONE
- Implementer evidence: Expected modification files now seed file resolution, retain an `expected-modification-target` reason, become must-read anchors, and have an absent-ranked-hit regression test.
- Status history:
  - implementation-review-2026-09-17: OPEN
  - implementation-correction-2026-09-17: IN PROGRESS
  - implementation-correction-2026-09-17: FIXED
  - implementation-rereview-2026-09-17: VERIFIED
- Review history:
  - implementation-review-2026-09-17: OPEN. The implemented seed policy does not cover all accepted task hints.
  - implementation-rereview-2026-09-17: VERIFIED. Expected modification files now seed must-read anchors, retain their reason, and degrade unresolved files to incomplete ranges with null estimates.

### F-005: Duplicate anchor identities demote required graph neighbors

- Status: VERIFIED
- Severity: medium
- Source: implementation-review
- Lane: implementation-review
- Reporting slice: context-planning
- Escalation target: context-planning
- First reported: implementation-final-integrity-review-2026-09-17
- Aliases: NONE
- Affected path: `server/repository-intelligence.mjs:161-187`
- Evidence: `anchorTiers.set()` lets a later duplicate anchor identity replace an earlier `mustRead` tier with `likelyRead`.
- Evidence: A `definition` neighbor from that identity then becomes `possibleRead` instead of `mustRead` and disappears from the lower estimate.
- Failure condition: Duplicate provider hits can violate the documented deterministic classification and omit required graph context from the pre-edit `mustRead` set.
- Condition to close: Preserve the strongest tier for each graph anchor identity and prove that duplicate ranked hits cannot demote required neighbors.
- Review probe: `server/test/repository-intelligence.test.mjs`, `node --test server/test/repository-intelligence.test.mjs`, expected the duplicate-anchor definition to remain `mustRead` but found it in `possibleRead`.
- Implementer evidence: The anchor tier map retains the strongest tier for each duplicate identity before graph classification, and the reviewer regression covers a duplicate ranked hit with a definition neighbor.
- Status history:
  - implementation-final-integrity-review-2026-09-17: OPEN
  - implementation-correction-13-2026-09-17: IN PROGRESS
  - implementation-correction-13-2026-09-17: FIXED
  - implementation-closure-after-f005-2026-09-17: VERIFIED
- Review history:
  - implementation-final-integrity-review-2026-09-17: OPEN. A duplicate ranked identity overwrites its stronger anchor tier before graph classification.
  - implementation-closure-after-f005-2026-09-17: VERIFIED. The strongest tier remains stable, and definition neighbors from duplicate anchors remain in `mustRead`.

## Result

Lane: implementation-review
Reporting slice: context-planning
Review focus: Provider abstraction, CodeNib lifecycle and normalization, conservative estimates, input safety, failure behavior, workflow integration, and tests.
Coverage: All current uncommitted changes except the pre-existing untracked `FINDINGS.md`.
Findings: docs/plans/repository-intelligence/context-planning/implementation-review/findings.md
Finding IDs: F-001, F-002, F-003, F-004, F-005
ADRs: docs/ADRs/repository-intelligence/provider-independent-context-planning.md
Executable tests: server/test/repository-intelligence.test.mjs, server/test/mcp.test.mjs, server/test/workflow-contract.test.mjs
Review probes: Inline identity, provenance, range, pagination, content, ranked identity, LSP completion, source-gap, and provider-commit probes.
Feature files: NONE
Other artifacts: docs/plans/repository-intelligence/context-planning/context-plan.puml, skills/design/references/context-planning.md, and the initiating user request.
Contracts: `server/mcp.mjs` tool schema and `server/repository-intelligence.mjs` provider boundary, consumed by the MCP server and workflow skills.
Diagrams: docs/plans/repository-intelligence/context-planning/context-plan.puml
Red checkpoint: NONE
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 59 tests after the sixth correction.
Verification: The compact qualified-identity regression preserves the incomplete `Domain.Foo` location when the only completion candidate is `Other.Foo`.
Verification: Independent probes passed for ranked and LSP identity shapes, compact completion, unqualified hints, short reads, source gaps, and late starts.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 60 tests after the seventh correction.
Verification: The graph expansion regression received `Domain.Foo` from the planner and CodeNib adapter.
Verification: An independent ranked-provider probe preserved `qualifiedName` and `signature` through the planner boundary.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 62 tests after the eighth correction.
Verification: Range completion preserves the compact symbol identity and signature, and inverted provider ranges remain incomplete.
Verification: `git diff --check` passed.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 62 tests after the eighth correction.
Verification: Qualified and unqualified identity, signature preservation, containment, graph seed propagation, source pagination gap, late-start, verified-source, and line-truncation probes passed.
Verification: Provider-neutral malformed-range and short-read probes returned numeric estimates, which reopens F-003.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 65 tests after the ninth correction.
Verification: Provider-neutral malformed node ranges, uncovered reads, and CodeNib results without a start line now remain incomplete and prevent numeric estimates.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 66 tests after the tenth correction.
Verification: A provider read without range metadata now requires `rangeComplete: true` to support numeric estimates.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 67 tests after the eleventh correction.
Verification: CodeNib reads now reject missing content, mismatched response files, and manifest-bound commit or fingerprint mismatches.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 70 tests after the twelfth correction.
Verification: Plans require a concrete commit, CodeNib requires a source fingerprint, search provenance must match, path fields cannot conflict, and empty source content is rejected.
Verification: The focused three-file suite passed 66 tests before the definitive review probe.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 71 tests after the duplicate-tier correction.
Verification: Duplicate anchor identities retain the strongest tier for graph-neighbor classification.
Verification: `node --test server/test/repository-intelligence.test.mjs` failed the new source-identity probe because the missing-content response did not reject.
Verification: Independent probes confirmed fail-closed behavior for malformed bounds, uncovered reads, completeness flags, identity propagation, pagination gaps, and unverified source.
Verification: An independent end-to-end probe accepted missing content from a different file and source provenance and returned a numeric estimate.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 67 tests after correction 11.
Verification: `git diff --check` passed after correction 11.
Verification: Independent probes accepted empty source content, an absent manifest fingerprint, conflicting response file fields, and absent or mismatched search provenance.
Verification: An independent provider-neutral probe returned commit `unknown` and numeric estimates when `describe()` omitted repository identity.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 70 tests after correction 12.
Verification: `git diff --check` passed before the final integrity review probe.
Verification: `node --test server/test/repository-intelligence.test.mjs` failed the duplicate-anchor graph-tier probe because the definition appeared in `possibleRead`.
Verification: `node --test server/test/repository-intelligence.test.mjs server/test/mcp.test.mjs server/test/workflow-contract.test.mjs` passed 71 tests after correction 13.
Verification: An independent graph-classification probe kept duplicate-anchor definitions in `mustRead`, callers in `likelyRead`, and unknown relations in `possibleRead`.
Verification: Independent inspection confirmed commit and fingerprint checks across manifest, search, and source reads.
Verification: Independent inspection confirmed qualified identity and signature propagation from retrieval through graph expansion.
Verification: `git diff --check` and syntax checks for all changed server modules passed.
Status: CLEAN
