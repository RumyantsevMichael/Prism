---
name: implement
description: "Implement one planned slice of a designed initiative in a fresh session against its frozen contract and acceptance tests, commit each step, verify it through Prism, and return a short status."
argument-hint: '[initiative/slice]'
sdm: "0.3"
---

# Implement a slice

An implementation session receives one slice whose design is accepted and whose frozen tests are in place.
It works from files and the project's own tools, and its only Prism calls are `verify_slice` and `wait_for_user_gate`, apart from `get_artifact`, through which it reads `slice.md` files, requirements, and ADRs as [store artifacts](../workflow/SKILL.md#common-terms) in a project with a store.

## 1. Prepare

1. Read `.prism/workflow.md` and the project instructions.
2. Read the contract's `slice.md`: its **Contract** wins wherever it differs from the requirements wording, and its **Assumptions** record what was verified about the system.
3. Read the slice's own `slice.md` and its frozen tests.
4. Read the assigned Approved requirements and the ADRs that the contract links, and cite a shipped initiative's contracts, slice documents, frozen tests, and reviews only as history, because current intent lives only in Approved requirements, Accepted ADRs, the glossary, and feature files.
5. When orchestration supplies failing test names, a verification log, or review findings, read them before you change code.

## 2. Implement

1. Implement the whole slice; the slices it depends on are already done.
2. Keep the interfaces that the contract says later slices rely on.
3. Make the slice's frozen tests pass without breaking tests that already pass.
4. When features have a BDD harness, use `write-step-definitions` to bind their steps.
5. When user-visible behavior changes, use `write-user-docs`.
6. Run the slice's focused tests while you work, and add your own tests in other files when they help, giving each file that no design named a [portable name](../workflow/SKILL.md#common-terms).
7. Commit after each coherent step with a message that names the slice, unless orchestration said commits are off.

- Don't
  - Modify, rename, or delete a frozen test, unless your slice is a fix of the slice that owns it and its **Changes** names the file.
  - Change requirements or Accepted ADRs.

## 3. Verify

1. When the slice is complete, call `verify_slice` with the initiative and slice, and when your brief gives an approval gate with the user's quoted chat answer, pass them as `approvalGate` and `chatApproval`.
2. When it returns `approval_needed` with `chatApproval`, return `BLOCKED` with the gate id, the command and its folder, and that it needs the user's chat approval; when it returns `approval_needed` without it, call `wait_for_user_gate` with its gate id, then call `verify_slice` again with `approvalGate` set to that id, and when the gate has no answer, return `BLOCKED` with the gate id.
3. When it returns `running`, call it again with the same arguments.
4. When it fails, fix the failing tests from its log, or for reason `component_boundary` move each change this slice made at its `crossing` paths back inside the slice's component or under a shared path, and verify again; after three failed runs, when a `crossing` path holds work this slice did not make, or when it returns `start_content_missing`, `declined`, or `approval_unclear`, return `BLOCKED` with its message, those paths, the failing test names, and the log path, and never move or revert another slice's work.
5. When a contract clause is wrong, report it instead of working around it: call `verify_slice` with `contractDefects`, one entry per clause with why, and return `BLOCKED`; when a review finding is wrong, cannot be satisfied, or conflicts with another finding, return `BLOCKED` with why.

A passing run of a slice whose review mark is `none` marks it done.

## 4. Return the status

Return only these fields, one line each, except that each question is a [blocker](../workflow/SKILL.md#common-terms):

```text
result: DONE | BLOCKED
commit: <last commit, or none>
summary: <one sentence on what changed>
questions: <each a blocker, or none>
```
