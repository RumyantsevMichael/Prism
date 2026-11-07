# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: 3b7854114b49d8d2939f04e1bc05095facaca4bc
Base: 4977a14

- correctness: FINDINGS (rev-cv-correctness-1)
- security: FINDINGS (rev-cv-security-1)

## implementation-review: wave-2

Verified tree: 314ccddab597d2ceca286a71cb9f02e52f597596
Base: 4977a14

- correctness: FINDINGS (rev-cv-correctness-2)
- security: FINDINGS (rev-cv-security-2)

## implementation-review: wave-3

Verified tree: b701d1b170fc8f5a93b139c65614494bc7775314
Base: 4977a14

- correctness: FINDINGS (rev-cv-correctness-3)
- security: FINDINGS (rev-cv-security-3)

## implementation-review: wave-4

Verified tree: dc68ac9c1b0e0aa9248b9463b5555e96db7da3f0
Base: 4977a14

- correctness: FINDINGS (rev-cv-correctness-4)
- security: FINDINGS (rev-cv-security-4)

## implementation-review: wave-5

Verified tree: b2505e67efd3984b2f9d0f913c01b6aa93ea91cd
Base: 4977a14

- correctness: CLEAN (rev-cv-correctness-5)
- security: FINDINGS (rev-cv-security-5)

## implementation-review: wave-6

Verified tree: ed5f3540dbc3e0ee6bfef8b35e0af3927853ad22
Base: 4977a14

- correctness: FINDINGS (rev-cv-correctness-6)
- security: CLEAN (rev-cv-security-6)

## implementation-review: wave-7

Verified tree: 8a009f25365725d89d51a2cd1257cd8b1e88487b
Base: 4977a14

- correctness: CLEAN (rev-cv-correctness-7)
- security: CLEAN (rev-cv-security-7)

## implementation-review/security/sec-1: Boundary check fails open when Git no longer holds the start tree

- Status: VERIFIED
- Severity: medium
- Evidence: verificationRun sets boundary to unchecked and runs the command whenever crossingPaths returns null, and changedPaths (slice-gate.mjs) returns null on any git diff-tree failure, including a start tree Git has pruned. The start tree is written by contentTree through a temporary index, so no ref reaches it and git gc removes it (git gc --auto after the default two-week prune expiry, or git gc --prune=now at once). Clause 23 allows unchecked only when the slice has no start content. Reproduced with the components fixture: start billing-totals, change packages/shared/index.mjs, run git gc --prune=now, then verify_slice returns status passed with boundary unchecked and the slice completes, although the same change fails with component_boundary without the gc.
- Condition to close: For a slice whose design records startTree, a verify_slice run in which Git cannot compare the start tree with the current tree does not run the command and does not pass; for example, after git gc --prune=now on a started slice with a change in another component, verify_slice returns status failed (component_boundary or a distinct reason naming the missing start content) and the slice does not become done.
- Implementer evidence: 7f84d02: start content kept under refs/prism/<initiative>/<slice>/start; unreadable start content fails with start_content_missing without running the command (clause 23, frozen test).

## implementation-review/security/sec-2: Editing .prism/workflow.md mid-slice moves the boundary without being seen

- Status: VERIFIED
- Severity: medium
- Evidence: crossingPaths classifies changed paths with the declaration that verificationTarget reads from the work tree at verification time, while contentTree excludes .prism, so an edit to .prism/workflow.md is never itself a changed path. An implementer can add a component's folder to Shared paths, or remove or re-point another component's declaration, after starting the slice, and every earlier crossing change stops crossing. Reproduced: billing-totals started, packages/shared/index.mjs changed, verify_slice fails with component_boundary crossing [packages/shared/index.mjs]; appending packages/shared to the Shared paths line of .prism/workflow.md and calling verify_slice again returns status passed with boundary checked. The approval does not help: the command and folder are unchanged, so the earlier approval still applies.
- Condition to close: A change that crosses the slice's component under the ## Components declaration in force when the slice started still fails verify_slice with component_boundary after .prism/workflow.md widens Shared paths or changes another component's folder, or verify_slice refuses or fails a run whose declaration changed since the start; the reproduction above no longer returns passed.
- Implementer evidence: 7f84d02: start content records its declaration; paths are classified by the recorded declaration (clauses 20-21, frozen test).

