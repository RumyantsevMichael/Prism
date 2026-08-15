---
name: write-user-docs
description: "Update user guidance after verified commands, configuration, defaults, interfaces, or capabilities change."
---

# Write user documentation

Use this skill after implementation verification confirms an observable change.
Write for people who install, configure, operate, or use the product.
Do not document unverified behavior as available.

Read `.prism/workflow.md` when it exists.
Read only the affected guide pages, their index entries, the verified interface, and linked requirements or ADRs.
Use the configured user-guide directory, with `docs/user-guide/` as the default.

## Select the required update

Update documentation when the change affects:

- installation or startup.
- commands, APIs, or user interfaces.
- configuration keys, defaults, ports, secrets, or file locations.
- user-visible capabilities or failure behavior.
- operator procedures, migrations, or recovery.

Do not add internal module structure, test strategy, or implementation detail.
Link an ADR for rationale instead of copying it.
Link a requirement when the user needs the governing obligation.

## Write verified guidance

Use exact commands, names, defaults, and paths from the verified implementation.
State prerequisites before the related procedure.
Use numbered steps for a procedure.
State the expected result after each verification command.
Mark an unavailable capability as `Planned` only when the project already tracks it.
Do not infer behavior from an old page.

Update the guide index and cross-links when a page is added, renamed, or removed.
Remove stale guidance that the change replaces.
Use the established project voice and terms.

## Operator runbooks

Add or update a runbook when operators must build, deploy, migrate, rotate, recover, or diagnose the capability.
Include prerequisites, exact steps, verification, failure handling, and rollback when available.
Mark an unresolved operational decision as `TBD`.

## Result

Run each documented command when practical.
Report the changed pages and any command that could not be verified.
Finish only when the documentation matches the verified product behavior.
