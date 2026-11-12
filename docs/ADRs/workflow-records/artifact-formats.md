# Check artifacts against versioned formats and migrate them behind a gate

Status: Proposed
Created: 2026-11-12

## Requirements

- [artifact-formats.md§1](../../requirements/artifact-formats.md#1)
- [artifact-formats.md§2](../../requirements/artifact-formats.md#2)
- [artifact-formats.md§3](../../requirements/artifact-formats.md#3)
- [artifact-formats.md§4](../../requirements/artifact-formats.md#4)
- [artifact-formats.md§6](../../requirements/artifact-formats.md#6)
- [artifact-conformance.md§1](../../requirements/artifact-conformance.md#1)
- [artifact-conformance.md§2](../../requirements/artifact-conformance.md#2)
- [artifact-conformance.md§3](../../requirements/artifact-conformance.md#3)
- [artifact-conformance.md§5](../../requirements/artifact-conformance.md#5)
- [artifact-migration.md§2](../../requirements/artifact-migration.md#2)
- [artifact-migration.md§3](../../requirements/artifact-migration.md#3)
- [artifact-migration.md§4](../../requirements/artifact-migration.md#4)

## Problem

Requirement files, ADRs, feature files, and the glossary have no stated format that agents and Prism share, so agents invent structure when they convert a document and nothing tells a person which artifacts Prism cannot use.
A format stated in two places, once for agents and once for a check, drifts, and a conversion done by an agent inside another task hides what it kept, dropped, or made up.

## Decision

Each normative artifact type has one versioned format whose reference, with its rules and one complete example, lives beside the skill that writes the type, and the glossary's lives with the workflow skill because several skills write it.
Every rule has a stable identifier that the reference lists and the check reports, and a test MUST fail when the two lists differ or when an example breaks its own format.
A format MUST keep each earlier version's rules, so the check can tell an artifact that Prism's earlier format produced from one that follows no Prism format.
Prism MUST compute conformance itself, with no agent involved, whenever it computes Attention and whenever an operation cites an artifact.
An operation that cites a nonconforming artifact MUST be refused before any other check except argument validation, including when a person marked the artifact as legacy, while an artifact that no operation cites MUST NOT block anything.
Legacy marks and migrations MUST be Prism records that change only through Prism tools and review app actions, so skills name the tools and never the records' storage.
A migration MUST account for every statement of its source, in the migrated artifact, on its leftover list, or in a conflict, and MUST NOT add a statement that neither the source nor an existing target holds, apart from the format's structure, its stated defaults, the value `unknown`, links, and dates from the source's history.
A migration MUST apply only after a person accepts it at its gate, and it MUST keep the status, dates, and identities of an Approved or Accepted artifact.
A glossary term's source MUST be an Approved requirement, an Accepted ADR, or an applied migration.
Each checkout checks the glossaries it reads, and a term identity that two of them define differently is a finding on both, so a narrower scope never silently redefines a wider one's term.

## Rationale

Keeping the reference beside the skill that writes the type puts the target where the writing agent already looks, and the identifier list makes the reference and the check one contract that a test holds together.
Checking at Attention and at citation catches files that change during a session without a skill, and refusing only citations keeps old artifacts free until work depends on them.
Statement accounting turns "nothing lost or invented" into a check Prism can run, and the gate turns the person's acceptance into the decision that makes terms predating Prism valid.

## Alternatives

A machine-readable format file that generates the references was rejected because generated prose is harder for agents to read than a reference written for them, and a parity test gives the same guarantee.
A new skill that owns the glossary was rejected because ideation, requirement approval, ADR acceptance, setup, and migration each write it at a different moment, and one shared format serves all of them.
Letting a legacy mark allow citation was rejected because work that depends on an artifact Prism cannot resolve fails later and less clearly.
Asking the agent to describe what a migration kept was rejected because a description can omit exactly the statement it dropped.

## Consequences

Projects whose artifacts predate the formats see them on Attention, and work that cites them is refused until they are migrated, which costs a migration session per cited artifact.
Changing a rule needs a new format version and a reference change in the same commit, and an artifact that conformed to the earlier version is reported as needing migration rather than silently breaking.
Sentence splitting of foreign prose can misjudge a statement, which surfaces as a refused proposal rather than a silent loss.

## Mechanism

The check reads each artifact under the configured paths, applies the current version's rules, and, when the artifact breaks them, tries each earlier version from the newest.
Attention groups the findings by format and leaves out artifacts that a legacy mark covers, and the initiative and roadmap tools run the same check on the artifacts an operation cites.
A migration proposal carries the whole migrated text, a summary, the leftover list, and any conflicts; Prism splits the source into statements, compares them with the proposal, records a pending migration, and lists it on Attention as a question.
The person answers on the migration's page, and the migration tool then writes the accepted text, substitutes each chosen conflict entry, names the migration as the source of the terms it introduced, and removes a separate source only when the person accepted its removal.

## Decision Log

n/a
