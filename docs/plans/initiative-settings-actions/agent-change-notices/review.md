# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: 17e9d9210ac326f5f60c0fa3e2b36fba19bc110c
Base: 9428c22

- correctness: FINDINGS (reviewer-acn-correctness-1)
- security: FINDINGS (reviewer-acn-security-1)

## implementation-review: wave-2

Verified tree: f6bd474031a0383b562fea2210fd25edc1df40db
Base: 9428c22

- correctness: FINDINGS (reviewer-acn-correctness-2)
- security: FINDINGS (reviewer-acn-security-2)

## implementation-review: wave-3

Verified tree: 86d28be8641fb8955563b4d23d455c28ff68eb8f
Base: 9428c22

- correctness: FINDINGS (reviewer-acn-correctness-3)
- security: FINDINGS (reviewer-acn-security-3)

## implementation-review: wave-4

Verified tree: 60054f9b12cd00bd5010c8f11b14f28fc5d82459
Base: 9428c22

- correctness: FINDINGS (reviewer-acn-correctness-4)
- security: CLEAN (reviewer-acn-security-4)

## implementation-review: wave-5

Verified tree: 509e80973d9adfd13b4d21c00d52d7fc6146d07c
Base: cb67bb1

- correctness: FINDINGS (reviewer-acn-correctness-5)
- security: FINDINGS (reviewer-acn-security-5)

## implementation-review: wave-6

Verified tree: af026ddd907f65325c7ad8f4116ee5792f1a6755
Base: d6c4478

- correctness: FINDINGS (reviewer-acn-correctness-6)
- security: CLEAN (reviewer-acn-security-6)

## implementation-review: wave-7

Verified tree: eaa199d088e246600e5b9a548a164ee96bdfcf6a
Base: cec2602

- correctness: CLEAN (reviewer-acn-correctness-7)
- security: CLEAN (reviewer-acn-security-7)

## implementation-review/correctness/C1: Parallel calls of one session show the same person change twice

- Status: VERIFIED
- Severity: medium
- Evidence: takePersonChanges and markPersonChangesShown read the shown-ids file, compute, and write it back with no lock or per-key serialization, and mcp.mjs handles each tools/call line concurrently (input.on('line', async ...)), so two parallel tool calls of one session that name the initiative (common on Claude Code, and a Claude Code background gate wait runs concurrently with every other call) both read the same shown set and both return the entry. Reproduced against dist: after a first takePersonChanges and one applied initiative.continuation action, Promise.all of two takePersonChanges calls with the same session and data folder returns the entry from both (A 1, B 1). Probe: node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/race/race.test.mjs. Clause 50 requires that no later result of this session repeats a shown entry.
- Condition to close: Concurrent takePersonChanges and markPersonChangesShown calls for the same session, project, and initiative are serialized (at least within the process, and the shown file updated under a lock), and a test that runs two parallel tool calls of one session after one person change sees the entry in exactly one result.
- Implementer evidence: 8e2e77b: shown ids and coordinator live in one per-session record updated under one lock across processes; frozen concurrency test passes.

## implementation-review/correctness/C2: keptSettings is absent from the text of update_coordination_state and checkpoint_pause results

