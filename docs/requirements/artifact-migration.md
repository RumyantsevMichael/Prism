# Artifact migration

Status: Approved
Created: 2026-11-10
Approved: 2026-11-11

## Problem

Nothing in Prism migrates a human-written artifact into its format.
Setup converts an old workflow configuration and the server moves old records, but requirement files, ADRs, glossaries, and feature files are converted ad hoc by whichever agent meets them.
On 1 November 2026 an ad hoc conversion of an Approved requirement file proposed a full copy that still said Approved, with no diff, so the person could not see what changed.
On 10 November 2026 an agent asked to turn an older glossary-like document into a glossary mixed its definitions, usage rules, and navigation notes into a structure of its own, and nothing showed what it kept, dropped, or made up.

## Goals

- Convert an artifact into its format without losing or inventing content.
- Let a person see exactly what a migration changes before it applies.
- Keep the decisions an Approved or Accepted artifact records unchanged by its migration.
- Keep migration out of the task that found the need for it.

## Non-goals

- Rewording statements to improve them, which stays an amendment through the type's own authoring procedure.
- Migrating executable contracts, slice documents, generated views, or user documentation.
- Converting Prism's workflow configuration, which setup owns.
- Migrating without a person's acceptance.

## Design questions

- How a statement inventory is presented at the gate when a source holds hundreds of statements.
- Whether one migration may convert several artifacts of one type behind one gate.
- How a migration's change is kept separate from other work when the artifact lives in a store.

<a id="1"></a>
## 1. Migrate an artifact only when a person asks

Pattern: Event-driven

Disposition: Active

Requirement: When a person asks for an artifact's migration, or accepts an offer of it, Prism shall convert the artifact into its type's format in a session and a change of its own, separate from the task that found the need.

Rationale: Michael decided on 1 November 2026 that migration runs in its own child and its own commit, so neither the migration nor the task that found it hides inside the other.

Related: [artifact-conformance.md§3](artifact-conformance.md#3), [artifact-conformance.md§4](artifact-conformance.md#4)

<a id="2"></a>
## 2. Account for every source statement

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall place each statement of a migration's source either in the migrated artifact or on the migration's leftover list, with a proposed home for each leftover.

Rationale: A source document often mixes what the target format holds with material that belongs elsewhere, such as usage rules in a glossary that belong in an ADR or project instructions, and placing every statement makes a dropped or misplaced one visible.

Related: [artifact-migration.md§4](#4)

<a id="3"></a>
## 3. Keep the wording of migrated statements

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall keep the wording of each statement that a migration places in the migrated artifact, changing only its position, headers, identities, and links.

Rationale: Migration changes structure, and a reworded statement could change a decision a person made, which belongs in an amendment the person reviews as one.

Related: [artifact-migration.md§6](#6)

<a id="4"></a>
## 4. Present a migration at a gate

Pattern: Event-driven

Disposition: Active

Requirement: When a migration is ready, Prism shall present it at a gate with the difference from the source, a plain statement of what changes and why, and the leftover list, and apply it only after a person accepts it, recording who accepted it.

Rationale: A person must be able to see exactly what a migration changes, and an accepted migration is the decision that makes a term predating Prism a valid glossary source.

Related: [artifact-formats.md§4](artifact-formats.md#4), [workspace-artifacts.md§8](workspace-artifacts.md#8), [workspace-artifacts.md§10](workspace-artifacts.md#10)

<a id="5"></a>
## 5. Mark a required value that the source does not give

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a format requires a value that a migration's source neither states nor records in its version history, then Prism shall mark the value as unknown in the migrated artifact and list it at the gate.

Rationale: An invented rationale, date, or definition reads as recorded fact to every later session, while a visible unknown asks the person who can answer it.

Related: [artifact-migration.md§4](#4)

<a id="6"></a>
## 6. Keep an Approved or Accepted artifact's decisions

Pattern: Event-driven

Disposition: Active

Requirement: When Prism migrates an Approved or Accepted artifact, Prism shall keep its status, its dates, and every identity it already has, and assign new identities only to parts that had none.

Rationale: Other artifacts and records may link the artifact's existing identities, and its status records a person's decision that a structural change does not revisit.

Related: [artifact-migration.md§3](#3), [workspace-artifacts.md§10](workspace-artifacts.md#10)

<a id="7"></a>
## 7. Report a conflict with the target

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a migration's source defines an entry that the target artifact already holds with a different meaning, then Prism shall show both at the gate and keep the target's entry until a person chooses.

Rationale: Converting a document into an existing artifact, such as an old term list into a project's glossary, can meet the same name defined twice, and choosing between the definitions is a person's decision.

Related: [artifact-migration.md§4](#4)

<a id="8"></a>
## 8. Keep a separate source until a person removes it

Pattern: Optional feature

Disposition: Active

Requirement: Where a migration's source is a separate document from the migrated artifact, Prism shall remove the source only when a person accepts its removal at the migration's gate.

Rationale: A source with leftovers still holds material that has no other home yet, and its owner decides when it has served its purpose.

Related: [artifact-migration.md§2](#2), [artifact-migration.md§4](#4)
