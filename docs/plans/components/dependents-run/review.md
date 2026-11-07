# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: e442fcf634e9b7270522c2a437cc4e2b0967e1fe
Base: 720ab10

- correctness: FINDINGS (rev-dr-correctness-1)
- security: FINDINGS (rev-dr-security-1)

## implementation-review: wave-2

Verified tree: f255d8241a688e3576006980e74b6f0f150ee8bb
Base: 720ab10

- correctness: FINDINGS (rev-dr-correctness-2)
- security: CLEAN (rev-dr-security-2)

## implementation-review: wave-3

Verified tree: 0b1beb0c64576e5f053755f488538a11e4557a33
Base: 720ab10

- correctness: FINDINGS (rev-dr-correctness-3)
- security: CLEAN (rev-dr-security-3)

## implementation-review: wave-4

Verified tree: bbb85b8d2005e6d542afb65b7da7beba044c52a4
Base: 720ab10

- correctness: CLEAN (rev-dr-correctness-4)
- security: CLEAN (rev-dr-security-4)

## implementation-review/security/chat-approval-superset: A cloud chat approval of a reused dependents' gate allows pairs the chat question never named

- Status: VERIFIED
- Severity: medium
- Evidence: dependentsApproval reuses an open gate whenever its pairs cover the pairs still pending, so after the declaration changes the gate can list more pairs than the run needs. dependentsRun builds the approval_needed result and its cloud chat message from allowed.pending only (commands = listed(allowed.pending), asked = commands...), while the chatApproval branch calls allowAll, which approves every pair in request.pairs. So in a cloud session, where the user sees only the chat question, the quoted answer approves a command and folder that question did not name, contrary to clause 19 (the chat approval message names the command and folder) and the slice's 'allowing allows exactly the listed pairs'. Proof, a minimal test against the public verifySlice at 3168210 (kept outside the repository because this lane was told not to edit): /tmp/claude-0/-home-user/6604aaab-baf5-5ef1-9d9f-3e5c70dce33a/scratchpad/proof/chat-superset.test.mjs. With CLAUDE_CODE_REMOTE=true it opens the dependents' gate for billing (packages/billing) and web (root command in the project root), drops web's Depends on: billing, calls again and gets the same gateId with commands and message naming only packages/billing, answers with chatApproval quoting approval of billing alone, restores web's dependency, and the next dependents' run returns passed instead of approval_needed: the root command in the project root ran though no answered question named it.
- Condition to close: In a cloud session, a dependents' approval_needed result and its chat message name every pair that the chatApproval answer would allow (every pair of the gate it answers), or a chat answer allows only the pairs the returned message named; the proof test above, moved into test/server, returns approval_needed on its last call.
- Implementer evidence: 2a6b74c: an open dependents' gate is reused only while its not-yet-allowed pairs equal the pairs still to allow, so question, commands and chat message name the same pairs; regression test in dependents-run-review.test.mjs.

## implementation-review/correctness/dr-c1: A leaf component removed from the declaration leaves ship blocked while the dependents' run refuses, so the scope can never be cleared