- Status: VERIFIED
- Severity: medium
- Evidence: applyStateChange returns keptSettings, but callStateTool renders content only through stateContent, which prints validity, revision, opened and answered gates and never keptSettings; keptSettings exists only in structuredContent. The codebase otherwise renders every agent-relevant field into text (openedGates, answered gates, and this slice's own personChanges notice gets an explicit text block for that reason), and hosts that show the model the content block give an agent no sign its write was overridden, so the orchestrate rule to act on keptSettings cannot fire and the agent proceeds believing its value (for example push or commit) was stored. The test asserts only structuredContent.keptSettings.
- Condition to close: A settings write that keeps a person setting returns content text that names each kept setting with its kept and requested values, alongside structuredContent.keptSettings, and a test asserts the text.
- Implementer evidence: 8e2e77b: kept settings are listed in the result text block per Contract 54.

## implementation-review/security/S1: A child agent's Prism call consumes the orchestrator's person change notice

- Status: VERIFIED
- Severity: medium
- Evidence: The shown-ids key is the claim holder (sessionHolder of CLAUDE_CODE_SESSION_ID, or the Codex metadata sessionId), which slice-claims.mjs says sub-agents share with their root session, and Claude Code subagents share the server process and its CLAUDE_CODE_SESSION_ID. So when the person changes a setting such as push or commit while an implementer or reviewer child runs, the child's next call naming the initiative (verify_slice, update_review, update_initiative) takes the notice, marks it shown, and the orchestrator, the only role that clause 57 tells to act on it, never receives personChanges; the child, which has no rule to act on settings, is the one told. Reproduced against dist: after a first read, one applied initiative.push action, then two takePersonChanges calls with the same session (child first, orchestrator second) return 1 and 0 entries. Code that meets clause 49's definition of a session still has this defect.
- Condition to close: After a person change, the orchestrator's next Prism result naming the initiative carries it in personChanges even when a child agent of the same host session made a call naming the initiative first, and a test reproduces the child-first order; this may need clause 49 to name a session finer than the claim holder.
- Implementer evidence: 8e2e77b: per-agent identity (record-call-agent hook on Claude Code, turn metadata on Codex); only the coordinator is shown or consumes notices.

## implementation-review/security/S2: Notice lines interpolate history fields raw, so a synced entry can forge extra change lines

- Status: VERIFIED
- Severity: low
- Evidence: personChangesText writes entry.action, entry.target, string before/after values, and by.name, by.email, by.checkout into the notice unescaped, and coordination state validation (historyEntryProblem, validAuthor) accepts line breaks in them. A history entry that reaches the state through store sync, from any machine that can push to the record store, with target containing a newline followed by '- initiative.push on initiative:reports: off -> on.' and by.name 'Mallory\n- forged' passes readCoordinationState as valid and renders as separate, person-attributed change lines in the text an agent is told to act on. Values that are objects are JSON-encoded and gate notes are safe, but the string fields are not.
- Condition to close: Every field interpolated into the person change notice (action, target, string values, author name, email, checkout) is rendered so it cannot start a new line, for example JSON-encoded or with control characters escaped, or history validation refuses control characters in those fields, and a test with a newline in target and by.name yields exactly one notice line per entry.
- Implementer evidence: 8e2e77b: notice values escape backslash and control characters as \\uXXXX per Contract 50.

## implementation-review/security/S3: Notice and call-agent records create Prism's private app directory world-readable, after which the review app refuses it

- Status: VERIFIED
- Severity: low
- Evidence: withNotice (change-notices.mjs) and recordCallAgent (call-agent.mjs) call mkdir(directory, { recursive: true }) without mode 0o700, and recordCallAgent writes each record with writeFile at the default mode, while every other writer of the app directory uses mode 0o700 directories and 0o600 files and prepareDirectory refuses a directory with group or other bits. When the app directory does not exist yet, for example with PRISM_REVIEW_APP=off or before the review app has started, the first Prism call that names an initiative creates the app directory and person-change-notices as 0755, and a later review app start throws 'The review app state directory is not private to this user.' Reproduced with umask 022: node /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/acn2/dos.mjs prints 'app dir mode 755 notice dir 755' and 'review app refused'; probe.mjs in the same folder shows call-agents 755 and its record file 644. Clause 52 keeps these records in Prism's private app directory.
- Condition to close: takePersonChanges, coordinatesInitiative, takeWaitChanges, markAnswersShown, and recordCallAgent create the app directory and their subfolders with mode 0o700 (or through prepareDirectory) and write call-agent records with mode 0o600, so that after a first call on a missing app directory prepareDirectory still accepts it, and a test asserts the modes on POSIX.
- Implementer evidence: 82fca65: withNotice and recordCallAgent create their directories through the existing prepareDirectory helper (0700, refused when not private) and call-agent records are written 0600; regression test under umask 022 asserts 0700 app and record dirs, 0600 files, and prepareDirectory accepting the app dir; reviewer probe dos.mjs reports the app directory accepted; verify_slice passed.

## implementation-review/correctness/C3: An invalid read of the coordination state wipes the session's shown ids, so every entry is shown again

- Status: VERIFIED
- Severity: medium
- Evidence: readPersonHistory returns [] whenever readCoordinationState reports valid false, and withNotice then keeps only the shown ids still in that empty history and rewrites the record with shown []. Any successful call of any agent that names the initiative while the state reads invalid (for example a setting value that a newer Prism on another machine synced, or a hand edit) does this, and once the state reads valid again the coordinator's next result, or a gate wait, shows the whole history again, breaking clause 50's 'no later result of this session repeats them'. A first call while the state reads invalid likewise counts nothing as shown, against clause 51. Reproduced against dist: after one shown initiative.continuation change, a takePersonChanges call while settings.autonomy is 'bogus' (valid false), then restoring the state, returns the already shown entry again (expected 0, actual 1).
- Condition to close: When the initiative's coordination state does not read valid (or cannot be read), takePersonChanges, coordinatesInitiative, takeWaitChanges, and markAnswersShown leave the session's record unchanged (no shown ids dropped, and no first-call initialization), and a test that shows one change, reads once while the state is invalid, restores it, and calls again sees no repeated entry.
- Implementer evidence: 82fca65: readPersonHistory returns null while the coordination state reads invalid, and withNotice then shows nothing and keeps the shown ids and the first call's starting point (only a coordinator change is written); regression tests in test/server/agent-change-notices-review.test.mjs cover a shown entry surviving an invalid read and a first call while invalid setting no starting point; reviewer probe invalid.test.mjs passes; verify_slice passed.

## implementation-review/correctness/C4: A coordinator's gate wait permanently skips a person change it first sees while the state reads invalid

- Status: VERIFIED
- Severity: low
- Evidence: waitForUserGates uses readCoordinationState(...).state whether or not it reads valid (loadState returns the normalized state for a parseable invalid record), so outcome() finds the new entry and calls takeChanges; takeWaitChanges then runs withNotice, which since 82fca65 sees history null, steps on [] and returns no changes, and the wait adds the entry to known anyway, so once the state reads valid again the entry never ends the wait, although no result of the session showed it, and the wait runs on to an answer or its time limit (up to 12 hours). By the same mismatch, a wait that returns answers read from an invalid state calls markAnswersShown, which marks nothing while the state is invalid, so the coordinator's next result shows those gate.answer entries again as personChanges. Reproduced against dist: node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/acn3/wait.test.mjs (coordinator wait on a pending gate, one initiative.continuation action, state made invalid with settings.autonomy 'bogus' for 300 ms, then restored) returns timeout; the same steps without the invalid window (control.test.mjs) return changed.
- Condition to close: A coordinator's wait that polls while the coordination state reads invalid neither counts the entries it sees then as known nor takes them, so a test that applies a person change, makes the state invalid for at least one poll, and restores it gets status changed with that entry; and a wait that returns answers either does so only from a valid read or still counts their history entries as shown.
- Implementer evidence: cb67bb1: waitForUserGates now treats a read that finds the coordination state invalid like a failed read, as no new information: it neither ends the wait (no answered, changed or resolved outcome) nor initializes or advances the known entries, and the first-read unknown_gate check holds until a valid read. So the wait and the notice step (which sees no history on an invalid read) agree, and answers are returned only from valid reads, which markAnswersShown also sees. This fits clauses 50 and 53 best because an invalid read is not a sighting of history: an entry it holds is still unshown and still absent from what the wait has seen. Regression tests in test/server/agent-change-notices-review.test.mjs: 'a coordinator's wait ends on a change that first appears while the coordination state reads invalid' (fails before the fix, passes after) and 'a wait goes on, rather than ending as resolved, while the coordination state reads invalid'. Reviewer probe acn3/wait.test.mjs now returns changed. npm test 1121/1121, verify_slice passed at cb67bb1.

## implementation-review/security/S4: Notice lines write C1 control characters raw inside JSON-encoded before and after values

- Status: VERIFIED
- Severity: low
- Evidence: noticeValue escapes only U+2028 and U+2029 in a non-string value's JSON text, and JSON.stringify leaves U+007F-U+009F unescaped, while noticeString escapes that range for strings because it can start a line (U+0085 NEL is a line break for Unicode-aware readers such as Python splitlines). historyEntryProblem accepts any before and after value, so a synced entry whose after is an object with a string containing U+0085 followed by a forged '- initiative.push on ...: "off" -> "on". Changed by Owner' line renders that NEL raw into the notice text the coordinator is told to act on. Clause 50 itself only requires U+2028/U+2029 for JSON values, so code meeting it keeps the gap against its own goal that each entry is exactly one line. Probe: node /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/acn3/nel.mjs prints 'raw C1 present: true' and a splitlines-style count of 3 for heading plus one entry.
- Condition to close: Every value written into a notice line, including the JSON text of a non-string before or after value and of keptSettings values, has no raw character from U+0000-U+001F, U+007F-U+009F, U+2028, or U+2029 (for example the JSON text escapes them as \u plus four lowercase hex digits), clause 50 says so, and a test with U+0085 inside an object after value asserts the notice holds the heading plus exactly one line and no raw C1 character.
- Implementer evidence: cb67bb1: noticeValue now escapes U+007F-U+009F, U+2028 and U+2029 in a non-string value's JSON text as \u plus four lowercase hex digits (JSON.stringify already escapes backslash and U+0000-U+001F), the same set noticeString escapes in strings; keptSettingsText writes its values through noticeValue, so kept settings are covered too. Regression test 'a non-string value escapes C1 controls and line separators, so each entry is one line' puts U+0085 inside an object after value and asserts no raw C1 or separator character and heading plus exactly one line (fails before, passes after). Probe acn3/nel.mjs now prints raw C1 present: false and a splitlines-style count of 2. Clause 50's text still names only U+2028 and U+2029 for JSON values; the code meets its exactly-one-line requirement, and the orchestrator ruled no contract change is needed.

## implementation-review/correctness/C5: An answer a gate wait returns is also shown as a person change by another result of the session

- Status: VERIFIED
- Severity: low
- Evidence: The wait returns an answer from the pending gate it read, and only afterwards, in a separate step with a fresh history read, callGateWait (and the Stop hook's waitForGateAnswers) calls markAnswersShown. Between the answer landing in history and that step, which spans up to one poll plus the settle window of up to 15 s while other gates still wait, any coordinator call of the session that names the initiative (Claude Code runs a long wait in the background beside other calls) takes the gate.answer entry through takePersonChanges as personChanges, and the wait then still returns that answer, so one entry appears in two results against clause 50's 'each entry appears in at most one result or gate wait of the session' and clause 53. The same separate step also misses when the state reads invalid at markAnswersShown: withNotice then sees no history, marks nothing, and once the state reads valid the coordinator's next result shows the answers again. Reproduced against dist: node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/acn4/answer.test.mjs (coordinator wait on two gates, the person answers one, the coordinator calls get_initiative) prints wait status answered and concurrent personChanges [gate.answer] for the same gate.
- Condition to close: A gate.answer entry for a gate a coordinator's or any agent's wait returns as answered appears in no other result of the session, whether another call of the session ran while the wait settled or the state read invalid when the answers were counted, and a test like answer.test.mjs (wait on two gates, answer one, a concurrent coordinator get_initiative) sees the answer only in the wait's result.
- Implementer evidence: d6c4478 (verify_slice passed, run verification-001794153159301-68aaf7). Shared cause with C1/C3/C4: the wait and the notice step each decided 'shown' on their own (the wait from its own known set and reads, then markAnswersShown/takeWaitChanges in separate steps). Now every poll of a wait is one withNotice step (gateWaitStep in change-notices.mjs) under the per-session lock, from the same valid read; a running wait holds its gates in the session record so takePersonChanges leaves their answer entries to it, and endGateWait counts the found answer entries as shown whatever the state then reads; the wait's starting point comes from startGateWait (history ids, or the session's shown ids while invalid). Regression tests in test/server/agent-change-notices-review.test.mjs: 'an answer a wait returns is not also shown by a coordinator call made while the wait settles' (server-level, the answer.test.mjs scenario; fails on cb67bb1, passes now) and 'answers a wait finds count as shown in the step that finds them...' (concurrent call during settle shows nothing; an invalid read when the wait returns does not let the answer repeat). The acn4/answer.test.mjs probe passes against the rebuilt dist.

## implementation-review/correctness/C6: A coordinator's wait that starts while the state reads invalid misses changes made before its first valid read

- Status: VERIFIED
- Severity: low
- Evidence: Since cb67bb1 the in-call wait (callGateWait passes no knownEntries on Claude Code) sets known from its first valid read, not from the history it held when it started, so when the wait starts while the coordination state reads invalid, every entry that arrives before the first valid read, for example a person change applied or synced in the poll interval after the state is restored, joins known and never ends the wait, although clause 53 ends it on an entry 'whose id it did not hold when the call started'. The deferred Codex path reads knownEntries at the start with historyIds and is not affected. Reproduced against dist: node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/acn4/startinvalid.test.mjs (break the state, start a coordinator wait with pollMs 1000, restore the state, apply initiative.continuation) returns timeout instead of changed.
- Condition to close: A coordinator's wait that starts while the state reads invalid ends with changed on a person change that arrives after the call started and before the wait's first valid read, as startinvalid.test.mjs asserts, while C4's regression tests still pass.
- Implementer evidence: d6c4478 (verify_slice passed, run verification-001794153159301-68aaf7). Shared cause with C1/C3/C4: the wait and the notice step each decided 'shown' on their own (the wait from its own known set and reads, then markAnswersShown/takeWaitChanges in separate steps). Now every poll of a wait is one withNotice step (gateWaitStep in change-notices.mjs) under the per-session lock, from the same valid read; a running wait holds its gates in the session record so takePersonChanges leaves their answer entries to it, and endGateWait counts the found answer entries as shown whatever the state then reads; the wait's starting point comes from startGateWait (history ids, or the session's shown ids while invalid). Regression tests: 'a coordinator's wait that starts while the state reads invalid ends on a change made before its first valid read' (startGateWait while invalid returns the shown ids, the wait ends changed and the change is not shown again) and 'a wait that starts with no known entries holds what the session was shown, not its first valid read'. The acn4/startinvalid.test.mjs probe passes takeChanges, which no longer exists (the wait now takes notices and watchChanges), so its scenario is carried by these tests; C4's tests still pass.

