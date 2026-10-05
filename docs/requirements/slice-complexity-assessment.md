# Slice complexity assessment

Status: Approved
Created: 2026-09-26
Approved: 2026-09-26

## Problem

Prism requires a C4 code view for a fitted slice and checks that the PlantUML source renders, but the design gate does not treat an unreadable or dense view as evidence that the slice may be too complex.

## Goals

- Use diagram readability and relationship density as evidence during the atomic-fit decision.
- Require a split assessment before accepting an unreadable diagram as evidence of a fitted slice.
- Allow a slice to remain intact when its outcome is cohesive and the design explains why decomposition would not help.

## Non-goals

- Split every slice whose diagram contains many elements.
- Set a fixed node, edge, or pixel limit for all diagrams.
- Treat diagram styling as a substitute for scope and verification analysis.

## Design questions

- What viewing conditions and review criteria provide a repeatable readability check?
- What evidence should the designer record when a dense diagram still represents one cohesive outcome?

<a id="1"></a>
## 1. Assess diagram readability before atomic fit

Pattern: Event-driven

Disposition: Active

Requirement: When Prism reviews a proposed FIT result and the slice's required C4 code view obscures its starting surface, outcome-relevant collaborators, or their main relationships at normal review size, Prism shall assess and record whether to decompose the slice into smaller independently verifiable outcomes.

Rationale: A diagram that is difficult to review can signal that the slice contains more relationships or responsibilities than one delivery context can manage clearly.

Related: [Classify repository context fit](session-fit.md#3).
