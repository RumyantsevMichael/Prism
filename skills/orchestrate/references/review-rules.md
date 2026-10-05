# Review and correction rules

One reviewer covers a normal slice.
Distinct risk scopes use a pinned required lane set in the slice MCP review record.
The [review format](../../review/references/review-format.md) defines each lane record and compact result.

Each fresh `Review <slice>` worker receives the mode, lane, review path and lane, artifacts, verification evidence, and review base.
Each reviewer also receives the concept delta path and submitted or audited revision.
The delivery conversation is excluded from reviewer inputs.
Every assigned lane needs a current result before `update_review` can accept the wave.
Unresolved disagreements block acceptance.
A lane carries forward only through `carry_lane` after the server verifies unchanged inputs and observations.
Outdated evidence invalidates that lane's result.
When findings remain, the original `Develop <slice>` and `Review <slice>` workers stay available for direct correction exchange.
Each worker receives the other worker ID.
Corrected affected lanes need fresh reviewers, original finding identities, and current verification evidence.
Repeated failed corrections can require a replacement delivery worker or a new design audit.
Correction that requires `SPLIT` or redesign retains lane evidence and returns to design.

A new design audit requires changed fit, requirements, architecture, boundaries, dependencies, planned verification, or concept delta revision.
Reviewers receive verification results and probe paths without a request to rerun the complete suite.
If a finding spans slices, retain its reporting lane and route correction without transferring its identity or evidence.
If a design audit finds only implementation gaps, route them after the implementation gate.