## implementation-review/security/S5: Any agent's gate wait can name a resolved gate and hide its answer from the coordinator's personChanges for the whole wait

- Status: VERIFIED
- Severity: medium
- Evidence: gateWaitStep writes holding = { gates: [...gateIds] } with every id the caller passed, whether or not the gate is still pending, and takePersonChanges drops each gate.answer entry whose target any running wait holds. A wait can only return answers for gates present in pending, so an answer to a gate that was answered and then resolved (or any gate id the caller names that is no longer pending) is withheld from the coordinator for the wait's full life, up to MAX_WAIT_MINUTES plus 60 s, renewable by repeating the wait, and on Codex for WAIT_REQUEST_TTL_MS after deferral; a sub-agent's wait (which must count nothing as shown beyond its own answers) thus suppresses an entry the coordinator has not been shown. Probe: after a first take, answer the review gate, resolve it, start a non-coordinating wait on [decision, review]; the coordinator's takePersonChanges during the wait returns [], and returns the gate.answer only after the wait ends. node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/probe/p1.test.mjs prints 'during wait coordinator sees: []' then 'after wait coordinator sees: [ gate.answer ]'.
- Condition to close: A wait holds in the session record only gates that are pending at that step (so only answers it can itself return are left to it), and a test that answers and resolves a gate, starts another agent's wait naming that gate plus a pending one, and calls takePersonChanges for the coordinator during the wait sees the resolved gate's answer entry.
- Implementer evidence: cec2602: gateWaitStep now holds only the waited gates that are pending in the state it reads (and the answer entries it found, which it can still return); an invalid read keeps what it held. Regression test 'a wait that names an answered and resolved gate does not hold its answer from the coordinator' in test/server/agent-change-notices-review.test.mjs fails on d6c4478 and passes now; verify_slice passed (verification-001794154726293-66476b).

