# Keep machine records under .prism

Status: Proposed
Created: 2026-10-22

## Requirements

No Approved requirement governs this decision yet.
It records a direction the user approved for separating Prism's machine records from human documents.

## Problem

Prism's machine records sat beside the Markdown that humans read: the roadmap record beside the roadmap view, and initiative records, coordination state, review ledgers, and change maps in the plans folders.
Those folders mixed JSON that only MCP tools may change with slice narratives, diagrams, and recovery notes that people read and review.
Skills had to name record file paths, so storage details leaked into prompts and every layout change became a skill change.
Upcoming run statistics and a later shared collaboration store need one place and one interface for machine records.
A dedicated git ref or records branch would keep records out of the working tree, but cloud sessions can push only their own branch, so such a backend fails there.

## Decision

Every Prism machine record MUST live under the project's `.prism` directory, beside the workflow configuration and without an extra nesting level.
Human Markdown MUST stay in the configured paths: slice narratives, diagrams, recovery notes, and the generated views of records.
MCP tools MUST address records by initiative and slice identifiers, and skills MUST NOT name record storage paths.
Every slice MUST have its own record folder keyed by its slug, including the root slice.
All record access MUST go through one record store in the server, so a later backend can replace the working-tree layout without changing tools or skills.
Run entries MUST be immutable once written, and a second entry with the same identifier MUST be refused.
Coordination cleanup MUST NOT remove run entries.
Records written by an earlier layout MUST move to the new layout for every initiative at once, keeping their bytes so revisions stay valid.
A legacy record whose new location already holds different bytes MUST stay in place rather than be overwritten.
Records MUST be marked as generated for the major git hosts, so pull request diffs collapse them.
Reading a record MUST NOT create files.
Source snapshots MUST exclude records, because only Prism writes them.

## Rationale

One directory separates what humans review from what tools own, and makes the boundary visible in the repository.
Identifier addressing lets tools validate every reference and keeps skills independent of storage.
Committed records travel with the branch, so cloud sessions, local checkouts, and pull requests see the same state.
Moving all initiatives at once keeps the review browser consistent, because no initiative reads from an old location while another reads from the new one.
Byte-preserving moves keep content-hash revisions, so open reviews and change maps keep their gates.

## Alternatives

A `records` level under `.prism` would add nesting without separating anything that the top level does not already separate.
A git ref or orphan records branch keeps records out of diffs, but cloud sessions cannot push custom refs.
Migrating each initiative when it is next touched would leave the review browser showing mixed layouts.
Keeping records beside their Markdown would keep storage paths in skills and keep machine JSON in human review.

## Consequences

Pull requests show records as generated files, while slice narratives and diagrams stay reviewable.
Tool inputs change from record paths to initiative and slice identifiers, which is a breaking change for callers that passed paths.
Projects upgrade automatically on the first record access, and a conflicting legacy record stays visible until a person resolves it.
A branch created before the move brings legacy records back when merged, and the next record access moves them again.
Coordination cleanup removes an initiative's coordination records through the initiative tool, while its run entries remain as history.

## Mechanism

The record store maps each record key to its location under `.prism`, checks that the location resolves inside the project, and writes atomically under a lock.
Before any record access, the store moves legacy records found in the configured plans and roadmap paths, at most once per short interval per project.
The first record write adds the generated-file attributes and an ignore rule for transient lock files beside the records.
Stored references from earlier records, such as a review's change map path, resolve to the record key they now name.
The roadmap and initiative tools keep writing their generated Markdown views in the configured paths.

## Decision Log
