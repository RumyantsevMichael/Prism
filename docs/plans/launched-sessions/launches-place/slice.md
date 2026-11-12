# Show launched sessions

## Outcome

The person sees every launched session of this computer with its state, running time, reason, and terminal command in the Launched sessions place, and stops or resumes it there.

## Changes

- add `src/server/review/public/views/launched-sessions.js`: the place's view, one row per launch view with the attributes of clause 38, the running time counted every second, the copyable resume command with its folder, the stop and resume controls through `views/actions.js`, the empty state, and the 5-second refresh (§37-§39)
- change `src/server/review/public/views/entities.js`, `src/server/review/workspace-model.mjs`: the `launches` place reference and its label, rendered by the new view (§37)
- change `src/server/review/public/review.js`: the palette's place entry `Launched sessions` with its detail (§37)
- change `src/server/review/public/views/palette.js`: the place's icon (§37)
- change `src/server/review/public/styles/workflow-views.css`: the place's layout, from kit elements and tokens only (§38)
- add `dist/server/review/public/views/launched-sessions.js`: the generated copy of the new view
- change `dist/server/review/public/views/entities.js`, `dist/server/review/workspace-model.mjs`, `dist/server/review/public/review.js`, `dist/server/review/public/views/palette.js`, `dist/server/review/public/styles/workflow-views.css`: the generated runtime of the changed sources
- change `skills/workflow/SKILL.md`: check **Common terms** `Launched session` and `Launch window` against the shipped behavior
- change `docs/user-guide/review-browser.md`: how to launch an initiative with Claude Code or Codex, the confirmation outside the browser and its 30-minute window, what each state means, how to stop, resume, or continue a session in a terminal, that a teammate's answer waits for a resume here, and that the host's own permission handling and project settings apply (§1-§19)
