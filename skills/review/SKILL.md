---
name: review
description: "Review a completed Prism outcome slice against approved intent, verified behavior, code quality, integration, and declared security boundaries."
---

# Review a completed slice

Run in a fresh context after implementation verification.
Do not inherit the authoring task's conversation.
Do not edit code or artifacts.

Read `.prism/workflow.md` and project instructions.
Read the completed diff, requirements, tests, feature files, and relevant ADRs.
Read an executable contract when the diff changes a boundary that consumes it.
Read a diagram when the diff changes the structure that it describes.
Use code as the source for implementation detail.

## Review order

1. Confirm that the diff implements every applicable requirement without added product behavior.
2. Confirm that tests exercise the outcome through the user-visible or system surface identified by requirements and tests.
3. Confirm that feature files match verified behavior and requirement intent.
4. Check correctness, error behavior, state transitions, compatibility, and integration completeness.
5. Check for unrelated edits, generated caches, temporary files, and stale documentation.
6. Check the declared security surface.

When the security surface is non-empty, inspect secrets, untrusted inputs, authorization, privilege, network access, storage, and IPC as applicable.
When the security surface is `none`, verify that classification and record that the security audit was skipped.

Run focused verification when it can confirm or reject a suspected defect.
Do not report a hypothetical problem without an affected path and failure condition.

## Result

Report only actionable findings.
For each finding, give severity, evidence, affected path, and the condition that closes it.
Return `CLEAN` when no actionable finding remains.

Do not restate the implementation.
Do not praise successful work.
Do not create new requirements or architectural decisions during review.
