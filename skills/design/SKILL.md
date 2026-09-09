---
name: design
description: "Design an initiative or slice, split work that exceeds one delivery context, and prepare atomic slices for implementation."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Design an initiative or slice

Design turns Approved requirements into a technical design for an initiative or slice.
An initiative starts as one root slice and splits into smaller outcomes when it exceeds one delivery context.
The orchestrator repeats design for each child until every leaf is atomic.
An atomic slice delivers one observable outcome within the remaining context and risk budget of the task that designs and implements it.

- When orchestration returns findings, start at section 7 instead of section 1.

## 1. Prepare

1. Read `.prism/workflow.md`.
2. Use the [workflow terms](../workflow/SKILL.md#common-terms).
3. Read the initiative map, glossary, assigned Approved requirements, relevant ADRs, feature files, and current slice record.
4. Read the ancestor diagram source and ADRs supplied by orchestration before refining the current slice's design.

## 2. Explore

1. Locate the starting surface where the required behavior enters the system.
2. Search the repository, active artifacts, approved dependencies, and available semantic exploration tools for existing solutions, then record relevant matches and the reason to reuse or reject them before selecting a new component, dependency, or design approach.
3. When a semantic exploration tool is available, use it before text search for relevant symbols and call paths.
4. Inspect affected code, tests, boundaries, and dependency evidence until you can support a design and fit decision.
5. When a technical uncertainty affects that decision, investigate it with a bounded experiment.

Incomplete dependency implementation does not block design when available evidence supports a sound fit decision.

## 3. Form the technical design

1. Read [C4 code diagrams](references/c4-code-diagrams.md) before writing diagram source.
2. Create or update PlantUML source in the current slice folder, showing components and relationships needed to assess this scope.
3. Use existing architecture where it satisfies the requirements.
4. Use `write-adr` to record settled architectural decisions as Proposed ADRs, including shared decisions before atomic fit.
5. For applicable failure, recovery, compatibility, migration, security, and operational cases, annotate diagram elements with conditions, responses, and resulting states.
6. Link each annotation to its governing requirement or ADR.
7. When no ADR diagram covers required ordering or state transitions, add a supplementary diagram in the slice folder.

Large scopes can start with component views, while atomic slices require the referenced C4 code view.
Child designs settle finer decisions within inherited boundaries.
Parent diagrams remain in the parent slice folder as shared design input, while children author their own refined views.
Implementation owns private helpers and local data structures.

## 4. Check whether the scope is atomic

1. Check every assigned requirement against planned behavior and observable verification.
2. Check the design against code evidence, inherited decisions, and unresolved findings.
3. When requirements, decisions, evidence, or durable-source conflicts prevent sound design, return `BLOCKED` with the exact unresolved issue.
4. Confirm atomic fit only with settled consequential decisions and one end-to-end verification path covering a safe, complete outcome.

## 5. Prepare the next stage

Slice folders are flat under the initiative directory, and folder names identify slices.
The orchestrator manages parent relationships and dependencies in the initiative's `map.puml`.

- If the scope is not atomic:
  1. Group required behavior into smaller outcomes, each verifiable through a starting surface across all necessary layers.
  2. Create `<configured plans>/<initiative>/<child-slug>/` for each outcome, using a slug unique within the initiative.
  3. Write `slice.md` in each child folder using this shape:

     ```markdown
     # <Observable capability>

     ## Outcome

     <The observable result this slice must deliver.>

     ## Requirements

     - [Requirement reference](path/to/requirement.md#anchor)
     ```

  4. Check that child requirement references collectively equal the parent assignment, allowing shared references.
- If the scope is atomic:
  1. For each changed boundary, record a [contract decision](../review/SKILL.md#contracts), reusing governing types or schemas before invoking `write-contracts`.
  2. If the slice changes only documentation, select its verification command and record the red-checkpoint exemption.
  3. Otherwise:
     1. When the starting surface is absent, create the shape-only scaffold needed to test it.
     2. Create or update the smallest executable slice test through that surface.
     3. Run the test, confirming failure at the starting surface because required behavior is absent, not from setup defects.
  4. Use `write-feature` to create or update requirement-linked acceptance scenarios.
  5. Complete and validate the slice folder's C4 code diagram against the fitted design.
  6. When a slice needs a runbook before verification, create or update `<configured plans>/<initiative>/<slice>/runbook-draft.md` in the slice folder.

Design does not add production behavior or step definitions, change requirements, or mark findings `VERIFIED`.
Tests, contracts, scaffolds, and feature files require atomic fit.
Existing work remains preserved until the orchestrator accepts its disposition.
Finding evidence remains in its original lane file.

## 6. Return the result

1. Assemble exactly one status with the applicable evidence:
   - `SPLIT`: the unchanged parent title, parent diagram and ADR paths, and new child slice slugs with their folder paths.
   - `FIT`: the capability title, starting surface, artifact paths, contract decisions, verification command, and security surface or `none`.
   - `BLOCKED`: the unresolved question or missing evidence.
2. For `FIT`, include the red checkpoint's exact command, exit status, and expected failure reason, or the exemption reason.
3. When a findings path is assigned or resolved, include it for every status.
4. When discovery changes prerequisites, include the affected slices and supporting evidence for orchestration.
5. Return the result to end this invocation.

- Don't
  - Create a separate exploration or verification report when existing artifacts preserve the required facts.

An accepted split makes the parent non-executable.
The orchestrator owns lifecycle changes and the transition to implementation.
`FIT` proceeds to independent design audit, not directly to implementation.

## 7. Correct review findings

- When orchestration returns findings:
  1. Read `.prism/workflow.md`.
  2. Use its assigned findings path or `<configured plans>/<initiative>/<slice>/design-audit/findings.md`.
  3. Read [review-format.md](../review/references/review-format.md) and the complete findings file in the same delivery context.
  4. For each `OPEN`, `REOPENED`, or `IN PROGRESS` design finding:
     1. Mark it `IN PROGRESS`.
     2. Repeat affected design steps, including the fit check when the correction changes scope, boundaries, dependencies, or verification.
     3. When corrections require splitting, follow section 5's non-atomic branch before returning `SPLIT` through section 6.
     4. When a correction cannot proceed, return `BLOCKED` through section 6.
     5. Run affected checks and record closure evidence.
     6. When the closing condition is satisfied, mark it `FIXED`.
  5. Return the resulting status and findings path through section 6 after correcting all actionable design findings.

Implementation waits until the design audit is `CLEAN` and orchestration clears the implementation gate.
