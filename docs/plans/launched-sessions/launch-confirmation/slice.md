# Confirm launches outside the page

## Outcome

A launch needs a confirmation in a native dialog of the operating system, which opens a 30-minute launch window, and is refused where no native dialog exists.

## Changes

- add `src/server/session/launch-confirmation.mjs`: `confirmLaunch` with the decision order of clause 27, the launch window in `launches/window.json`, the one-dialog-at-a-time rule and the 30-second cool-down kept in the review app folder, and the dialog of each platform run without a shell, with its exit codes read as clause 29 says (§27-§30)
- add `dist/server/session/launch-confirmation.mjs`: the generated copy of the new module
