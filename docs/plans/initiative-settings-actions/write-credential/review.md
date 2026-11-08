# Slice review

This file is a generated view of review.json.

## implementation-review: wave-1

Verified tree: e6bf4644c8448c5bc6d60fc578f1d5e1ab968e28
Base: 0a64e65

- correctness: FINDINGS (reviewer-wc-correctness-1)
- security: CLEAN (reviewer-wc-security-1)

## implementation-review: wave-2

Verified tree: a4b58c1854209d4d43dbbcc8f58c34c1ee7a0087
Base: 0a64e65

- correctness: FINDINGS (reviewer-wc-correctness-2)
- security: CLEAN (reviewer-wc-security-2)

## implementation-review: wave-3

Verified tree: c97d43988e7e0240ea6fac2f04619f57b6a927a9
Base: 0a64e65

- correctness: FINDINGS (reviewer-wc-correctness-3)
- security: CLEAN (reviewer-wc-security-3)

## implementation-review: wave-4

Verified tree: 8d96811247e99632da90dde9edce8d147b9f2f57
Base: 0a64e65

- correctness: CLEAN (reviewer-wc-correctness-4)
- security: CLEAN (reviewer-wc-security-4)

## implementation-review/correctness/C1: Proposed verification-runs ADR still says anyone with the session URL can allow a command

- Status: VERIFIED
- Severity: low
- Evidence: Line 52 under Consequences reads 'Anyone who can open the review session URL can allow a command for the user, as with any other gate answer.' Allowing a command is a gate.answer, and after this slice the apply route refuses any request without a live write session (review-server.mjs write_forbidden check, Contract 34), so a tab opened from the session URL can only read. The ADR is Status: Proposed (not Accepted), so it can be corrected in place; the other docs that carried this sentence (review-browser.md, upgrading-to-managed-records.md, CONTRIBUTING.md) were updated in 7c8ea1c, this one was missed.
- Condition to close: slice-verification-runs.md no longer says that anyone who can open the review session URL can allow a command, and instead states that only a review tab holding a write session (one Prism opened with a grant) can allow it.
- Implementer evidence: 77ce968: slice-verification-runs.md Consequences now says only a review tab that holds a write session, which Prism opens with a one-time grant, can allow a command for the user.

## implementation-review/correctness/C2: prism review no-new-tab message points to a URL that now opens a read-only tab

- Status: VERIFIED
- Severity: low
- Evidence: When the app decides not to open a browser, cli.mjs prints the URL and 'prism review: no new browser tab opened; a review tab that is open or opening shows this project or a notice with its link, or open the URL above.' The printed URL carries no grant (Contract 35, 38), so opening it gives a read-only tab whose notice (Contract 39) tells the person to run prism review again, which again opens nothing while a writable tab is connected. The guidance offers a path that cannot make changes without saying so.
- Condition to close: The no-new-tab message of prism review no longer offers the printed URL as a way to make changes: it either drops that alternative or says that a tab opened from it can only read and that the already open review tab can make changes.
- Implementer evidence: a6cd6a2: the prism review no-new-tab message in src/server/cli.mjs (and dist) now says the open or opening review tab can make changes and that the URL above opens a tab that can only read, matching review-browser.md.

## implementation-review/correctness/C3: Review browser guide still says any open tab stops a new tab from opening

- Status: VERIFIED
- Severity: low
- Evidence: After this slice only writable viewer streams count as connected tabs (review-app-server.mjs grantOpen uses writableViewerCount; review-server.mjs claimBrowserOpen likewise), so a read-only tab no longer stops Prism from opening one. review-browser.md line 215 still says 'When an agent presents a review for another project while a tab is open, that tab shows a notice with a link instead of a second tab opening.', and line 232 says prism review 'opens the system browser only when no review tab is open, and an open tab shows the project or a notice with a link to it instead.' Both contradict the new 'Only a tab that can make changes counts as an open review tab' sentence at line 86 of the same page; the lines at 221 were updated but these two were missed.
- Condition to close: review-browser.md no longer says that any open review tab prevents a new tab from opening at a presentation or at prism review: the sentences at the presentation-notice and prism review paragraphs name a tab that can make changes (or point to Which tabs can make changes), matching line 86.
- Implementer evidence: 9cb8ae6: review-browser.md now says a presentation for another project shows a notice only while a tab that can make changes is open, and that prism review opens the system browser only when no review tab that can make changes is open, matching Which tabs can make changes; shared-review-app.md gains a 2026-11-08 Decision Log entry that a connected tab in those decisions is one that holds a write session.

