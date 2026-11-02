# Review finding provenance

Status: Approved
Created: 2026-10-22
Approved: 2026-10-22

## Problem

A finding's status changes across several review waves, so a reader cannot relate the effort of a wave to the findings it produced unless each finding keeps the wave that raised it.

## Goals

- Keep each finding associated with the review wave that raised it.
- Let readers of the review ledger select the findings one wave raised.

## Non-goals

- Change how findings are raised, carried, or closed.
- Change finding identity or lanes.

## Design questions

- n/a.

<a id="1"></a>
## 1. Keep the raising wave

Pattern: Event-driven

Disposition: Active

Requirement: When a reviewer raises a finding in a review wave, Prism shall keep that wave as the finding's raising wave for the life of the review record.

Rationale: Wave statistics are only comparable with review yield when each finding stays bound to the wave that produced it.

Related: [review-finding-provenance.md§2](#2), [run-statistics.md§17](run-statistics.md#17)

<a id="2"></a>
## 2. Select findings by raising wave

Pattern: Event-driven

Disposition: Active

Requirement: When a caller reads a review through Prism or the review browser with a review wave selected, Prism shall return only the findings that wave raised.

Rationale: Readers need the findings of one wave next to that wave's effort.

Related: [review-finding-provenance.md§1](#1)
