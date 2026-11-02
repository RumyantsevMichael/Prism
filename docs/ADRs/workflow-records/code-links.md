# Link records to the code they describe

Status: Proposed
Created: 2026-11-02

## Requirements

No Approved requirement governs this decision yet.
It records the third increment of the multi-repository roadmap milestone, which the user approved.

## Problem

Records in a [shared record store](external-record-store.md) no longer travel with a branch.
A person or agent reading a slice cannot tell which repository, branch, and commit its verified result came from.

## Decision

Every verification run and every contract-defect report MUST record the checkout it ran in: the repository identity, the origin remote, the branch, the head commit, and whether the work tree had uncommitted changes.
The repository identity MUST be the same identity the record store uses for its migration marker, and it MUST be null outside Git or before the first commit.
A recorded remote MUST NOT contain a user, password, or token.
Uncommitted changes MUST be judged on the same content that verification hashes, so Prism records, plans, and the roadmap never make a checkout dirty.
Collecting the checkout MUST NOT fail a run, and any value Git cannot tell MUST be null.
Run entries without a checkout MUST stay valid.
Slice summaries for tools and the review browser MUST show the checkout of the latest passing run as the slice's code, and MUST show none when that run predates checkouts.

## Rationale

The latest passing run is the evidence a slice completes on, so its checkout is the code the records describe.
Reusing the store's repository identity lets every clone and worktree of one repository name it the same way.
Comparing verification's own content trees keeps dirty consistent with what a run's tree already means.

## Alternatives

Recording the checkout on the initiative record would change a mutable record on every run and lose the history that run entries keep.
Asking the user for a pull request link would add a manual step that Prism cannot check without host access.
Storing the remote as configured would leak tokens that clone URLs often carry.

## Consequences

Agents and people see which branch and commit verified each slice, even when the records live in a shared store.
A run usually happens before its commit, so most recorded checkouts are dirty and name the parent of the code that will be committed.
A checkout names a commit that a rebase or a deleted branch can make unreachable.

Follow-ups remain out of scope.
Prism cannot record pull request numbers, because it has no access to the Git host.
Prism does not detect recorded commits that no longer exist.
Prism does not guard against running a slice in another repository than earlier runs, and initiatives do not yet own a repository.

## Mechanism

Before a run entry is appended, verification asks Git for the root commit, the origin URL, the symbolic branch, and the head commit, and it strips any user information from the URL.
It compares the content tree of the work tree with the same content tree of the head commit to decide whether the checkout is dirty.
`get_initiative` adds a `code` map from slice to the latest passing run's checkout, a passing `verify_slice` result carries its run's checkout as `code`, and the review browser's slice page shows one line under the verification result.

## Decision Log
