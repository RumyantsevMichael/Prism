# Complete a designed slice on a recorded verification run

Status: Proposed
Created: 2026-10-26

## Requirements

No Approved requirement governs this decision yet.
It records the server half of the leaner workflow tested in the October 2026 benchmark runs, where a frozen acceptance contract set delivery quality and review ceremony added cost without adding quality.

## Problem

A slice could be marked done only through an accepted implementation review that required an accepted design audit at the same change map revision.
That chain made every slice pay for a design audit, a change map, and an implementation review, whatever its risk.
The completion gate never ran the project's tests, so a slice could be done while its tests failed.
An agent could also edit the acceptance tests that encoded the agreed behavior and still pass every gate.

## Decision

A slice MAY carry an accepted design on its initiative record that lists its frozen acceptance test files with their content digests and marks whether its implementation needs review.
A slice with an accepted design MUST pass the implementation gate without a design audit.
A slice with an accepted design MUST complete only on its latest verification run when that run passed, followed the current design acceptance, and tested the current project content.
A slice whose accepted design requires review MUST also have an accepted implementation review, which MUST NOT require a design-audit wave.
A slice without an accepted design MUST keep the review-ledger gates unchanged.
A verification run MUST run only the test command that the project configures, and only after the user allowed that exact command text in the review browser.
Approvals MUST live in local plugin data, so that no repository change can approve a command.
A verification run MUST NOT run the command when a frozen acceptance test differs from its accepted digest.
A run that changes project content while it runs MUST NOT pass.
Verification runs MUST be immutable entries that outlive coordination cleanup.

## Rationale

The benchmark showed that the frozen contract, not the review rounds, separated the better runs from the worse ones, so the gate that matters is that agreed tests still hold and still pass.
Running the configured command in the server makes completion evidence something the agent cannot assert by itself.
Binding approval to the exact command text keeps a changed workflow configuration from silently widening what the server runs.
A content hash that leaves out workflow records lets agents keep writing records after a run, while any source, test, or configuration change makes the run stale.
Opt-in review keeps independent review for risky slices, such as security-heavy ones, without charging every slice for it.

## Alternatives

Letting the agent report test results was rejected because the gate would rest on an unverified claim.
Asking the server to discover how to run tests was rejected because a guess can run the wrong command, and a configured command is explicit and reviewable.
Approving commands through MCP elicitation was deferred because host support varies, and the review-browser gate already gives an answer only the user can record.
Requiring review for every slice was rejected because the benchmark found no quality gain from it on routine slices.

## Consequences

Completion now proves that the configured tests passed on the content being marked done.
Projects need a git work tree and a configured test command to use the leaner flow.
A long test suite holds a tool call open, so hosts that cannot keep it open receive an early running answer and call again to keep waiting.
A review-required slice still needs the change map that the review ledger reads until the change map is derived from commits.
Anyone who can open the review session URL can allow a command for the user, as with any other gate answer.

## Mechanism

Design acceptance records the frozen test digests and the review mark on the slice through the initiative update tool.
The verification tool reads the configured command, asks for approval through a recorded decision gate when the command text is new, and joins a run already in progress for the same slice.
Each run checks the frozen digests, hashes the project content as a git tree that leaves out records, plans, and the roadmap, runs the command in the project root with a timeout, hashes the content again, and appends its result to the slice's run entries.
The done transition and active-work gates read the latest run, recheck the frozen digests and the content hash, and add the review gate when the design requires review.

## Decision Log
