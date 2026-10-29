---
name: implement
description: "Implement one planned slice of a designed initiative in a fresh session against its frozen contract and acceptance tests, commit each step, and return a short status."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Implement a slice

An implementation session receives one slice whose design is accepted and whose frozen tests are in place.
It works from files and the project's own tools and makes no Prism record calls.

## 1. Prepare

1. Read `.prism/workflow.md` and the project instructions.
2. Read the contract's `slice.md`: its **Contract** wins wherever it differs from the requirements wording, and its **Assumptions** record what was verified about the system.
3. Read the slice's own `slice.md` and its frozen tests.
4. Read the assigned Approved requirements and the ADRs that the contract links.
5. When orchestration supplies failing test names, a verification log, or review findings, read them before you change code.

## 2. Implement

1. Implement the whole slice; the slices it depends on are already done.
2. Keep the interfaces that the contract says later slices rely on.
3. Make the slice's frozen tests pass without breaking tests that already pass.
4. When features have a BDD harness, use `write-step-definitions` to bind their steps.
5. When user-visible behavior changes, use `write-user-docs`.
6. Run the project's test command and the slice's focused tests.
7. Commit after each coherent step with a message that names the slice, unless orchestration said commits are off.

- Do
  - Add your own tests in other files when they help.
- Don't
  - Modify, rename, or delete a frozen test.
  - Change requirements or Accepted ADRs.

A contract defect goes back to design, so report it instead of working around it.

## 3. Return the status

Return only these fields, one line each:

```text
result: DONE | BLOCKED
commit: <last commit, or none>
summary: <one sentence on what changed>
contract defects: <clause numbers and why, or none>
questions: <exact questions, or none>
```
