# Artifact formats

Status: Approved
Created: 2026-11-10
Approved: 2026-11-11

## Problem

Every Prism skill reads the glossary before it works, and ideation is told to update it, but no skill says what a glossary or a glossary entry looks like.
Setup creates a glossary with only a title and a one-line purpose.
On 10 November 2026 Michael asked an agent to turn an older glossary-like document into a Prism glossary, and with no target format the agent invented one and produced a document he judged nonsensical.
Requirement files, ADRs, and feature files each have a shape in the skill that writes them, but only as a template, so an agent converting a document has no complete example to compare against, and the server has no stated rules to check a file against.

## Goals

- Give every normative artifact type one format that agents write to and convert into.
- Give the glossary a format whose every term traces to a decision a person made.
- Keep what agents read and what Prism checks from drifting apart.

## Non-goals

- Formats for executable contracts, whose shape their consumer defines.
- Formats for slice documents, design diagrams, generated views, or user documentation.
- Product strategy as a Prism artifact.
- Judging the quality of a statement, such as whether a requirement is well written EARS.

## Design questions

- Where each format lives, for example as a reference beside the skill that owns the type, and whether a new skill owns the glossary.
- How a format's rules are stated so that the skills and the conformance check share one source.
- How the glossary's scope relates to workspace, repository, and component scopes when a store holds several glossaries, and how two scopes defining one term differently are reported.

<a id="1"></a>
## 1. Define one format per normative artifact type

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall define one format for each of requirement files, ADRs, the glossary, and feature files, stating its required headers, sections, identifiers, and link forms, with one complete example that conforms to it.

Rationale: An agent that writes or converts an artifact needs a target to compare against, and a template alone leaves the content of each part to guesswork, as the invented glossary showed.

Related: [artifact-conformance.md§1](artifact-conformance.md#1), [artifact-migration.md§1](artifact-migration.md#1)

<a id="2"></a>
## 2. Keep each format's example conforming

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall report no conformance finding for the example of any format it defines.

Rationale: The format that agents read and the rules that Prism checks must say the same thing, so a format change that the check does not follow fails at once instead of producing findings in users' repositories.

Related: [artifact-formats.md§1](#1), [artifact-conformance.md§1](artifact-conformance.md#1)

<a id="3"></a>
## 3. Define each glossary term with a stable identity and a source

Pattern: Ubiquitous

Disposition: Active

Requirement: The glossary format shall give each term a stable identity that other artifacts can link, a definition whose first sentence stands on its own, and a link to the source that introduced it, with optional distinctions from confusable terms and optional aliases.

Rationale: A term is useful only when requirements and ADRs can link it, a reader can learn its meaning from one sentence, and a reader can find the decision that made it part of the vocabulary.

Related: [artifact-formats.md§4](#4)

<a id="4"></a>
## 4. Accept only decided sources for glossary terms

Pattern: Ubiquitous

Disposition: Active

Requirement: The glossary format shall accept as a term's source only an Approved requirement, an Accepted ADR, or a migration that a person accepted.

Rationale: Michael decided on 10 November 2026 that the glossary needs no approval of its own because terms enter it only from decisions a person already made, and a migration a person accepted is such a decision for terms that predate Prism.

Related: [artifact-formats.md§5](#5), [artifact-migration.md§4](artifact-migration.md#4)

<a id="5"></a>
## 5. Add a term when its requirement is approved

Pattern: Event-driven

Disposition: Active

Requirement: When a person approves a requirement file or amendment that introduces a term absent from the glossary, Prism shall add the term to the glossary with that requirement as its source in the same change.

Rationale: A term written while its requirement is still a Draft could enter the vocabulary of a decision that is later rejected, while waiting for the decision keeps the glossary free of an approval step of its own.

Related: [artifact-formats.md§4](#4), [artifact-formats.md§7](#7), [workspace-artifacts.md§11](workspace-artifacts.md#11)

<a id="6"></a>
## 6. Report a term that its source no longer supports

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a glossary term's every source is superseded or withdrawn, then Prism shall report the term as a conformance finding that names those sources.

Rationale: A term whose decisions were all reversed would otherwise stay in the vocabulary that every session reads first, with nothing to say it no longer applies.

Related: [artifact-conformance.md§1](artifact-conformance.md#1)

<a id="7"></a>
## 7. Add a term when its ADR is accepted

Pattern: Event-driven

Disposition: Active

Requirement: When a Proposed ADR that introduces a term absent from the glossary becomes Accepted, Prism shall add the term to the glossary with that ADR as its source in the same change.

Rationale: An architectural term earns its place in the shared vocabulary when its decision survives being built, and until then the Proposed ADR itself defines it for the sessions that read it.

Related: [artifact-formats.md§4](#4), [artifact-formats.md§5](#5), [workspace-artifacts.md§12](workspace-artifacts.md#12)
