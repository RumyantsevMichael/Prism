---
name: write-step-definitions
description: "Connect design-authored Gherkin feature steps to executable assertions during implementation."
---

# Write step definitions

Use this skill during implementation after a design-authored feature file exists.
Step definitions connect durable domain language to the existing executable acceptance suite.

Read `.prism/workflow.md` first when it exists.
Read the feature file, linked requirements, executable tests, the selected production surface, and existing test helpers.
Use the configured BDD harness.
Do not add a BDD harness when the workflow marks feature files as specification-only.

## Bind the steps

Reuse an existing step definition when its domain meaning is identical.
Use implementation details only inside step definitions and test helpers.
Keep feature files free of those details.

Use one typed state object for each scenario.
Initialize it before each scenario.
Do not use mutable module-level state.

Bind `Given` steps to setup through a product interface or an existing test fixture.
Bind the single `When` step to the user or system action.
Bind each `Then` step to the minimum assertion that proves its observable claim.
Do not add assertions that the Gherkin step does not imply.

Put reusable drivers, fakes, and spies in the existing shared test-helper location.
Do not duplicate a helper in a feature-specific file.
Let unexpected errors fail the scenario.

## Verify

Run the configured acceptance command.
Record only the command, exit status, and a short failure summary when it fails.
During implementation, a red result is expected before production behavior exists and must name the expected failure.
After production behavior is implemented, finish only when every feature step is bound and the acceptance suite passes.
