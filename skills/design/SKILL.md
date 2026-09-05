---
name: design
description: "Transform one Approved outcome slice into a bounded architecture, confirm that it fits one delivery context, and settle consequential decisions before implementation."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Design and confirm a slice

This skill transforms Approved requirements into the architecture for one outcome slice.
The same delivery task keeps the design context for implementation unless orchestration replaces it after a failure.

## 1. Prepare

1. Read `.prism/workflow.md`.
2. Use the definitions for [Approved requirement](../workflow/SKILL.md#common-terms), [slice](../workflow/SKILL.md#common-terms), [delivery context](../workflow/SKILL.md#common-terms), [starting surface](../workflow/SKILL.md#common-terms), [fit checkpoint](../workflow/SKILL.md#common-terms), and [orchestrator](../workflow/SKILL.md#common-terms).
3. Use the definitions for [Proposed ADR](../workflow/SKILL.md#common-terms), [executable contract](../workflow/SKILL.md#common-terms), [executable slice test](../workflow/SKILL.md#common-terms), [feature file](../workflow/SKILL.md#common-terms), [shape-only scaffold](../workflow/SKILL.md#common-terms), [red checkpoint](../workflow/SKILL.md#common-terms), and [security surface](../workflow/SKILL.md#common-terms).
4. Read the glossary, relevant Approved requirements, relevant ADRs, relevant feature files, and the slice record when present.
5. When orchestration supplies a findings path, use that path.
6. When no findings path is supplied and the slice has initiative state, use `<configured plans>/<initiative>/<slice>/findings.md`.
7. When the slice has a findings path, read the file and keep all unresolved entries in scope.
8. When project rules require delegated exploration, read [delegation.md](../workflow/references/delegation.md) before delegating exploration.
9. After context compaction or replacement, re-read the requirements, ADRs, executable tests, contracts, and findings before continuing.

## 2. Explore the slice

- Find the command, route, public function, event handler, scheduled job, or user action where the required behavior starts.
- Inspect the code that receives input, changes relevant state, crosses affected boundaries, and produces the observable result.
- Inspect tests for changed components and direct consumers whose behavior or compatibility can change.
- Identify existing extension points, invariants, verification commands, and security boundaries.
- When dependencies are incomplete, inspect their accepted outcomes and available design evidence before deciding whether discovery can continue.
- When missing dependency evidence prevents a sound fit decision, return `BLOCKED` with the exact missing evidence.
- When practical, test an uncertain technical claim with a bounded executable investigation.
- Stop after identifying the changed components, affected boundaries, test location, and end-to-end verification command.
- Expand the search only when an unresolved architecture question needs more evidence.
- Pass paths and focused questions through delegated exploration instead of returning large source excerpts.

- Don't
  - Scan the repository or read complete directories for general understanding.

## 3. Run the fit checkpoint

### 3.1. Form the slice architecture

- Map each applicable Approved requirement statement to the code or boundary that will satisfy it.
- Give the slice a concise human-readable title that names its observable capability.
- Choose the starting surface, owning component, data flow, and state changes.
- Define applicable failure, recovery, compatibility, migration, security, and operational behavior.
- Identify each machine-readable contract that production code or verification must consume.
- For each changed boundary, choose an existing governing type or schema or plan a new executable contract and its consumers.
- Identify the smallest executable slice test through the starting surface and the result or failure it must observe.
- Identify the Gherkin feature path through `write-feature` and its requirement-linked scenarios.
- When the starting surface does not exist, decide whether a shape-only scaffold is required.
- Prefer existing architecture and extension points when they satisfy the requirements.

Before the fit checkpoint, new slice-scoped artifacts remain in the working design and are not written.
These artifacts include ADRs, feature files, executable tests, contracts, diagrams, and scaffolds.
Existing artifacts from an earlier fitted design remain preserved when the slice returns to design.

- Don't
  - Create a prose design summary, slice-named design file, task graph, or handoff.

### 3.2. Run the author preflight

- Trace every Approved requirement to a planned behavior, affected boundary, feature scenario, executable test, and verification command.
- Challenge normal, failure, recovery, lifecycle, compatibility, security, and operational behavior for every changed path.
- Confirm that every consequential decision is settled.
- Confirm that the slice has one complete end-to-end verification path.
- When a design finding is `OPEN` or `REOPENED`, complete this lifecycle before returning `FIT`:
  1. Mark the finding `IN PROGRESS`.
  2. Correct the finding.
  3. Mark the finding `FIXED` and add evidence.

- Don't
  - Mark a finding `VERIFIED` from the delivery context.

### 3.3. Confirm fit

- Confirm the proposed architecture against actual code evidence.
- When discovery changes a leaf's dependencies, propose a dependency amendment with previous dependencies, replacement dependencies, and evidence for each change.
- Return the amendment with `FIT` when the outcome still fits without child slices.
- Pause implementation until orchestration accepts the amendment and repeats the required gates.

The slice fits only when all these properties are true:

| Property | Required fit |
| --- | --- |
| Outcome | The slice has one observable outcome. |
| Change path | The changes form one connected path from the initiating input to that outcome. |
| Boundaries | The boundaries and compatibility effects are identified. |
| Decisions | No consequential architectural decision remains unresolved. |
| Verification | The slice has one end-to-end verification path. |
| Safety | Every changed path has a safe complete state. |
| Dependencies | Dependency behavior is sufficiently defined for design, with implementation availability checked by orchestration. |
| Delivery | The slice fits the remaining context and risk budget. |

- When the slice does not fit:
  1. Divide it into smaller vertical outcomes.
  2. Return proposed child slices with only the seven fields below.
  3. Return `SPLIT` or `BLOCKED` without authoring slice-scoped artifacts.

- Don't
  - Add architecture, contracts, task lists, or implementation instructions to child slice records.
  - Edit `state.json` or `map.puml`.

The orchestrator routes the split under the run autonomy setting, records acceptance, and runs `write-map` to apply the exact proposal.

- When work already exists, assign its code, artifacts, and unresolved findings to the proposed children.
- Identify shared artifacts and their writer so child work does not conflict.
- Preserve existing work and evidence until orchestration accepts its disposition.

## 4. Record decisions and author the fitted slice

### 4.1. Record settled decisions

- When a requirement is missing or must change, return `BLOCKED` with the exact question for the user.
- When the fit checkpoint passes:
  1. Use `write-adr` to record each settled decision that constrains future changes or explains a lasting boundary.
  2. Record each such decision as a Proposed ADR.
- When a consequential decision becomes unsettled, return `BLOCKED` before writing the remaining slice artifacts.
- Leave private helper names, local data structures, and other code-level choices to implementation.

- Don't
  - Edit a requirement or invoke `write-requirements` without explicit user approval.
  - Create a separate artifact for code-level choices.

### 4.2. Author the fitted artifacts

1. Author slice-scoped artifacts only after fit passes.
2. For each boundary needing a new executable contract, use `write-contracts` to create it in the canonical project-owned path.
3. Bind each new contract to its production or verification consumer before implementation.
4. When the selected starting surface does not exist, create only a shape-only scaffold for it.
5. Create or update the smallest executable slice test through the selected starting surface.
6. Create or update the slice Gherkin feature file through `write-feature`.
7. Run each design-created executable slice test before implementation.
8. Record the exact command and expected failure reason for each red checkpoint.
9. When relationships, lifecycle, or call order are part of the decision, add an ADR decision diagram.
10. Identify the security surface as `none` or a short list of trust boundaries for reviewer routing.

- Don't
  - Add production behavior during design.
  - Add a concrete stub that makes the design test pass.
  - Create step definitions during design.

## 5. Result

Each result has exactly one status with this meaning:

| Status | Meaning |
| --- | --- |
| `FIT` | The proposed architecture fits one delivery context. |
| `SPLIT` | The result includes proposed child slice records for acceptance and orchestration. |
| `BLOCKED` | The result identifies the unresolved requirement, decision, or dependency. |

- Return one compact result that starts with exactly one status.

- For `FIT`, return every field in this block:

```text
Title: <concise observable capability>
Starting surface: <command, route, public function, event, job, or user action>
Done signal: <one executable command or end-to-end observation>
Dependency amendment: <leaf, previous dependencies, replacement dependencies, evidence, or NONE>
ADRs: <Proposed ADR paths or NONE>
Executable tests: <canonical test paths or NONE>
Feature files: <canonical feature paths or NONE>
Diagrams: <ADR diagram paths or NONE>
Red checkpoint: <exact command and expected failure reason or NONE>
```

- For `FIT`, also return exactly one contract decision block for each changed boundary in one of these forms:

```text
Contract: <canonical path>
Consumers: <production code or verification>
Verification: <exact command>
```

```text
Contract: NO CONTRACT NEEDED
Reason: <specific reason>
```

- When orchestration supplies a findings path, return `Findings: <slice findings path>` for every status.
- For `SPLIT`, return one proposed child record for each replacement slice in this exact form:

```text
Child: <slice slug>
Title: <concise observable capability>
Outcome: <one observable result>
Requirements: <Approved requirement statement references assigned to this child>
Dependencies: <child or existing slice slugs>
Starting surface: <command, route, public function, event, job, or user action>
Done signal: <one executable command or end-to-end observation>
```

- For `SPLIT`, state that the current slice becomes a non-executable parent when the split is accepted.
- Assign every parent requirement to at least one child without adding requirements outside the parent assignment.
- For an initial `SPLIT` or `BLOCKED`, do not return new slice-scoped design artifact paths.
- For a late `SPLIT`, include the existing work paths and proposed child ownership separately from the child records.
- Preserve the parent's accepted title when proposing a split.

- Don't
  - Repeat the explored code or reasoning in the status.

The design context owns the fit judgment and child proposal.
The orchestrator owns acceptance, lifecycle changes, and the transition to implementation.
