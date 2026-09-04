---
name: write-step-definitions
description: "Connect design-authored Gherkin feature steps to executable assertions during implementation."
sdm: "0.3"
---

# Write step definitions

This skill applies during implementation after a design-authored feature file exists.
Step definitions connect durable domain language to the existing executable acceptance suite.

## 1. Prepare

1. If `.prism/workflow.md` exists, read it first.
2. Read the feature file and its linked requirements.
3. Read the executable tests and selected production surface.
4. Read existing test helpers.
5. When the workflow marks feature files as specification-only:
   1. Preserve the feature file as the acceptance specification.
   2. Do not add a BDD harness.
6. Otherwise:
   1. Use the configured BDD harness.
   2. Bind the feature steps by following [Bind the steps](#2-bind-the-steps).
7. Verify the acceptance path by following [Verify](#3-verify).
8. Return to the calling implementation phase after verification finishes.

## 2. Bind the steps

- Reuse an existing step definition when its domain meaning is identical.
- Keep implementation details inside step definitions and test helpers.
- Use one typed state object for each scenario.
- Initialize the state object before each scenario.
- Bind each `Given` step through a product interface or existing test fixture.
- Bind the single `When` step to the user or system action.
- Bind each `Then` step to the minimum assertion that proves its observable claim.
- Put reusable drivers, fakes, and spies in the existing shared test-helper location.
- Let unexpected errors fail the scenario.

- Don't
  - Add implementation details to feature files.
  - Use mutable module-level state.
  - Add assertions that the Gherkin step does not imply.
  - Duplicate a shared helper in a feature-specific file.

## 3. Verify

1. Run the configured acceptance command.
2. If the command fails, record only the command, exit status, and a short failure summary.
3. Before production behavior exists, confirm that a red result names the expected missing behavior.
4. When feature files are not specification-only, after implementation confirm that every feature step is bound.
5. Finish only when the acceptance suite passes.
