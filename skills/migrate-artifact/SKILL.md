---
name: migrate-artifact
description: "Convert one requirement file, ADR, glossary, or feature file, or a file that holds such content, into its Prism artifact format through a format migration that a person accepts in the review browser, keeping every statement or listing it as a leftover. Use when a person asks for an artifact's migration or accepts an offer of it."
argument-hint: '[artifact path]'
sdm: "0.3"
---

# Migrate an artifact

A [format migration](../workflow/SKILL.md#common-terms) converts one artifact per session into its [artifact format](../workflow/SKILL.md#common-terms) and applies only after a person accepts it.
It is not the move of a checkout's files into the store.

## 1. Prepare

1. Read the project's Prism configuration and instructions for the configured paths and whether commits are on.
2. Agree with the person on the one artifact to migrate, its type, and its target: the source itself for a migration in place, or a path under the type's configured path.
3. Read the target format's reference: the [requirement format](../write-requirements/references/requirement-format.md), the [ADR format](../write-adr/references/adr-format.md), the [glossary format](../workflow/references/glossary-format.md), or the [feature format](../write-feature/references/feature-format.md).
4. Call `check_artifacts` for the source when it lies under a configured path, and for an existing target, to learn their findings.
5. Read the source and an existing target, each [store artifact](../workflow/SKILL.md#common-terms) through `get_artifact`.
6. Read the source file's Git history, such as `git log --follow --format=%as -- <path>`, for dates that the source does not state.

When the person asks for several artifacts, migrate one and offer a fresh session for each other.

## 2. Write the content

1. Write the whole artifact in the target format, keeping each source statement verbatim in the place the format gives it.
2. When neither the source nor its Git history gives a required value, write `unknown`.
3. When the source or an existing target is Approved or Accepted, keep its status, its dates, and every identity it has.
4. Keep each entry of an existing target unchanged, and put the source's differing version of that entry under conflicts.
5. For a glossary term that no decided requirement or ADR introduces, write its source as `migration`, which stands for this format migration.
6. Add each source statement that the content does not keep to the leftover list, verbatim, with a proposed home such as the project instructions, the user guide, or another artifact.

- Don't
  - Add a statement that neither the source nor an existing target makes.
  - Change a decided status, date, or identity.

## 3. Propose, wait, and apply

1. Call `propose_migration` with the type, the source, the target, the content, a plain-language summary of what changes and why, the leftovers, and any conflicts.
2. When it refuses, correct the content, leftovers, or conflicts from the statements, entries, or fields it lists and propose again.
3. Tell the person to answer the format migration in the review browser, where they see its diff, leftovers, unknown values, and conflicts.
4. Call `wait_for_user_gate` with the migration's id as `migration`.
5. When the person declines, revise from the note and propose again if it asks for changes, otherwise stop.
6. When the person accepts, call `apply_migration` with the id, and when it refuses with `migration_stale`, read the changed files again and propose anew.
7. When commits are on, commit only the checkout paths that `apply_migration` lists as written or removed, in a commit of its own, since store artifacts need no commit.
8. Return the migration id, the written and removed artifacts, and each leftover with its proposed home.
