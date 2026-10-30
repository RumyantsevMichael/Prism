---
name: implement
description: "Implement one planned slice of a designed initiative in a fresh session against its frozen contract and acceptance tests, commit each step, verify it through Prism, and return a short status."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Implement a slice

An implementation session receives one slice whose design is accepted and whose frozen tests are in place.
It works from files and the project's own tools, and its only Prism calls are `verify_slice` and `wait_for_user_gate`.

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
6. Run the slice's focused tests while you work.
7. Commit after each coherent step with a message that names the slice, unless orchestration said commits are off.

- Do
  - Add your own tests in other files when they help.
- Don't
  - Modify, rename, or delete a frozen test.
  - Change requirements or Accepted ADRs.

## 3. Verify

1. When the slice is complete, call `verify_slice` with the initiative and slice.
2. When it returns `approval_needed`, call `wait_for_user_gate` with its gate id, then call `verify_slice` again with `approvalGate` set to that id; when the gate has no answer, return `BLOCKED` with the gate id.
3. When it returns `running`, call it again with the same arguments.
4. When it fails, fix the failing tests from its log and verify again; after three failed runs, or when it returns `declined`, return `BLOCKED` with its message, the failing test names, and the log path.
5. When a contract clause is wrong, report it instead of working around it: call `verify_slice` with `contractDefects`, one entry per clause with why, and return `BLOCKED`.

A passing run of a slice whose review mark is `none` marks it done.

## 4. Return the status

Return only these fields, one line each:

```text
result: DONE | BLOCKED
commit: <last commit, or none>
summary: <one sentence on what changed>
questions: <exact questions, or none>
```
