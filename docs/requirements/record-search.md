# Questions about records and the code they describe

Status: Draft
Created: 2026-11-10
Approved: n/a

## Problem

Before an agent writes a requirement, a decision, or a glossary term, it cannot reliably learn whether the workspace already holds the same or a similar one, which existing records an intent must respect or supersede, or which parts of the intent no record covers yet.
Search answers with passages of files, so a result does not say which record it belongs to, what kind of record that is, or whether the record is Approved, Accepted, superseded, or withdrawn.
An agent changing code cannot ask which requirements, decisions, and tests stand behind it, and an agent reading a requirement cannot ask which code implements it.
Prism already records most of that chain for work that runs through it, from requirement to contract clause, frozen test, slice, and changed files, but no tool reads it as links.
The November 2026 record-question measurement on the Prism repository found that search alone finds a similar requirement for every duplicate it was given, but cannot tell a duplicate from a new idea by similarity, and returns linked code for only half of the code files it was asked about.

## Goals

- Answer with records rather than passages, each named with its kind, identity, and status.
- Find records similar to a proposed one, so duplicates are caught before they are written.
- Find the records an intent must respect or supersede.
- Read the recorded links between records and code in both directions, and say when an answer is a guess instead.
- Let ideation and design ask these questions as part of their work.

## Non-goals

- Decide by similarity alone that two records state the same obligation, that a record is superseded, or that a gap exists: the agent and the person judge.
- Infer links between records and code that Prism did not record, except as results marked as guesses.
- Move records between the code repository and the store, which [workspace-artifacts.md](workspace-artifacts.md) covers.
- Build the review app's Knowledge search, which [review-app-places.md§25](review-app-places.md#25) covers.

## Design questions

- Which unit is a record for each kind: one numbered requirement, one ADR, one glossary term, one feature scenario?
- How does a link survive a later move or rename of the code it points to?
- Which tool surface carries these questions: new tools, or new fields and filters on existing ones?
- Where do glossary terms live, given that Prism's own terms are a table in the workflow skill and a project's glossary is a configured file?

<a id="1"></a>
## 1. Name the record behind each result

Pattern: Event-driven

Disposition: Active

Requirement: When concept search returns a passage of a requirement, an ADR, a glossary term, or a feature file, Prism shall name in the result the record it belongs to, the record's kind, and its status or disposition.

Rationale: An agent cannot tell a superseded requirement from a current one, or a requirement from a passage of a plan, when the result is only a file and line range.

Related: [record-search.md§2](#2)

<a id="2"></a>
## 2. Narrow a search to kinds and statuses of records

Pattern: Optional feature

Disposition: Active

Requirement: Where a concept search names record kinds or statuses, Prism shall return only records of those kinds and statuses.

Rationale: "Which Approved requirements" and "which Accepted decisions" are the common forms of these questions, and a path filter cannot express a status.

Related: [record-search.md§1](#1)

<a id="3"></a>
## 3. Find records similar to a proposed one

Pattern: Event-driven

Disposition: Active

Requirement: When an agent asks for records similar to a proposed record's text, Prism shall return the most similar existing records of the same kind with their status, and shall not state that any of them is a duplicate.

Rationale: The measurement found the similar record every time, while the similarity of a real duplicate and of an unrelated new idea overlapped, so the judgment must stay with the agent.

Related: [record-search.md§1](#1)

<a id="4"></a>
## 4. Find the records an intent must respect

Pattern: Event-driven

Disposition: Active

Requirement: When an agent asks which records bear on an intent, Prism shall return the matching requirements, decisions, and glossary terms with their status, and for each superseded or withdrawn one, the record that replaced it.

Rationale: An intent shaped against a superseded record repeats a decision that was already changed.

Related: [record-search.md§3](#3)

<a id="5"></a>
## 5. Return the records that back a piece of code

Pattern: Event-driven

Disposition: Active

Requirement: When an agent asks which records back a file or a code unit, Prism shall return the requirements, decisions, contract clauses, and tests that Prism recorded for the work that changed it, each with the work it came from.

Rationale: Search alone found a linked requirement for 85 of 162 code files in the measurement, while Prism's own slice records name them exactly.

Related: [record-search.md§7](#7)

<a id="6"></a>
## 6. Return the code that implements a record

Pattern: Event-driven

Disposition: Active

Requirement: When an agent asks which code implements a requirement, a decision, a test, or a glossary term, Prism shall return the files and code units that Prism recorded for the work that cited it.

Rationale: The same recorded chain answers the question in the other direction.

Related: [record-search.md§5](#5)

<a id="7"></a>
## 7. Mark an answer without recorded links as a guess

Pattern: Unwanted behavior

Disposition: Active

Requirement: If Prism has no recorded link for the code or record a question names, then Prism shall answer from search alone and mark every such result as found by similarity rather than recorded.

Rationale: Code written before Prism or outside it has no links, and an agent must not take a similar passage for a recorded fact.

Related: [record-search.md§5](#5), [record-search.md§6](#6)

<a id="8"></a>
## 8. Report a link whose code moved

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a recorded link points to a file or code unit that no longer exists at its recorded place, then Prism shall report the link as broken and name where the code moved when it can tell.

Rationale: A refactor that moves code silently would otherwise leave records pointing at nothing.

Related: [record-search.md§5](#5)

<a id="9"></a>
## 9. Check for similar records while shaping an idea

Pattern: Event-driven

Disposition: Active

Requirement: When ideation drafts a requirement, decision, or glossary term, Prism shall have the agent check for similar existing records and show the person each close match beside the draft.

Rationale: A duplicate caught before approval costs a sentence, while one found later costs a supersession.

Related: [record-search.md§3](#3)

<a id="10"></a>
## 10. Report the parts of an intent that no record covers

Pattern: Event-driven

Disposition: Active

Requirement: When ideation or design checks an intent against existing records, Prism shall have the agent split the intent into the obligations it needs, search for each one, and list for the person each obligation that no record covers.

Rationale: Search cannot show that something is missing, so a gap is found by asking for each needed obligation in turn.

Related: [record-search.md§4](#4)
