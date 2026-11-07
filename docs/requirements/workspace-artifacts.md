# Workspace artifacts

Status: Approved
Created: 2026-11-07
Approved: 2026-11-07

## Problem

Prism keeps requirements, ADRs, plans, diagrams, and the roadmap view inside each code repository, so a draft written in one checkout stays invisible to teammates and other sessions until its branch merges.
Requirements and ADRs often apply to several repositories of one workspace, but each must live in exactly one of them today, where the other repositories' agents and people do not look.
A shared record store already gives every checkout of a workspace the same machine records, while the documents those records point to stay behind in the repositories.
Michael wants the progress of every cloud and local session visible in one place, and decided on 7 November 2026 that descriptive artifacts move to the store, that Prism is where people review them, and that their status changes only at gates.

## Goals

- Keep every descriptive artifact of a workspace in its store, where every checkout and person with store access sees each change after its next sync.
- Keep the artifacts that code or verification runs in the code repository they belong to.
- Let an artifact belong to the whole workspace, one repository, or one component.
- Let people review artifact changes in Prism, against the last accepted version, instead of in a code pull request.
- Change an artifact's status only through a person's answer at a gate.
- Move a repository's existing descriptive artifacts into its store once, without losing bytes.

## Non-goals

- Access to store artifacts for agents that run without Prism.
- Moving user documentation, feature files, step definitions, frozen tests, executable contracts, or any other file that code, tests, or verification consumes.
- Publishing accepted artifacts back into code repositories.
- A hosted server, real-time editing, or per-artifact access control beyond access to the store repository.
- Changing how repositories without a configured store keep their artifacts.

## Design questions

- How agents read and write store artifacts: through Prism tools by identifier, or through a store folder path that Prism reports.
- How configured paths such as `Requirements` and `ADRs` map into the store, and how a workspace avoids two repositories using one path for different artifacts.
- Whether the merge unit for concurrent changes to one Markdown artifact is the whole file or a section.
- How references in code repositories, such as agent instructions that name `docs/ADRs`, learn about the move.

<a id="1"></a>
## 1. Keep descriptive artifacts in the store

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository's workflow configuration names a record store, Prism shall read and write that repository's requirements, ADRs, glossary, roadmap view, and plans, including slice narratives, diagrams, probes, recovery notes, and generated views, in the store instead of the checkout.

Rationale: Michael decided on 7 November 2026 that descriptive artifacts live in the store, so drafts are visible at once and artifacts shared by several repositories have one home.

