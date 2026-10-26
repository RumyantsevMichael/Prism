---
name: implement
description: "Implement one step of a designed slice in a fresh session against its frozen contract and acceptance tests, then commit and report."
argument-hint: '[initiative/slice [step]]'
sdm: "0.3"
---

# Implement a designed slice

An implementation session receives a designed slice, and a step number when its design lists steps.
It works from files and the project's own tools and makes no Prism record calls.

## 1. Prepare

1. Read `.prism/workflow.md` and the project instructions.
2. Read the slice's `slice.md`: its **Contract** wins wherever it differs from the requirements wording, and its **Assumptions** record what was verified about the system.
3. Read the assigned Approved requirements and the ADRs that `slice.md` links.
4. When orchestration supplies failing verification output or review findings, read them before you change code.

## 2. Implement

1. Implement only the assigned step, or the whole slice when the design lists no steps; earlier steps are already committed.
2. Keep the shared interfaces that **Steps** names, since later steps rely on them.
3. Make the acceptance tests assigned to the step pass without breaking tests that already pass.
4. When features have a BDD harness, use `write-step-definitions` to bind their steps.
5. When user-visible behavior changes, use `write-user-docs`.
6. Run the project's test command and the focused tests for the step.

- Do
  - Add your own tests in other files when they help.
- Don't
  - Modify, rename, or delete a frozen test.
  - Change requirements or Accepted ADRs.

## 3. Finish

1. Commit the step's changes with a message that names the slice and step, unless orchestration said commits are off.
2. Report `DONE` with the changed paths and the test results, or `BLOCKED` with evidence when the contract, an assumption, a frozen test, or a review finding is wrong or cannot be satisfied, or when two findings conflict.

A contract defect goes back to design, so report it instead of working around it.
