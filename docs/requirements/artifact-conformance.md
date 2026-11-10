# Artifact conformance

Status: Draft
Created: 2026-11-10
Approved: n/a

## Problem

Projects hold requirements, ADRs, glossaries, and feature files that predate Prism's formats, that an earlier Prism version wrote, or that people wrote by hand.
Nothing tells a person which of them Prism cannot use until a session trips over one.
On 1 November 2026 triage needed to cite a rule in an Approved requirement file that had no numbered sections, and its attempt to convert the file in the middle of the task was hard to follow.
A repository with many old ADRs that nobody plans to touch should not bury the findings that matter.

## Goals

- Show a person, without asking an agent, which artifacts do not conform to their format and why.
- Let a person leave a set of old artifacts alone without it being reported again.
- Stop work from depending on an artifact that Prism cannot resolve.
- Keep a format change in a Prism update from silently leaving existing artifacts behind.

## Non-goals

- Judging statement quality, such as whether a requirement is well written EARS or a definition is clear.
- Changing any artifact during the check.
- Checking artifacts that no format covers.

## Design questions

- Which operations count as citing an artifact, for example requirement assignments, roadmap requirement references, and ADR links in a contract.
- Where the legacy marks are kept, and whether they are a review app action.
- How the check stays fast enough for a workspace with hundreds of artifacts.

<a id="1"></a>
## 1. Report artifacts that break their format

Pattern: Event-driven

Disposition: Active

Requirement: When Prism computes the Attention page, Prism shall report, for each artifact type that has a format, the number of artifacts that break it, with each artifact's location and the rules it breaks.

Rationale: Michael decided on 1 November 2026 that Prism checks conformance itself, with no skill involved, and computing it with Attention catches files that change during a session.

Related: [artifact-formats.md§1](artifact-formats.md#1), [workspace-artifacts.md§1](workspace-artifacts.md#1)

<a id="2"></a>
## 2. Leave artifacts that a person marked as legacy

Pattern: Event-driven

Disposition: Active

Requirement: When a person marks a set of nonconforming artifacts as legacy, Prism shall stop reporting them as needing attention, show them as legacy with their count, and record who marked them and when, until a person removes the mark.

Rationale: A repository with many old artifacts that nobody plans to touch would otherwise flood Attention and hide the findings that matter.

Related: [artifact-conformance.md§1](#1)

<a id="3"></a>
## 3. Refuse work that cites a nonconforming artifact

Pattern: Unwanted behavior

Disposition: Active

Requirement: If an operation cites an artifact that breaks its format, including one marked as legacy, then Prism shall refuse the operation, name the artifact and the rules it breaks, and offer its migration.

Rationale: Work that depends on an artifact Prism cannot resolve fails later and less clearly, while a nonconforming artifact that no work cites costs nothing, so only citing blocks.

Related: [artifact-migration.md§1](artifact-migration.md#1)

<a id="4"></a>
## 4. Report nonconformance that the check cannot see

Pattern: Event-driven

Disposition: Active

Requirement: When a Prism workflow skill finds an artifact that breaks its format in a way that Prism's check did not report, the skill shall report the artifact and the break to the person with an offer of migration, without changing the artifact in the task that found it.

Rationale: Michael decided on 1 November 2026 that an agent which finds nonconformance reports it so that migration can be offered, because converting an artifact inside an unrelated task is what made the earlier conversion hard to follow.

Related: [artifact-migration.md§1](artifact-migration.md#1)

<a id="5"></a>
## 5. Offer migration when a Prism update changes a format

Pattern: Event-driven

Disposition: Active

Requirement: When a Prism update changes an artifact format, Prism shall report each artifact that conformed to the earlier format as needing migration, separately from artifacts that conform to no Prism format.

Rationale: Michael decided on 21 October 2026 that changes must not break users' artifacts or must ship with their migration, and a person deciding what to migrate needs to tell Prism's own earlier output from foreign documents.

Related: [artifact-conformance.md§1](#1), [artifact-migration.md§1](artifact-migration.md#1)