## implementation-review/security/sec-3: A linked component folder runs the command outside the project

- Status: VERIFIED
- Severity: medium
- Evidence: componentPath rejects absolute and .. folders only syntactically; verificationTarget then takes realpath(path.join(root, folder)) and accepts any existing directory, inside the project or not, and execute spawns the command there. A committed symlink is enough: with vendor/ext linked to a folder outside the checkout and declared as - ext: vendor/ext, verify_slice asked for approval, and after it the command ran with cwd /tmp/probe-outside-ZNgQnw (the check.mjs log recorded that cwd), while the result and run report folder vendor/ext and boundary checked. The gate question then also stores the absolute real path of the user's machine in the initiative's coordination state, which a configured record store may share.
- Condition to close: verify_slice refuses, before any approval is asked and without running anything, a slice whose component folder's real path is not the project root or inside it (for example with component_folder_missing naming the declared folder only), so the vendor/ext link to an outside folder above returns a refusal and the check log stays empty.
- Implementer evidence: 7f84d02: folder checked after following links; outside the project root refuses with component_folder_outside before approval (clause 18, frozen test).

## implementation-review/security/sec-4: Chat approval names the declared folder, not the folder the command runs in

- Status: VERIFIED
- Severity: low
- Evidence: approval adds the real path to the browser gate question only (where), but verifySlice builds the cloud-session approval_needed message from the declared folder (`the folder ${folder}`), and the result's folder is the declared one too. In the reproduction of sec-3 with CLAUDE_CODE_REMOTE=true, the message asked the agent to get chat consent for running the command 'in the folder vendor/ext', the user's quoted answer approved it, and the command ran in the link's target. The same holds for a link inside the project, such as vendor/ext pointing at packages/other: the person consents to a folder the command does not run in. Clause 19 requires that the approval question names the folder the command runs in.
- Condition to close: When a component folder's real path differs from its declared path, the approval_needed message of a cloud session and the gate question both name the folder the command actually runs in, project-relative, and the gate question holds no absolute path of the user's machine.
- Implementer evidence: 7f84d02: result folder, browser gate question and cloud chat approval message name the followed folder project-relative, no absolute path (clause 19).

## implementation-review/correctness/C1: Another slice's finished work fails a resumed or waiting slice with component_boundary, and the implement skill then tells the implementer to move that work

- Status: VERIFIED
- Severity: high
- Evidence: crossingPaths counts every path changed since design.startTree except the frozen tests of other *unfinished* slices, as clause 21 says, and initiative.mjs keeps an existing startTree when a blocked slice is set in-progress again (the !slice.design.startTree guard), so it is not re-recorded at the restart that clause 20 describes. orchestrate step 4 continues with another eligible slice while a slice is BLOCKED, so this sequence is normal. Reproduced with the components fixture (THREE plan): set billing-totals in-progress, then blocked; set shared-values in-progress, change packages/shared/index.mjs, commit, verify (passed, done); set billing-totals in-progress, change only packages/billing/index.mjs, verify -> status failed, reason component_boundary, crossing [packages/shared/index.mjs, packages/shared/test/shared.test.mjs]. The same happens to a slice that stays in-progress while it waits on a chat approval gate. skills/implement/SKILL.md Verify step 4 now tells the implementer to move each change at the crossing paths back inside the component, which here means reverting another slice's verified work. Re-recording at restart would not fix the waiting case, and it would absorb the slice's own crossing changes made before the block, so the rule for which changes count needs a design decision.
- Condition to close: In the reproduced sequence, verify_slice for billing-totals does not fail with component_boundary for shared-values' changes or frozen tests, while a change billing-totals itself makes outside its component still fails it; and skills/implement/SKILL.md does not tell an implementer to move changes at crossing paths that its slice did not make.
- Implementer evidence: 7f84d02 + e450876: paths changed by another slice's latest passing run after this slice's start and still holding that content do not count; revised frozen-test exception; implement skill reports other work as BLOCKED instead of moving it (clause 21, frozen test).