## implementation-review/security/S6: A wait whose server process dies keeps its gates held until its original deadline, hiding their answers from the coordinator for up to a day

- Status: VERIFIED
- Severity: low
- Evidence: Each gateWaitStep sets the hold's until to deadline + HOLD_MARGIN_MS (deadline = start + maxWaitMinutes, default 720 and up to 1440 minutes) and nothing ties it to the waiting process being alive, so when the host kills or restarts the server mid-wait (the clause 52 case) endGateWait never runs and every later call of the session, including the restarted server's coordinator calls, leaves answers to those gates out of personChanges until that deadline. Probe: a child process starts a 720-minute wait on the review gate with the session's notice directory and is SIGKILLed after 1 s; the person then answers the gate and the coordinator's takePersonChanges returns []. node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/probe/p2.test.mjs prints 'coordinator after killed waiter: []'.
- Condition to close: A running wait's hold is a short lease that each poll renews (bounded by a few poll intervals or minutes, not by the wait's deadline), so a hold whose process stopped lapses within that bound, and a test that kills a waiting process, answers its gate, and calls takePersonChanges after the lease bound sees the answer entry.
- Implementer evidence: cec2602: each poll renews the hold for a short lease (max(15 s, 10 polls), replacing deadline + 60 s); a deferred Codex hold lasts 2 minutes unless the Stop hook's wait renews it under the same wait id; the MCP close handler awaits every running gate wait's endGateWait (Promise.allSettled) within CLOSE_GRACE_MS before process.exit. Regression tests 'the hold of a wait whose process was killed lapses after its lease' and 'a server that closes mid-wait lets go of the wait's gates before it exits' fail on d6c4478 and pass now; verify_slice passed.

