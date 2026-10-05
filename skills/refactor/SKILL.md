---
name: refactor
description: "Analyze or restructure existing code, skills, specifications, documentation, and configuration when a caller requests refactoring, reuse analysis, generalization, or text convergence."
argument-hint: '[target or repository scope]'
sdm: "0.3"
---

# Refactor existing concepts

Refactoring derives a better conceptual structure from existing artifacts and current requirements.
It preserves observable behavior by default, including contracts, skill behavior, policy meaning, and configuration semantics.
Humans, orchestrators, design, implementation, and other capabilities can call this skill.
Analysis and transformation share the same reasoning procedure.
The [workflow terms](../workflow/SKILL.md#common-terms) define semantic concepts, candidate relationships, desired conceptual models, resynthesis, and complexity deltas.

## 1. Establish scope and authority

1. If `.prism/workflow.md` exists, read it first.
2. Read applicable project instructions, governing requirements, decisions, and the caller's supplied evidence.
3. Identify the target concepts, discovery scope, permitted edits, and intended result from the request.
4. For an analysis request, return recommendations without changing target artifacts.
5. For an authorized transformation, preserve the initial source and available behavior evidence before edits.
6. Reuse the caller's original baseline, or capture a retained repository snapshot when that capability is available.
7. For a managed slice, follow [source evidence](../design/references/concept-delta.md#capture-source-evidence) and its existing gates.

A focused invocation can inspect related consumers without authorizing changes to them.
A repository-wide discovery request does not authorize a repository-wide rewrite.
Outside a managed slice, retained source and verification evidence do not require new coordination artifacts or workflow initialization.

## 2. Discover candidates

1. Reuse the caller's repository context and Prism repository intelligence for semantic discovery across applicable artifact types.
2. Follow [before-change discovery](references/analysis.md#before-change-discovery) to bind reuse searches to the original baseline.
3. Search by behavior and shared knowledge, including concepts with different names, locations, structures, or implementations.
4. Inspect candidate source and available callers, dependencies, contracts, state, tests, references, and ownership.
5. Use the [candidate signals and ranking](references/analysis.md#candidate-signals-and-ranking) to select a bounded investigation.
6. When semantic indexing is unavailable or incomplete, report its coverage limits and use available structural and text evidence.
7. For managed additions, follow the [semantic reuse procedure](../design/references/concept-delta.md#semantic-reuse-search) before accepting `ADD`.

Semantic similarity and design red flags identify candidates for investigation, not defects or equivalent concepts.
Files, symbols, rules, sections, schemas, and paragraphs are evidence of concepts, not fixed conceptual boundaries.
One concept can span several structural units, and one unit can contain several concepts.
This capability reuses repository indexes instead of creating another indexing system.
Fallback discovery does not satisfy a managed slice's required semantic evidence.

## 3. Derive the desired model

1. Read the [relationship reasoning](references/analysis.md#relationship-reasoning) guidance.
2. Classify why each investigated candidate appears related before selecting a transformation.
3. Separate required domain distinctions from distinctions caused by implementation history.
4. Identify duplicated knowledge, its appropriate owner, and details that consumers should not need to know.
5. Describe the structure that would fit if current requirements and knowledge had existed from the start.
6. Compare retention, existing abstractions, and proposed abstractions against that model.
7. Select a transformation only when its conceptual benefit justifies its interface, dependency, state, and maintenance costs.
8. Record relevant matches and the reason to reuse or reject them.
9. For mutable text and declarative artifacts, explicitly consider resynthesis from their combined semantic requirements.
10. If an improvement exceeds authority, return its evidence and required decision before applying that transformation.

Possible transformations include retention, modification, merge, replacement, deletion, inlining, generalization, specialization, responsibility moves, renaming, resynthesis, and boundary changes.
Fewer lines, files, classes, functions, rules, or concepts do not independently establish improvement.
More decomposition, less duplication, or a new shared abstraction do not independently establish improvement either.
General interfaces cover current use cases without speculative mechanisms for hypothetical needs.
New abstractions can be useful when they hide complexity or reduce consumer knowledge, specialization, leakage, or coupling.

Requirement changes, behavior changes, unresolved domain distinctions, and architectural decisions outside authority belong to the caller.
This skill reports those conditions without assuming design or product ownership.
Design owns the intended `KEEP`, `MODIFY`, `REPLACE`, `DELETE`, and `ADD` transitions for requested behavior.
Implementation retains the accepted design and returns material deviations for design revision and audit.

## 4. Transform and verify

1. For analysis only, report the proposed transformation and verification plan, then return without applying changes.
2. For an authorized transformation, record relevant deterministic baseline measurements using [complexity evidence](references/analysis.md#complexity-evidence).
3. Restructure the bounded target according to the desired model.
4. Compare observable behavior against the retained baseline using applicable tests, contracts, static checks, or obligation review.
5. For resynthesized text, map each original obligation to its resulting source and compare its conditions, exceptions, and authority.
6. Repeat the same measurements over comparable final source and scope.
7. Assess the independent complexity dimensions and behavior evidence together.
8. If verification reveals changed behavior, correct the transformation or return the discrepancy before claiming preservation.
9. For managed slices, return source references and checks for the caller's [comparison and convergence evidence](../design/references/concept-delta.md#compare-and-measure).

Existing tests, acceptance checks, and characterization evidence can support equivalence.
Executable proof is not mandatory for every artifact.
Missing evidence remains explicit uncertainty, and known failures remain failures.
Small strategic changes and larger targeted cleanups use this same procedure.

## 5. Return evidence

1. Return the applicable [result fields](references/analysis.md#result-fields), distinguishing proposals from completed changes.
2. State remaining uncertainty, discovery coverage, deferred candidates, and any decision required from the caller.
3. Reuse caller-owned evidence records when persistence is needed across contexts.

A result can recommend keeping concepts distinct or making no change.
A standalone result does not require a new report file.
Review uses the shared [review criteria](references/analysis.md#review-criteria) to assess conceptual improvement and behavior preservation.
