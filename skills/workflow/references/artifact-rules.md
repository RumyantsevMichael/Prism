# Artifact rules

Requirements preserve obligations, ADRs preserve decisions, and feature files preserve acceptance examples.
Slice records contain only the capability title, outcome, and requirement links.
The workflow creates no implementation handoff, mandatory build plan, or execution ledger.

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
