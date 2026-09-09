# Artifact rules

Requirements preserve obligations, ADRs preserve decisions, and feature files preserve acceptance examples.
Slice records contain only the capability title, outcome, and requirement links.
The workflow creates no implementation handoff, mandatory build plan, or execution ledger.

## Minimal persistence

Workflow results stay in the agent response unless a later context needs them.
Persist only facts that an existing artifact does not already own.
Use `state.json` for current coordination facts and evidence paths, not copied reports.
Existing artifacts replace standalone exploration or verification reports when they preserve the required facts.
When no existing artifact can own a fact required by a later context, create one focused artifact and state why it is needed.

## Design evidence

- Store C4 source and supplementary slice diagrams in the slice folder.
- Preserve ancestor source for child designs.
- Record settled shared decisions as Proposed ADRs before splitting when children need them.
- Keep ADR state and sequence diagrams beside their decision record.
- Reuse an ADR diagram instead of creating a duplicate slice view.
- Complete a C4 code view for each atomic slice using [C4 code diagrams](../../design/references/c4-code-diagrams.md).
- Author tests, contracts, scaffolds, and feature files only after atomic fit.
- Put executable artifacts in project-owned consumer paths.
- Mark proposed elements until implementation verifies them.
- After verification, update diagram relationships from code evidence.

Diagrams explain structure or behavior without prescribing implementation tasks.
Requirements and feature files contain no diagrams.
Implementation reads diagram source, not rendered images.
Rendered images are not committed.

## Durable sources

- Cite requirements for obligations and ADRs for rationale.
- Keep durable requirements, ADRs, features, and user guidance free of scratch paths and slice identities.
- Use `write-user-docs` for verified user or operator changes.

When a slice needs a runbook before verification, store `runbook-draft.md` in the slice folder.
Move verified necessary content to the configured user-guide directory through `write-user-docs` before slice completion.