- Status: VERIFIED
- Severity: medium
- Evidence: dependentsBlockers (roadmap.mjs) drops a leaf's recorded component that findComponent no longer finds and computes the dependents of the remaining leaves by the current declaration, but dependentsRun (verification.mjs) throws component_unknown for that same leaf before running anything. Probe: THREE plan (billing-totals/billing, shared-values/shared, web-pages/web) all done, then remove `web` (nothing depends on it) from ## Components: ship refuses dependents_blocked [{scope: work, blocked: [root/billing, root/admin], reason: not_run}] and tells the user to run verify_slice with dependents, while verify_slice {dependents: true, slice: work} refuses component_unknown. The only way out is re-declaring a component the user removed. Clause 31 judges the dependents by the current declaration, and clauses 25-27 list no component_unknown refusal for a scope's leaves (clause 27 applies clause 18's refusals to each dependent, not to the leaves).
- Condition to close: In a project whose finished scope has a leaf whose recorded component was later removed from ## Components while another leaf's component still has dependents, verify_slice with dependents true runs exactly the dependents that ship's dependents_blocked lists (the removed component adding none, as in dependentsBlockers), and after that run passes, update_roadmap ship succeeds.
- Implementer evidence: 2a6b74c: scopeDependents shared by the run and ship; a leaf whose component is no longer declared adds no dependents; regression test.

## implementation-review/correctness/dr-c2: After a decline, calling again with the same arguments while the run is still running opens a new approval gate instead of waiting for the run

- Status: VERIFIED
- Severity: medium
- Evidence: dependentsApproval deletes the declined gate's request from the approval store and returns declined keys only on that first call. The running result says to call verify_slice again with the same arguments to keep waiting, and the orchestrate skill does so, but on that call store.requests[approvalGate] is gone and the declined pairs are still unapproved, so it opens a fresh gate and returns approval_needed (the job, whose signature carries the declined marks, is never rejoined). Probe with maxWaitMs 200 (as hosts without long calls get) and a 1.5 s allowed dependent plus one declined new pair: decline -> status running; same arguments again -> approval_needed with a new gateId. Allowing that new gate then starts a second dependents' job with a different signature while the first still runs in the same work tree.
- Condition to close: With one pair declined through gate G and an allowed dependent that outlasts maxWaitMs, a first verify_slice {dependents: true, approvalGate: G} returns running, and a second call with the same arguments returns running or the finished result of that same run (components showing the declined pair as declined), opening no new gate.
- Implementer evidence: 2a6b74c: a call while a scope's dependents' run is going joins it before any approval step; a repeated call after a decline gets the finished run's result; runs in one work tree are queued; regression tests.

## implementation-review/correctness/dr-c3: Orchestrate stops instead of rerunning when ship reports a scope as not_run after a passing run

- Status: VERIFIED
- Severity: low
- Evidence: Finish step 1 reruns only scopes with no passed entry in get_initiative's dependents, and step 2 stops on any dependents_blocked until a later run passes. When a dependent is declared after a passing run (clause 31 and the user guide: reason not_run, 'a dependent was declared after it'; frozen test 'a dependent declared after the run has not run'), get_initiative still shows passed, so step 1 skips the scope, ship refuses not_run, and the skill stops and reports to the user although nothing is red and the remedy is just running the dependents again, as the refusal message itself says.
- Condition to close: skills/orchestrate/SKILL.md Finish or pause runs the dependents' run again for each scope that ship's dependents_blocked lists with reason not_run before stopping, and stops and reports only scopes whose reason is failed or whose rerun does not pass.
- Implementer evidence: 2a6b74c: orchestrate Finish or pause reruns not_run dependents and calls ship again, stopping only on failed.

## implementation-review/correctness/dr-c4: A call with the gate of a finished dependents' run returns that old run forever, so a rerun after a fix or a cancellation never runs

- Status: VERIFIED
- Severity: medium
- Evidence: 2a6b74c adds settledDependents, keyed by root, initiative and scope, holding the last run started under a gate (allowed.gateId, or the caller's approvalGate when nothing was pending). dependentsRun returns dependentsResult(settled.run) for any later call whose approvalGate equals that gate, before reading the declaration or approvals, and the entry is never invalidated: not by a later run without a gate, not by a declaration change, not when the run was cancelled. The approval_needed message and orchestrate step 5 tell the agent to call with approvalGate, and the failed, cancelled and tracked_files_changed results tell it to run the dependents again (the last literally 'Run the dependents again.') without saying to drop approvalGate, so the natural repeat call returns the stale run as if it had just run. Before the fix, the same call started a new run, because the answered gate's request is deleted and every pair is allowed. Proof against dist at 2a6b74c, kept outside the repository: /tmp/claude-0/-home-user/6604aaab-baf5-5ef1-9d9f-3e5c70dce33a/scratchpad/proof-w2/stale-gate.test.mjs. With FAIL_billing set it allows the dependents' gate G and gets failed; it unsets FAIL_billing and calls again with approvalGate G and gets failed with the same run path (no new run); the same call without approvalGate passes. So ship stays blocked while the agent sees a fresh-looking failure, and after a cancelled run every retry with the same arguments returns the cancelled run.
- Condition to close: The proof test above, moved into test/server, passes: a call with the gate of a finished run whose pairs were all allowed runs the dependents again; and a failed result of a run with declined pairs, which a call with its gate may still return, tells the caller to call verify_slice with dependents and without approvalGate to ask and run again.
- Implementer evidence: 5bb84b1: a run is remembered only when some pairs were declined, any call with another gate or none drops it, and a declined run says to call without approvalGate; three regression tests in dependents-run-review.test.mjs.

## implementation-review/correctness/dr-c5: The user guide still says a repeated call with the gate of any finished dependents' run returns that run

- Status: VERIFIED
- Severity: low
- Evidence: docs/user-guide/workflow.md line 218 says 'a call while a scope's run is still going, or a repeated call with the gate that started a finished run, returns that run instead of asking again'. Since 5bb84b1 only a finished run whose gate declined pairs is returned for that gate, a gate whose pairs were all allowed runs the dependents again, and any call with another gate or none forgets the declined run, so the next call with the old gate asks or runs instead of returning it. 5bb84b1 changed this behavior without updating the guide, which the project requires in the same change for observable behavior.
- Condition to close: docs/user-guide/workflow.md states that only a finished run with declined commands is returned for a repeated call with its gate, that a call with an allowed gate runs the dependents again, that a call without that gate asks again, and that a declined run's result says to call without approvalGate; it no longer says a repeated call with the gate of any finished run returns that run.
- Implementer evidence: efe6399: the guide says a repeated call returns a finished run only when it declined commands, that a call with an all-allowed gate runs the dependents again, and that another gate or none forgets the declined run.

