# ADR format

Format version: 1
Example path: `docs/ADRs/uploads/upload-token.md`

An ADR records one architectural decision or invariant and the Approved requirements it serves.
The `check_artifacts` tool reports each rule below that an ADR breaks, by its rule id.
Any required field value or required section body may be the single word `unknown`, except the title and the status.

## Rules

- `adr.text`: The file is UTF-8 text of at most 1 MiB.
- `adr.title`: The first line is `# <decision>`.
- `adr.header`: `Status:` and then `Created:` follow the title before any section.
- `adr.status`: The status is `Proposed`, `Accepted`, `Declined`, or `Superseded by <link>`.
- `adr.dates`: Created is a `YYYY-MM-DD` date.
- `adr.sections`: `## Requirements`, `## Problem`, `## Decision`, `## Rationale`, `## Alternatives`, `## Consequences`, `## Mechanism`, and `## Decision Log` appear once each in that order, where only the Decision Log may be empty.
- `adr.requirements`: The Requirements section is `n/a` or paragraphs or list items in which every Markdown link targets a relative `<path>.md` with an optional `#<anchor>`; write one link to `<path>.md#<anchor>` per list item, as the example does.

## Defaults

- Default `Status`: `Proposed`
- Default `Requirements`: `n/a`
- Default `Decision Log`: `n/a`

## Example

```markdown
# Identify an upload by a server-issued token

Status: Accepted
Created: 2026-09-20

## Requirements

- [resumable-uploads.md§1](../../requirements/resumable-uploads.md#1)
- [resumable-uploads.md§2](../../requirements/resumable-uploads.md#2)

## Problem

A client that reconnects must name the interrupted upload it resumes, and the service must know when nobody resumes it.

## Decision

The service MUST issue one opaque token for each upload when the upload starts, and a resumed upload MUST present that token.
A token MUST NOT name more than one upload.

## Rationale

A token that the service issues cannot collide with another client's upload, and its last use tells the service when the upload was abandoned.

## Alternatives

A token derived from the file name and size was rejected because two clients can upload the same file at once.

## Consequences

A client that loses its token cannot resume and starts the upload again.

## Mechanism

The service records each token with the parts it received and the time of the last part, and discards both an hour after that time.

## Decision Log

n/a
```
