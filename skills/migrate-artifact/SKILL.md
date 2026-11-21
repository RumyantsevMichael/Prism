---
name: migrate-artifact
description: "Carry out one format migration run that Prism started: convert each requirement file, ADR, or glossary of the run's set into its Prism artifact format, keeping every statement or giving it a home, and finish or fail the run. Use only when a prompt names such a run by its id."
argument-hint: '[run id]'
sdm: "0.3"
---

# Carry out a format migration run

A [format migration](../workflow/SKILL.md#common-terms) run is Prism's own upkeep: Prism starts it for a set of artifacts that break their [artifact format](../workflow/SKILL.md#common-terms) and launches this session with the run's id as its only instruction.
This session proposes one format migration per artifact of the set and ends the run; Prism applies it without a person when nothing is lost or invented, and otherwise puts the asked points to the person once and continues this session with the answers.
It is not the move of a checkout's files into the store.

## 1. Prepare

1. Call `get_migration_run` with the run id for its set, status, earlier proposals, question, answers, the project's configured paths, and each source's Git history.
2. Read the target format's reference beside this skill: the [requirement format](../write-requirements/references/requirement-format.md), the [ADR format](../write-adr/references/adr-format.md), the [glossary format](../workflow/references/glossary-format.md), or the [feature format](../write-feature/references/feature-format.md).
3. For each artifact of the set, read it and any existing target through `get_artifact` with its scope, and take its current findings from the run.
4. Take dates that a source does not state from its Git history in the run.

- Don't
  - Read a file of the project yourself, or run a shell or version control command: this session works outside the project, and the run's tools serve everything it reads.

## 2. Write each artifact's content

1. Write the whole artifact in the target format, keeping each source statement verbatim in the place the format gives it.
2. When a numbered requirement section holds more than one requirement, on several `Requirement:` lines or as several sentences that say `shall` on one, keep its first requirement in it and give each further requirement, in source order, a new numbered section at the end of the file, numbered on from the file's highest number.
   - Keep in the section its number, anchor, title, Pattern, Disposition, Rationale, Related, and Supersedes.
   - Give each new section `<a id="<m>"></a>`, `## <m>. <the section's title>`, the Pattern of its own sentence, the section's Disposition, the sentence verbatim as its Requirement, the section's Rationale, and as Related a link `[<file name>§<n>](#<n>)` to the section followed by the section's own Related links unless that is `n/a`.
   - Take the Pattern from the sentence: `While` is State-driven, `When` is Event-driven, `Where` is Optional feature, `If … then` is Unwanted behavior, more than one of these is Complex, and none is Ubiquitous.
   - Keep every section's number and anchor, never renumbering one, and never merge requirements into one `Requirement:` line.
3. When neither the source nor its Git history gives a required value, write `unknown`.
4. When the source or an existing target is Approved or Accepted, keep its status, its dates, and every identity it has.
5. Keep each entry of an existing target unchanged, and put the source's differing version of that entry under conflicts.
6. For a glossary term that no decided requirement or ADR introduces, write its source as `migration`, which stands for this format migration.
7. Add each source statement that the content does not keep to the leftover list, verbatim, with a proposed home such as the project instructions, the user guide, or another artifact.

- Don't
  - Add a statement that neither the source nor an existing target makes.
  - Change a decided status, date, or identity.

## 3. Propose each artifact

1. Call `propose_migration` with the run, the type, the source, the target, the content, a plain-language summary of what changes and why, the leftovers, and any conflicts.
2. When it refuses with statements, entries, or fields, correct the content, leftovers, or conflicts from what it lists and propose again.
3. When it refuses with `migration_unsettled`, name each listed point under `settled` with the reason that it loses nothing, or under `asked` with Prism's recommendation, and propose again.
4. Settle a leftover or entry point only when its statement keeps its meaning in the content or in its home, and ask every other point.
5. Give an asked `unknown` point's recommendation as the value itself, one line of at most 500 characters, which the person can accept as it stands.
6. Ask about a separate source's removal only once every source statement has a home in the content or the leftover list, and recommend its removal.

## 4. End the run

1. When the run holds answers, apply each one: place each answered leftover in the section that its answer names, and propose that artifact again with the same points, while Prism itself writes each answered value and conflict choice.
2. Once every artifact of the set has a proposal, call `finish_migration_run`.
3. When it refuses with `migration_run_incomplete`, propose each artifact it lists, then finish again.
4. When an artifact cannot be migrated without losing or inventing a statement, call `fail_migration_run` with the reason in plain language.
5. Return the run id, its status, and each leftover with its home.
