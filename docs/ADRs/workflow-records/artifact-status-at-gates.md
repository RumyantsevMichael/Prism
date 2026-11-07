# Change artifact status only at gates

Status: Proposed
Created: 2026-11-07

## Requirements

- [Workspace artifacts](../../requirements/workspace-artifacts.md) §8, §10, §11, and §12.

## Problem

Once requirements and ADRs live in a shared store, any agent can write `Approved` or `Accepted` into a file, and nothing tells a reader whether a person decided it.
Accepting an ADR used to happen in the commit that landed its code, but store artifacts change outside code repositories, and one initiative's code can land in several of them.

## Decision

Where a repository's workflow configuration names a record store, Prism MUST record each requirement's and ADR's status in the store, and only a person's answer to a gate MAY change a recorded status.
A status written into the file that differs from the recorded one MUST be treated as the recorded status and reported with the gate that changes it, and MUST NOT refuse the write.
A requirement's status MUST change at an approval gate that a person answers in the review browser, and the answer MUST record who approved it and when.
An approval MUST apply only to the version that was asked about.
An ADR MUST become Accepted only when a person confirms that an initiative whose contracts cite it ships, and Prism MUST record the repository and commit of every slice's latest passing verification run with it.
Prism MUST keep each artifact's accepted version, the bytes at its latest approval, design acceptance, or ship acceptance, so a reviewer sees what changed since.
Review comments MUST live in the store, one file per comment, with the artifact's location and version, the commenter's Git user name and host name, and the time.

## Rationale

Recording status beside the artifact, and changing it only from a recorded answer, makes Approved and Accepted mean that a person decided, whichever agent edits the file.
Reporting rather than refusing a mismatched write keeps drafting cheap and still tells the next reader the truth.
Binding an approval to a version stops a later edit from inheriting an approval it never had.
Commit links replace the single commit that once held both the code and the status change.
One file per comment never conflicts in a store merge, so comments from several machines all survive.

## Alternatives

Refusing any write of a status line would block ordinary edits of a file whose status line an agent copied unchanged.
Keeping approval gates only in an initiative's coordination state does not work for requirements, which are approved before their initiative exists.
Accepting ADRs when their slice passes verification, as before, would let an agent's call accept them without a person.

## Consequences

The status a person sees in the review browser can differ from the file's text until the gate that changes it is answered.
Shipping an initiative in a repository with a store needs a confirmation gate that the person answers in the review browser.
A machine without a Git user name cannot approve or comment until one is set.
An ADR that no contract links stays Proposed until a person approves another status for it.

## Mechanism

A status record beside each requirement and ADR keeps the recorded status, the pending approval gates, the accepted version, and the history of answers, and the accepted bytes are kept under their hash.
The review browser lists pending approval gates on Attention and applies an approval by rewriting the status lines and recording the answer.
Ship reads the links in the initiative's slice designs, rewrites each cited Proposed ADR, and records the gate and the verification commits.

## Decision Log
