# Partial repository context estimates

Status: Approved
Created: 2026-09-26
Approved: 2026-09-26

## Problem

Prism returns a null fit-eligible estimate when required repository evidence is missing, which protects fit decisions but hides the approximate size of verified source ranges already included in the plan.

## Goals

- Report the approximate size of verified source ranges when the complete repository context estimate is unavailable.
- Keep an observed-range count distinct from any estimate that may support FIT.

## Non-goals

- Infer repository source that discovery or retrieval did not provide.
- Allow incomplete evidence to support FIT.
- Use repository source size as a substitute for a full task-complexity assessment.

## Design questions

- Should the observed-range count include all verified ranges or only must-read ranges?
- How should the plan express coverage and the token-counting method for an observed-range count?

<a id="1"></a>
## 1. Report observed source-range size separately from fit estimates

Pattern: Event-driven

Disposition: Active

Requirement: When Prism returns an incomplete repository context plan that contains verified source ranges, Prism shall report an approximate token count for those ranges separately from any estimate that can support FIT.

Rationale: Agents can use measured evidence to plan further exploration without treating incomplete discovery as a complete repository read cost.

Related: [Preserve uncertainty](repository-intelligence-providers.md#4), [Classify repository context fit](session-fit.md#3).