## implementation-review/correctness/C7: A wait whose server stops or is restarted keeps its gates held for its whole time limit, hiding their answers from every result of the session

- Status: VERIFIED
- Severity: low
- Evidence: gateWaitStep writes the wait's holding with until = deadline + 60 s (deadline defaults to 720 minutes, at most 1440), readWaits keeps any wait with until > now regardless of whether its process lives, and takePersonChanges leaves every gate.answer entry of a held gate unshown. Only endGateWait in waitForUserGates' finally removes the hold, and when the host closes the server's input (how it ends or restarts the server, clause 52) the close handler aborts the waits but calls process.exit(0) once its own cleanup finishes, without awaiting the waits' finally, so the hold is left. A server the host restarts in the same session then serves coordinator results that omit the answer to that gate for up to 12 hours, although no result or gate wait of the session showed it. Reproduced against dist: node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/acn5/restart.test.mjs (coordinator wait_for_user_gate on one gate, close the server's stdin, record still holds the wait with until 12 h ahead, start a second server in the same session, answer the gate, get_initiative) prints personChanges [] where clause 50 expects [gate.answer]. A process killed outright leaves the same hold.
- Condition to close: The fix for implementation-review/security/S6 also covers a server whose input the host closes: in the restart.test.mjs scenario (coordinator wait, close the server's stdin, second server in the same session, answer the gate), a coordinator get_initiative made once the hold's lapse bound has passed, or at once if the closing server removes its holds before exiting, carries the gate.answer entry in personChanges, while the C5 regression tests still pass.
- Implementer evidence: Same cause as S6, fixed in cec2602: lease renewed per poll so a dead process's hold lapses quickly, and graceful close awaits releasing holds before exit (bounded by the close grace). Regression tests for the killed waiter and the closed server in test/server/agent-change-notices-review.test.mjs fail on d6c4478 and pass now; verify_slice passed.

## implementation-review/correctness/C8: A wait aborted by a graceful close (or a cancel) polls once more and can end answered or changed, counting entries as shown in a result nobody receives

- Status: VERIFIED
- Severity: low
- Evidence: The close handler now aborts each wait and awaits it to completion (endingWaits). In waitForUserGates the aborted sleep resolves and the loop runs poll() again before it checks signal.aborted, and a poll already in flight completes too; if that poll finds the gates answered with none waiting it returns status answered, and the finally calls endGateWait with cancelled false, which adds the answer entries to shown; a changed result counts its changes as shown inside the gateWaitStep itself. The server then exits without the host reading the result, so the person's answer entry or change is never shown by any result of the session, against clause 50 and 53 where an entry counts as shown only when a result or wait delivers it. Reproduced against dist: node --test /tmp/claude-0/-home-user/6ba58b90-df01-534d-9847-3e513a6e0171/scratchpad/repro/abort.test.mjs (wait with notices and a signal, answer the gate after the first poll, abort) prints status answered and a later takePersonChanges returns [], where a cancelled end would have left the gate.answer for it.
- Condition to close: A wait whose signal is aborted ends cancelled without counting any answer or change as shown, even when an answer or change arrives between its last poll and the abort or during an in-flight poll, and the abort.test.mjs scenario (answer after the first poll, then abort) returns status cancelled and a later takePersonChanges of the session returns the gate.answer entry.
- Implementer evidence: Commit d23a6bd: the wait's decide step, which runs under the notice lock inside gateWaitStep, now returns { status: "cancelled" } with no answers or changes once the signal is aborted (src/server/workflow/gate-wait.mjs), so a poll that runs or finishes after the abort marks nothing as shown, the loop returns cancelled, and endGateWait(cancelled: true) leaves the answer for a later result. Regression test 'a wait aborted after an answer is recorded ends cancelled and leaves the answer for a later result' in test/server/agent-change-notices-review.test.mjs fails without the fix and passes with it; the reviewer probe now reports cancelled. npm test 1130/1130 pass, check:native clean, claude plugin validate --strict passes, verify_slice passed at d23a6bd (run verification-001794155746336-87eff0).

