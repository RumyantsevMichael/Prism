---
name: write-user-docs
description: "Update user guidance after verified commands, configuration, defaults, interfaces, or capabilities change."
sdm: "0.3"
---

# Update verified user guidance

This skill documents verified changes for people who install, configure, operate, or use the product.
Guide pages use the configured user-guide directory, defaulting to `docs/user-guide/`.

## 1. Select the guidance

1. If `.prism/workflow.md` exists, read it first.
2. Read the verified interface, affected guide pages, and their index entries.
3. Read requirements or ADRs that govern the guidance.
4. If no installation, interface, configuration, capability, failure, or operator behavior changed, return the reason no update is needed.

## 2. Write the update

1. Update affected guide pages using exact verified commands, names, defaults, and paths.
2. Put prerequisites before numbered procedures and expected results after verification commands.
3. Replace stale guidance and update affected index entries and links.
4. When operators need build, deployment, migration, rotation, recovery, or diagnostic procedures:
   1. Create or update a runbook in the guide directory.
   2. Include prerequisites, exact steps, verification, failure handling, and available rollback.
   3. Mark unsettled operational decisions `TBD`.
5. Link requirements or ADRs when readers need their obligations or rationale.
6. Use established project voice and terms.

Guidance excludes implementation details, test strategy, and copied ADR rationale.
Unavailable capabilities appear as `Planned` only when the project already tracks them.

## 3. Check and return

1. Run documented commands when practical.
2. Compare guidance with verified behavior.
3. Correct discrepancies before returning.
4. Return changed page paths and commands that could not be verified.

Old documentation alone is not evidence that behavior works.
