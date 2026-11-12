# Feature format

Format version: 1
Example path: `docs/Features/F-resumable-uploads.feature`

A feature file states observable behavior as Gherkin rules, each linked to the Approved requirements it checks, with examples.
The `check_artifacts` tool reports each rule below that a feature file breaks, by its rule id.
A step text may be the single word `unknown`.

## Rules

- `feature.text`: The file is UTF-8 text of at most 1 MiB.
- `feature.header`: The first line that is neither blank nor a comment is `Feature: <capability>`.
- `feature.rules`: The feature has at least one `Rule:`, and every `Example:` or `Scenario:` sits under one.
- `feature.requirement`: Each Rule has, before its first example, at least one `# Requirement: [<title>](<path>.md#<anchor>)` comment, and may add `# ADR: [<title>](<path>.md)` comments.
- `feature.examples`: Each Rule has at least one example.
- `feature.steps`: Each example has at least one `Given`, exactly one `When`, and at least one `Then`, in that order, where `And` and `But` continue the step before them.

## Defaults

This format has no default values.

## Example

```gherkin
Feature: Resumable uploads

  Rule: An interrupted upload resumes without the parts the service received
    # Requirement: [Resume an interrupted upload](../requirements/resumable-uploads.md#1)
    # ADR: [Identify an upload by a server-issued token](../ADRs/uploads/upload-token.md)

    Example: A client resumes within the hour
      Given a client sent the first half of a file before its connection dropped
      When the client reconnects after ten minutes with its upload token
      Then the service asks for the second half only
      And the stored file matches the original

  Rule: An abandoned upload is discarded
    # Requirement: [Discard an abandoned upload](../requirements/resumable-uploads.md#2)

    Example: Nobody resumes an interrupted upload
      Given an interrupted upload
      When one hour passes without a part
      Then the service no longer holds the parts it received
```
