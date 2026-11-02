# Link records to the code they describe

Status: Proposed
Created: 2026-11-02

## Requirements

No Approved requirement governs this decision yet.
The Draft [shared record store requirements](../../requirements/shared-record-store.md) §14-§16 describe the behavior it implements.
It records the third increment of the multi-repository roadmap milestone, which the user approved.

## Problem

Records in a [shared record store](external-record-store.md) no longer travel with a branch.
A person or agent reading a slice cannot tell which repository, branch, and commit its verified result came from.

## Decision

Every verification run and every contract-defect report MUST record the checkout it ran in: the repository identity, the origin remote, the branch, the head commit, and whether the work tree had uncommitted changes.
The repository identity MUST be the repository's first root commit in sorted order, and it MUST be null outside Git, before the first commit, or in a shallow clone, whose oldest fetched commits only look like roots.
The repository identity is a hint for readers, and no rule may depend on it.
A recorded remote MUST keep only the scheme, host, and path of a network remote, so no user, password, token, query, or fragment is stored, and any other remote MUST be recorded as null.
Uncommitted changes MUST be judged on the same content that verification hashes, so Prism records, plans, and the roadmap never make a checkout dirty.
Uncommitted changes MUST be unknown when the run hashed no work tree, including every contract-defect report.
Collecting the checkout MUST NOT fail a run, and any value Git cannot tell MUST be null.
Run entries without a checkout MUST stay valid.
Slice summaries for tools and the review browser MUST show the checkout of the latest passing run as the slice's code, and MUST show none when that run predates checkouts.
The review browser MUST label that line as the last passing run, because the latest run shown beside it may have failed.

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

Before a run entry is appended, verification asks Git for the root commit, which each process remembers per project, the origin URL, the symbolic branch, and the head commit, and it keeps only the public parts of the URL.
It compares the content tree the run already hashed with the same content tree of the head commit, within a time limit, to decide whether the checkout is dirty.
`get_initiative` adds a `code` map from slice to the latest passing run's checkout, a passing `verify_slice` result carries its run's checkout as `code`, and the review browser's slice page shows one line under the verification result.

## Decision Log

2026-11-02: Shallow clones record a null repository identity, because a two-machine test showed that their root commits differ from a full clone's.