## implementation-review/correctness/C2: In a project whose root lies below its Git top level, the boundary check reads top-level paths as project paths, so every change crosses

- Status: VERIFIED
- Severity: medium
- Evidence: contentTree copies the checkout's whole index and runs write-tree, so its tree holds paths relative to the Git top level, and changedPaths lists them as git diff-tree prints them. componentOf, underSharedPath, and unfinishedFrozenTestsOfOthers expect project-relative paths (clauses 3, 8, 21). Probe: git init in a folder top, project at top/sub with sub/packages/billing/a.mjs committed; contentTree(sub), change a.mjs, contentTree(sub); changedPaths returns ['sub/packages/billing/a.mjs'], which belongs to the root component rather than a billing component declared at packages/billing, so a billing slice would fail with component_boundary on its own change. Verification itself already works in such a project, because only tree identities were compared before this slice.
- Condition to close: For a Prism project whose root is a subfolder of its Git checkout, verify_slice of a started slice with a component passes when it changes only files in its component's folder, and fails with component_boundary listing project-relative paths when it changes another component's file, and a test covers it.
- Implementer evidence: 7f84d02: changedPaths uses rev-parse --show-prefix and diff --relative, so paths are project-relative below the Git top level (frozen test).

## implementation-review/security/sec-5: Another slice's run record passes its tree to git as an option, so a crafted record overwrites a file outside the project

- Status: VERIFIED
- Severity: medium
- Evidence: othersChanges takes the latest passing run entry of each other slice from the record store and checks only typeof entry.tree === 'string', then calls changedPaths(root, theirs.startTree, latest.tree) and changedPaths(root, latest.tree, design.currentTree), which pass it to git diff-tree as a bare argument with no --end-of-options. A run record whose tree is '--output=<file>' makes git open and truncate that file (git exits 0 with empty output, so changedPaths returns [] and nothing is reported). Run records come from the record store, which shared-records.md tells users to share with everyone on the project through a Git remote, so any store writer can truncate or create any file the victim can write, such as ~/.bashrc, the next time the victim verifies a started component slice with any change. design.startTree is regex-checked (designProblems, treeReadable) but the run's tree is not. Reproduced through verifySlice with the components fixture: /tmp/claude-0/-home-user/6604aaab-baf5-5ef1-9d9f-3e5c70dce33a/scratchpad/repro/forged-run-tree.test.mjs (node --test) starts billing-totals and shared-values, verifies shared-values, copies its run record with tree '--output=<tmp>/victim.txt' and a later finishedAt, changes packages/billing/index.mjs, verifies billing-totals, and victim.txt goes from 'precious' to empty.
- Condition to close: A run entry whose tree is not a Git object identifier (40 or 64 lowercase hex) is ignored by the other-slices exception, and every tree argument changedPaths passes to git follows --end-of-options or is validated; the reproduction above leaves victim.txt unchanged, and a test in test/server covers it.
- Implementer evidence: 652f836: treeId accepts only 40/64 lowercase hex; --end-of-options before trees; forged tree explains no change (frozen test).

## implementation-review/security/sec-6: The user guide says the refs/prism refs are never pushed or cloned, without saying they hold uncommitted files and stay after the slice is done

