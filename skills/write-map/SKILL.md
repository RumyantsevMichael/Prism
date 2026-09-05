---
name: write-map
description: "Maintain authoritative map.puml from accepted design proposals and lifecycle transitions when initiative topology, titles, dependencies, or status changes."
argument-hint: '[initiative]'
sdm: "0.3"
---

# Maintain an initiative map

This skill maintains the initiative's durable slice graph.
The orchestrator supplies an accepted design proposal or a permitted structural lifecycle update.
This skill does not explore the codebase or decide slice boundaries.

## 1. Prepare

1. Read `.prism/workflow.md`.
2. Read [map-format.md](references/map-format.md).
3. Read the existing map and accepted update.
4. For bootstrap, use the supplied root title and complete Approved requirement assignment.

- Don't
  - Infer a missing slice, requirement assignment, dependency, or approval.
  - Change `state.json`, findings, or phase evidence.
  - Create a `plan.md` file or another planning artifact.

## 2. Apply the accepted update

1. Prepare the accepted changes for `<configured plans>/<initiative>/map.puml`, preserving unrelated slices.
2. Preserve the exact accepted topology, title, requirement assignment, and structural status.
3. Validate the complete candidate with [validate-map.mjs](scripts/validate-map.mjs).
4. Compare root coverage with the Approved initiative requirements.
5. If the proposal conflicts with the current map, return the conflict to orchestration without choosing a design resolution.
6. Save the valid map.

## 3. Result

- Return `MAP UPDATED` with the map path, or the exact conflict that prevents the update.

The result contains no planning recommendation, fit judgment, or implementation work.
