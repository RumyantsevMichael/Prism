---
name: write-step-definitions
description: "Connect design-authored Gherkin feature steps to executable assertions during implementation."
sdm: "0.3"
---

# Bind feature steps to executable acceptance

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the [feature file](../workflow/SKILL.md#common-terms), linked requirements, selected production surface, executable tests, and existing helpers.

## 2. Connect the acceptance path

- If features are specification-only, preserve them as acceptance specifications without adding a BDD harness.
- Otherwise:
  1. Use the configured BDD harness.
  2. Reuse bindings with identical domain meaning.
  3. Initialize one typed state object per scenario.
  4. Bind Given through product interfaces or existing fixtures.
  5. Bind When to the selected user or system action.
  6. Bind Then to the minimum assertion proving its claim.
  7. Put reusable drivers, fakes, and spies in the existing shared helper location.

Bindings keep implementation details out of features and use no mutable module-level scenario state.
Unexpected errors fail the scenario.
Assertions preserve the feature's claims without adding behavior.

## 3. Verify for the calling phase

1. Run the configured acceptance command, or the selected executable tests for specification-only features.
2. If bindings or test setup fail, correct them before assessing product behavior.
3. If the caller needs a red checkpoint, confirm failure at the selected surface because required behavior is absent.
4. If the caller needs implementation verification:
   1. Require passing acceptance tests.
   2. Unless features are specification-only, require every feature step bound.
5. If the expected phase result is unavailable, return the exact failure to the caller without changing feature intent.
6. Return changed paths, command, exit status, and a short result summary to the calling phase.
