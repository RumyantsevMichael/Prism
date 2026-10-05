# Delivery rules

Implementation requires an expected red checkpoint or a documentation-only exemption.
The implementation gate validates the accepted design revision and current A snapshot inside typed coordination mutations.
Delivery receives that path and revision, including after resume or replacement.
The implementation gate requires completed [visual review](../../workflow/references/visual-review.md).
Effective dependencies include inherited prerequisites and require a delivery fit recheck.
The immutable review base preserves the audited tree, including untracked files and deletions.
Every worker start, wait, resume, and replacement follows [worker-lifetime.md](worker-lifetime.md).

The review base is the design checkpoint commit with Commit on, otherwise an immutable working-tree snapshot.
Every implementation correction review compares B→F and preserves the original baseline B.
Concurrent delivery requires isolated workspaces.
Corrections do not create intermediate commits.
