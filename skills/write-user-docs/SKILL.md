---
name: write-user-docs
description: "Update user guidance after verified commands, configuration, defaults, interfaces, or capabilities change."
sdm: "0.3"
---

# Write user documentation

This skill applies after implementation verification confirms an observable change.

- Write for people who install, configure, operate, or use the product.
- Don't
  - Document unverified behavior as available.

## 1. Prepare

The configured user-guide directory contains the guidance.
The default directory is `docs/user-guide/`.
Each new or updated guide page shall be in the configured user-guide directory.

1. If `.prism/workflow.md` exists, read it.
2. Read only the affected guide pages and their index entries.
3. Read the verified interface.
4. Read linked requirements or ADRs when they govern the guidance.

## 2. Select the update

- When the change affects installation or startup, update the documentation.
- When the change affects commands, APIs, or user interfaces, update the documentation.
- When the change affects configuration keys, defaults, ports, secrets, or file locations, update the documentation.
- When the change affects user-visible capabilities or failure behavior, update the documentation.
- When the change affects operator procedures, migrations, or recovery, update the documentation.

- Do
  - Link an ADR when the user needs architectural rationale.
  - Link a requirement when the user needs the governing obligation.
- Don't
  - Add internal module structure.
  - Add test strategy.
  - Add implementation details.
  - Copy ADR rationale into the guide.

## 3. Write verified guidance

- Use exact commands, names, defaults, and paths from the verified implementation.
- State prerequisites before the related procedure.
- Use numbered steps for a procedure.
- State the expected result after each verification command.
- Mark an unavailable capability as `Planned` only when the project already tracks it.
- Update the guide index and cross-links when a page is added, renamed, or removed.
- Remove stale guidance that the change replaces.
- Use the established project voice and terms.

- Don't
  - Infer behavior from an old page.

## 4. Operator runbooks

- When operators must build, deploy, migrate, rotate, recover, or diagnose the capability, add or update a runbook.
  - Include prerequisites.
  - Include exact steps.
  - Include verification.
  - Include failure handling.
  - Include rollback when it is available.
  - Mark an unresolved operational decision as `TBD`.

## 5. Result

1. Run each documented command when practical.
2. Confirm that the documentation matches verified product behavior.
3. Report the changed pages.
4. Report each command that could not be verified.
5. Finish only when the documentation matches verified behavior.
