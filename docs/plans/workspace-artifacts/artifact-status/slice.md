# Status changes at approval gates

## Changes
- add `src/server/workflow/artifact-status.mjs`, `dist/server/workflow/artifact-status.mjs`: `writtenStatus`, the status records with recorded status, pending approval gates, approval, accepted version, and history, `askApproval`, `answerApproval`, which rewrites the status lines, and the kept accepted bytes (§30, §31, §33, §35, §36, §38).
- change `src/server/workflow/store-artifacts.mjs`, `dist/server/workflow/store-artifacts.mjs`: `status`, `statusMismatch`, `approval`, `acceptedVersion`, and `changedSinceAccepted` in results, the `ask_approval` operation, and `accepted` reads (§32, §33, §38).
- change `src/server/workflow/initiative.mjs`, `dist/server/workflow/initiative.mjs`: `accept_proposal` records the accepted version of the store artifacts in the accepted slices' folders (§38).
- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: Attention lists pending approval gates, `answerGate` takes the artifact form and reads the Git user name and host name, and libraries show the recorded status (§32, §34, §35).
- change `src/server/review/review-server.mjs`, `dist/server/review/review-server.mjs`: answers with `artifact_changed` and `author_unknown` return 409 (§36).
- change `src/server/review/public/views/attention.js`, `dist/server/review/public/views/attention.js`: an approval gate shows its artifact and scope and offers approve and request changes (§34).
- change `src/server/workflow/gate-wait.mjs`, `dist/server/workflow/gate-wait.mjs`, `src/server/workflow/gate-wait-requests.mjs`, `dist/server/workflow/gate-wait-requests.mjs`, `src/hooks/wait-for-gate-answers.mjs`, `dist/hooks/wait-for-gate-answers.mjs`, `src/server/mcp.mjs`, `dist/server/mcp.mjs`: `wait_for_user_gate` takes `artifact` and `scope` and waits on approval gates in both hosts (§37).