Related: [shared-record-store.md§1](shared-record-store.md#1)

<a id="2"></a>
## 2. Keep executable artifacts in the code repository

Pattern: Optional feature

Disposition: Active

Requirement: Where a repository's workflow configuration names a record store, Prism shall keep that repository's feature files, step definitions, frozen tests, executable contracts, and user documentation in its checkout.

Rationale: Code, tests, and verification run these files, and user documentation ships with its product, so they must change in the same commit as the code; Michael confirmed on 31 October 2026 that tests and feature files stay in code repositories.

Related: [workspace-artifacts.md§1](#1)

<a id="3"></a>
## 3. Record each artifact's scope

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall record for each store artifact whether it belongs to the whole workspace, to one named repository, or to one named component, and treat an artifact without a recorded scope as belonging to the whole workspace.

Rationale: Requirements and ADRs often apply to several repositories, while some plans and decisions concern only one repository or component; Michael left the exact scopes negotiable, and workspace is the default he agreed to.

Related: [components.md](components.md)

<a id="4"></a>
## 4. Show artifacts by scope

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens the review browser or an agent lists artifacts from a checkout, Prism shall show the workspace's artifacts together with those scoped to that checkout's repository and its components, and label each artifact with its scope.

Rationale: People and agents working in one repository need the shared artifacts and their own, without the noise of every other repository's local plans.

Related: [workspace-artifacts.md§3](#3)

<a id="5"></a>
## 5. Move existing artifacts into the store once

Pattern: Event-driven

Disposition: Active

Requirement: When a checkout first accesses a record store that does not yet hold its repository's descriptive artifacts, Prism shall move each descriptive artifact from the checkout into the store, scoped to that repository, and report every moved file in that tool result.

Rationale: Existing workspaces such as Prism itself already keep their artifacts in code repositories, and Michael decided on 7 November 2026 that Prism's own requirements, ADRs, and plans leave its public repository.

Related: [shared-record-store.md§4](shared-record-store.md#4), [workspace-artifacts.md§6](#6)

<a id="6"></a>
## 6. Keep both copies of a differing artifact

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a checkout's artifact differs from the store's artifact at the same location when Prism moves it, then Prism shall keep the store's artifact, leave the checkout's copy in place, and report both locations.

Rationale: A second checkout or a stale branch can hold an older or diverging copy, and no move may lose bytes.

Related: [shared-record-store.md§6](shared-record-store.md#6)

<a id="7"></a>
## 7. Report references to moved artifacts

Pattern: Event-driven

Disposition: Active

Requirement: When Prism moves artifacts out of a checkout, Prism shall report each tracked file in that checkout that names a moved artifact's former path.

Rationale: Agent instructions, READMEs, and code comments in a code repository often link to `docs/ADRs` or `docs/requirements`, and those links break silently after the move.

Related: [workspace-artifacts.md§5](#5)

<a id="8"></a>
## 8. Show an artifact change against its accepted version

Pattern: Event-driven

Disposition: Active

Requirement: When a person opens an artifact that changed since its last accepted version in the review browser, Prism shall show the difference between that accepted version and the current one.

Rationale: Michael decided on 7 November 2026 that Prism, not a code pull request, is where people review artifact changes, and a reviewer needs to see what changed, as a pull request shows it.

Related: [single-review-app.md](single-review-app.md)

<a id="9"></a>
## 9. Keep review comments with the artifact

Pattern: Event-driven

Disposition: Active

Requirement: When a person comments on an artifact in the review browser, Prism shall store the comment in the store with the artifact's location and version, the commenter's Git user name and host name, and the time, and show it to every person who opens that artifact.

Rationale: Several people review shared artifacts from their own machines, so comments must travel through the store like the artifacts themselves.

Related: [shared-record-store.md§19](shared-record-store.md#19)

<a id="10"></a>
## 10. Change an artifact's status only at a gate

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a store artifact's written status differs from the status that its last gate answer recorded, then Prism shall treat the artifact as having the recorded status and report the difference with the gate that changes that status.

Rationale: Michael decided on 7 November 2026 that an artifact's status changes at gates, so an Approved requirement or Accepted ADR always records a person's decision rather than an agent's edit.

Related: [workspace-artifacts.md§11](#11), [workspace-artifacts.md§12](#12)

<a id="11"></a>
## 11. Approve requirements at their approval gate

Pattern: Event-driven

Disposition: Active

Requirement: When a person accepts a Draft requirement file or an amendment at its approval gate, Prism shall set the file's status to Approved with the approval date and record who accepted it.

Rationale: Design consumes only Approved requirements, so requirement approval stays before design, now recorded through the gate instead of an agent's edit.

Related: [workspace-artifacts.md§10](#10)

<a id="12"></a>
## 12. Accept ADRs when their initiative ships

Pattern: Event-driven

Disposition: Active

Requirement: When a person confirms that an initiative ships, Prism shall set each Proposed ADR that the initiative's contracts cite to Accepted and record, for each, the repository and commit of every slice's latest passing verification run.

Rationale: An ADR is accepted when its decision survived being built, and across repositories that code lands in commits outside the store, so the commit links replace the single commit that once held both the code and the status change.

Related: [shared-record-store.md§16](shared-record-store.md#16), [workspace-artifacts.md§10](#10)

<a id="13"></a>
## 13. Sync artifact changes like records

Pattern: Optional feature

Disposition: Active

Requirement: Where store sync is on, when an artifact write completes, Prism shall commit, merge, and push the change as it does for a record write.

Rationale: Drafts must reach teammates and other sessions without a branch merge, which is the problem this capability solves.

Related: [shared-record-store.md§7](shared-record-store.md#7)

<a id="14"></a>
## 14. Keep a concurrent artifact change

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a sync finds that the local store and its upstream changed the same artifact differently, then Prism shall keep the upstream artifact, save the local artifact's bytes in the store, and name the artifact and the saved copy in the next tool result of each Prism server that uses the store.

Rationale: Two people or sessions can edit one shared requirement or ADR at once, and neither change may be lost silently.

Related: [shared-record-store.md§12](shared-record-store.md#12), [shared-record-store.md§13](shared-record-store.md#13)

<a id="15"></a>
## 15. Refuse an artifact operation without the store

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the record store that a repository's workflow configuration names is unavailable, then Prism shall refuse every artifact read and write with an error that names the store, without falling back to the checkout's copies.

Rationale: A silent fallback would let an agent design against stale in-repository copies or write artifacts that no teammate sees.

Related: [shared-record-store.md§2](shared-record-store.md#2), [shared-record-store.md§18](shared-record-store.md#18)