## implementation-review/correctness/C4: Internal review browser guidance does not say the tab the agent opens can only read

- Status: VERIFIED
- Severity: medium
- Evidence: visual-review.md tells agents that Review browser auto uses the internal browser on desktop, and review-browser.md lines 21-22 and 225 say the same and that only the agent can open the internal browser. The agent opens the internal browser itself from the URL that get_review_url or present_review returns, which by Contract 38 carries no grant, so in desktop sessions with the default auto setting every tab the agent shows the person is read-only and cannot answer the gate that visual-review.md says to record before opening the browser. Neither the skill reference nor the user guide states this or says how to answer instead, so agents keep sending the person to a tab whose answer is refused with write_forbidden.
- Condition to close: skills/workflow/references/visual-review.md and docs/user-guide/review-browser.md state that a tab the agent opens in the internal browser from a review URL can only read, and say how the person gets a tab that can answer (present_review opening the system browser, or prism review).
- Implementer evidence: 6c2ba0b, 0afeeef: skills/workflow/references/visual-review.md tells the agent, when the internal browser shows the review or only a URL is available, to tell the user that the tab holds no write session and can only read, and that they answer in the conversation, in the system browser that present_review opens, or in the tab that prism review opens. 9cb8ae6: review-browser.md says under the Review browser setting that the internal browser tab can only read and how to answer instead, notes that presenting the review opens the system browser, and says a tab in the internal browser can only read.

## implementation-review/correctness/C5: An older-release session using the newer shared app opens a new read-only tab at each presentation

- Status: VERIFIED
- Severity: low
- Evidence: A session never replaces a newer app (shared-review-app.md; review-app-client.mjs uses any app with protocol >= its own and no older plugin version), so a session still running an earlier release presents through this app. Its client ignores the new writeGrant field and opens answer.url without a fragment, so the tab it opens never takes a write session and never counts in writableViewerCount. grantOpen and claimBrowserOpen now count only writable streams, so while that session's tabs are the only ones open, every present_review or session start it makes more than OPEN_LEASE_MS (10 s) apart is answered open: true and opens another read-only tab, where before this slice the connected tab absorbed the presentation. REVIEW_APP_PROTOCOL stays 1 and the present body carries nothing that tells the app whether the caller adds the grant.
- Condition to close: A present or session-start request from a client that does not take the grant (for example one whose body does not declare grant support, documented in review-app-protocol.schema.json) is decided with the earlier rule that counts every connected viewer stream, so it never opens a tab while any review tab is connected; a test shows such a request with only a read-only viewer connected answers open false, while a current client's request in the same state answers open true with a writeGrant.
- Implementer evidence: cf27818: current clients send acceptsGrant: true in every present request (review-app-client.mjs); review-app-server.mjs issues a writeGrant and counts only writable viewer streams only for a request that declares it, and decides any other present or session start by counting every connected viewer stream, with no grant. review-app-protocol.schema.json documents acceptsGrant in the present body. test/server/review-app.test.mjs 'a client that does not declare grant support is held back by a read-only tab while a current client opens with a grant' shows a legacy present and session start answer open false with only a read-only tab connected, and a current client then answers open true with a writeGrant. shared-review-app.md Decision Log 2026-11-08 entry, review-app-actions.md, and review-browser.md state the rule. verify_slice passed at cf27818.

