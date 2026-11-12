# Requirement format

Format version: 1
Example path: `docs/requirements/resumable-uploads.md`

A requirement file states the obligations of one product capability as numbered EARS requirements.
The `check_artifacts` tool reports each rule below that a file breaks, by its rule id.
Any required field value or required section body may be the single word `unknown`, except the title, the status, and the section numbers and anchors.

## Rules

- `requirements.text`: The file is UTF-8 text of at most 1 MiB.
- `requirements.title`: The first line is `# <capability>`.
- `requirements.header`: `Status:`, `Created:`, and `Approved:` lines follow the title in that order before any section.
- `requirements.status`: The status is `Draft`, `Approved`, `Withdrawn`, or `Superseded by <link>`.
- `requirements.dates`: Created is a `YYYY-MM-DD` date, and Approved is a date when the status is Approved and `n/a` when it is Draft.
- `requirements.sections`: `## Problem`, `## Goals`, `## Non-goals`, and `## Design questions` appear once each in that order before the first numbered section.
- `requirements.numbering`: Each numbered section is `## <n>. <title>` directly after `<a id="<n>"></a>` with the same positive whole number, and no number repeats.
- `requirements.fields`: Each numbered section holds `Pattern:`, `Disposition:`, `Requirement:`, `Rationale:`, and `Related:` once each in that order, with at most one optional `Supersedes:` line anywhere after `Disposition:`.
- `requirements.pattern`: The pattern is `Ubiquitous`, `State-driven`, `Event-driven`, `Optional feature`, `Unwanted behavior`, or `Complex`.
- `requirements.disposition`: The disposition is `Active`, `Withdrawn` optionally followed by a date and a reason, or `Superseded by <link>`.
- `requirements.links`: Related is `n/a` or comma-separated Markdown links whose targets are relative `.md` paths with an optional `#<anchor>`, or `#<anchor>` alone, optionally followed by one period.

## Defaults

- Default `Status`: `Draft`
- Default `Approved`: `n/a`
- Default `Design questions`: `n/a`
- Default `Disposition`: `Active`
- Default `Related`: `n/a`

## Example

```markdown
# Resumable uploads

Status: Approved
Created: 2026-09-02
Approved: 2026-09-04

## Problem

A large upload starts again from its first byte when its connection drops.

## Goals

- Finish an interrupted upload without sending the parts the service already received.

## Non-goals

- Resuming downloads.

## Design questions

- n/a

<a id="1"></a>
## 1. Resume an interrupted upload

Pattern: Event-driven

Disposition: Active

Requirement: When a client reconnects within one hour of an interrupted upload, the service shall accept the remaining parts of that upload without the parts it already received.

Rationale: Sending a large file again wastes the time and data that the first attempt already spent.

Related: [resumable-uploads.md§2](#2)

<a id="2"></a>
## 2. Discard an abandoned upload

Pattern: Event-driven

Disposition: Active

Requirement: When an interrupted upload receives no part for one hour, the service shall discard the parts it received.

Rationale: Parts of an upload that nobody resumes hold storage that other uploads need.

Related: [resumable-uploads.md§1](#1)
```
