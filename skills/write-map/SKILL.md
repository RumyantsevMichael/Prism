---
name: write-map
description: "Maintain authoritative map.puml from accepted design proposals and lifecycle transitions when initiative topology, titles, dependencies, or status changes."
argument-hint: '[initiative]'
sdm: "0.3"
---

# Apply an initiative map update

The orchestrator owns topology and dependencies.
This skill does not explore code or choose slice boundaries.

## 1. Prepare

1. Read `.prism/workflow.md`.
2. Read [map-format.md](references/map-format.md).
3. Read the supplied update, including acceptance evidence when required.
4. If the map exists, read it.
5. For bootstrap, use the supplied root title and complete Approved requirement assignment.
6. If an input or required acceptance is missing, return the missing input without inferring it.

## 2. Apply and validate

1. Prepare the candidate for `<configured plans>/<initiative>/map.puml`, preserving unrelated slices.
2. Apply the supplied titles, parent relationships, requirement assignments, dependencies, and structural statuses exactly.
3. If the update conflicts with the current map, return the conflict to orchestration without choosing a resolution.
4. Validate the complete candidate with [validate-map.mjs](scripts/validate-map.mjs).
5. Compare root coverage with the Approved initiative requirements.
6. If validation or coverage fails, return the defect without replacing the map.
7. Save the valid candidate as the initiative map.
8. Return `MAP UPDATED` with its path.

This skill changes no coordination notes, findings, phase evidence, or additional planning artifacts.