- Status: VERIFIED
- Severity: low
- Evidence: contentTree hashes the work tree with git add -A, so a start or passed tree holds every untracked, non-ignored file, committed or not. Before this slice those trees were unreferenced and git gc pruned them; now refs/prism/<initiative>/<slice>/start and /passed keep them reachable for as long as the slice has start content, which a done slice keeps indefinitely (only set_status not-started drops them). The guide says 'Prism never pushes these refs, and a clone does not carry them', which is true for Prism and a plain clone, but git push --mirror, a refs/* push refspec, git clone --mirror, and git bundle --all carry them, so uncommitted content, such as a local file the user never meant to commit, can leave the machine, and the guide gives no way to remove the refs.
- Condition to close: The Verification section of docs/user-guide/workflow.md says that the start and passed refs hold the project's uncommitted, untracked files too, that they stay after the slice is done, that a mirror push or clone carries them, and how to list and delete them (for example git for-each-ref refs/prism/ and git update-ref -d).
- Implementer evidence: 8a9d834: user guide Verification section covers per-checkout refs, uncommitted and untracked content, lifetime, mirror push/clone/bundle, listing and deleting, restarting.

## implementation-review/security/sec-7: Linked worktrees share refs/prism, so one worktree's start or reset of a slice moves or deletes another's start content ref

- Status: VERIFIED
- Severity: low
- Evidence: setSliceRef and dropSliceRefs write refs/prism/<initiative>/<slice>/{start,passed} in the Git common directory, which every linked worktree shares (refs outside refs/worktree, refs/bisect, and refs/rewritten are common). Without a record store each linked worktree keeps its own records (shared-records.md), so two worktrees can hold the same initiative and slice. Probe: in a repo with a linked worktree b, git update-ref refs/prism/work/s/start <tree> in the main worktree, then git update-ref -d refs/prism/work/s/start in b, and git for-each-ref refs/prism/ in the main worktree lists nothing. So starting the slice in one worktree repoints the other's start ref, and setting it not-started deletes the other's start and passed refs; after git gc the other's start tree is pruned and its verify_slice fails with start_content_missing, whose remedy (restart) absorbs that slice's earlier crossing changes into new start content. The ref name is fixed by clause 20, so the fix needs a contract decision, such as a per-checkout ref name or refs/worktree/.
- Condition to close: In two linked worktrees of one Git repository that each keep their own records and hold the same initiative and started slice, starting, verifying, or resetting the slice in one worktree leaves the ref holding the other worktree's start content in place, so after git gc --prune=now verify_slice in the other worktree does not fail with start_content_missing; or design revises clause 20 to accept this and the user guide states it.
- Implementer evidence: 652f836: refs named refs/prism/<initiative>/<slice>/<checkout>/{start,passed}; only this checkout's refs set or deleted (frozen linked-worktree test).

## implementation-review/correctness/C3: A slice started while the declaration is invalid is classified by whatever declaration is fixed later

- Status: VERIFIED
- Severity: low
- Evidence: startContent in initiative.mjs records startDeclaration only when readComponents succeeds and finds the slice's component, and otherwise records startTree and startRecordedAt without a declaration, silently; crossingPaths in verification.mjs then falls back to startDeclaration(declaration) of the work tree at verification time ('design.startDeclaration ?? startDeclaration(declaration)'), meant for slices started before declarations were recorded, and reports boundary checked. So for such a slice a ## Components edit made after the start does apply, against clause 21's 'by the declaration recorded with the start content' and 'a changed declaration applies only to slices started after it', which is the sec-2 bypass through another door. Reproduced with the components fixture and THREE plan: after planAndAccept, add a duplicate '- web: apps/web2' line to .prism/workflow.md (component_invalid), set billing-totals in-progress (design gets startTree and startRecordedAt, no startDeclaration), change packages/shared/index.mjs, then repair the declaration while appending packages/shared to the Shared paths line; verify_slice for billing-totals returns status passed with boundary checked. The same change with a valid declaration at the start fails with component_boundary crossing [packages/shared/index.mjs] (the frozen clause 21 test). The same path is taken when the declaration at the start lacks the slice's component.
- Condition to close: In the reproduction above, verify_slice for billing-totals does not return passed: either the start records a declaration that the run classifies by, or a run of a slice whose start content was recorded without a declaration does not run the command and fails or refuses with a reason and message that tell the user to set the slice back to not-started and start it again; and the user guide's Verification section says what happens to such a slice. If meeting this needs a contract revision, the implementer reports it as a contract defect against clauses 20 and 21.
- Implementer evidence: 652f836: a start recorded without a declaration fails every run with start_content_missing without running the command (frozen test).

## implementation-review/correctness/C4: The user guide says a done slice's refs are safe to delete, but deleting them makes another started slice fail with component_boundary for that slice's verified work

- Status: VERIFIED
- Severity: low
- Evidence: The Verification section ends: 'Delete only the refs of slices that are done or that you will restart, because a started slice whose start content Git has removed fails its next run with start_content_missing.' But othersChanges reads every other slice of the initiative, done ones included, and explains a path only when Git can read that slice's start tree and its latest passing run's tree, which only the done slice's start and passed refs keep; when either is gone, changedPaths returns null, the exception is skipped, and the done slice's verified changes count as this slice's changes (the C1 failure). Probe (scratch, /tmp/claude-0/-home-user/6604aaab-baf5-5ef1-9d9f-3e5c70dce33a/scratchpad/probe/done-refs.test.mjs, components fixture, THREE plan): start billing-totals, start shared-values, change and commit packages/shared/index.mjs, verify shared-values (passed, done); delete refs/prism/<initiative>/shared-values/ as the guide's second command does, git gc --prune=now; change packages/billing/index.mjs and verify billing-totals: status failed, reason component_boundary, crossing [packages/shared/index.mjs]. Following the guide's advice therefore produces the failure the implement skill answers with BLOCKED, and the deletion example 'such as a finished initiative's' is only safe once no slice of that initiative is started.
- Condition to close: The Verification section of docs/user-guide/workflow.md says that deleting a done slice's start or passed ref can make another started slice of the same initiative fail with component_boundary for that slice's verified changes, and every case it names as safe, the deletion example's 'such as' included, excludes the probe's case: it either drops a removed checkout as a case safe by itself, or limits it to a removed checkout whose initiative has no slice that is started and not done in any checkout that shares its records, or it says that deleting a removed checkout's refs can then fail that slice with component_boundary. One fix can close this finding and implementation-review/security/sec-8.
- Implementer evidence: 9cf2627: removed-checkout safe case and example removed; delete an initiative's refs only when no slice of it is started and not done in any checkout sharing the repository or its records; a single slice's refs only when it will be set back to not-started.

## implementation-review/security/sec-8: The user guide says a done slice's refs are safe to delete, which fails another unfinished slice for the done slice's verified work

- Status: VERIFIED
- Severity: low
- Evidence: The guide ends its ref commands with 'Delete only the refs of slices that are done or that you will restart'. But othersChanges (verification.mjs) explains another slice's verified work only while Git can read that slice's start content and its latest passing run's tree (changedPaths(theirs.startTree, latest.tree)), which the done slice's start and passed refs keep alive. After a user deletes a done slice's refs as the guide allows and git gc runs, an unfinished slice that started before that slice finished now fails with component_boundary listing the done slice's files, and the implement skill then returns BLOCKED for work the slice did not make. Reproduced: /tmp/claude-0/-home-user/6604aaab-baf5-5ef1-9d9f-3e5c70dce33a/scratchpad/repro3/deleted-done-refs.test.mjs (node --test, components fixture, THREE plan): start billing-totals and shared-values, change packages/shared/index.mjs, verify shared-values (passed); billing-totals passes; delete refs/prism/<initiative>/shared-values/ with the guide's for-each-ref | update-ref --stdin command and git gc --prune=now; change packages/billing/index.mjs; verify billing-totals returns failed, component_boundary, crossing [packages/shared/index.mjs]. The failure is closed, but the guide's stated safe condition is wrong.
- Condition to close: The Verification section of docs/user-guide/workflow.md states a condition for deleting a removed checkout's refs under which the rev4 reproduction cannot happen, for example that a removed checkout's refs are still needed while a checkout that shares its records has a slice of the same initiative that is started and not done, or it says that deleting a removed checkout's refs can then fail that slice with component_boundary; the done-slice warning and the other safe cases that c8d752f added stay.
- Implementer evidence: 9cf2627: same guide fix as C4; lead-in says the initiative command deletes refs of every checkout.

## implementation-review/security/sec-9: The guide allows deleting an initiative's refs while a deferred slice keeps its start content, and its recovery then drops that slice's earlier boundary crossings

- Status: VERIFIED
- Severity: low
- Evidence: 9cf2627 allows deleting an initiative's refs when 'no slice of it is started and not done', and the guide uses started for in-progress and blocked (initiative.mjs STARTED). But set_status deferred is accepted from in-progress and keeps startTree and the start ref (only not-started drops START_FIELDS), and set_status in-progress from deferred keeps that start content because it records new content only when startTree is absent. The user guide never mentions deferred. Probe against dist (Git 2.43): /tmp/claude-0/-home-user/6604aaab-baf5-5ef1-9d9f-3e5c70dce33a/scratchpad/rev5/deferred-refs.test.mjs (node --test, components fixture, THREE plan): start billing-totals (component billing), change packages/shared/index.mjs (outside billing), set billing-totals deferred; no slice is in-progress or blocked, so delete refs/prism/work/ with the guide's for-each-ref | update-ref --stdin command and git gc --prune=now; set billing-totals in-progress and verify: failed, start_content_missing (unreadable). Following the guide's recovery (set not-started, start again) then passes, because the new start content includes the earlier packages/shared change, so that crossing is never checked. The failure is closed, but the guide's stated condition allows it.
- Condition to close: The Verification section of docs/user-guide/workflow.md allows deleting an initiative's refs only when none of its slices keeps start content except done ones, for example by naming a deferred slice that was started alongside started and not done, or it says that deleting a deferred slice's refs makes its runs fail with start_content_missing after it resumes and that restarting it then counts its earlier changes as start content; the cross-checkout and single-slice rules that 9cf2627 added stay.
- Implementer evidence: fd257e1: an initiative's refs may be deleted only after it is shipped and remove_records has removed its records in every checkout sharing the Git repository, a deferred slice included.

## implementation-review/correctness/C5: The ref deletion rule requires the initiative to be shipped, so a superseded initiative's refs may never be deleted

- Status: VERIFIED
- Severity: low
- Evidence: fd257e1 changed line 114 from an example ('for example after the initiative is shipped and its records are removed') to the only allowed condition: 'Delete an initiative's refs only after the initiative is shipped and `remove_records` has removed its records'. removeRecords in src/server/workflow/initiative.mjs accepts any roadmap decision, and roadmap.mjs allows only shipped or superseded, so remove_records also removes a superseded initiative's records; the tool description says the same ('After the roadmap records the initiative as shipped or superseded, remove_records alone deletes...'). Once the records are gone, no slice of the initiative exists to read its refs: othersChanges reads only slices returned by recordedSlices, and a deferred slice's start ref is read only through its record. So a superseded initiative's refs are as safe to delete as a shipped one's, yet the guide leaves no condition under which they may be deleted, while line 89 says these refs hold uncommitted and untracked files, and line 116 tells the reader to keep a removed checkout's refs until their initiative's refs may be deleted.
- Condition to close: The ref deletion sentence in the Verification section of docs/user-guide/workflow.md allows deleting the refs of a superseded initiative on the same terms as a shipped one, for example by saying shipped or superseded, or by tying deletion only to remove_records having removed the initiative's records in every checkout that shares the Git repository; the deferred-slice reason and the single-slice and removed-checkout rules stay.
- Implementer evidence: fefc183: the deletion rule says shipped or superseded; the deferred-slice reason is kept.

