# Design values, fonts, and stored appearance

> Shipped history: initiative `review-app-ui-kit` shipped on 2026-11-09, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Changes
- add `src/server/review/public/kit/tokens.css`: every design value, copied from the mockup's values, with the light and dark themes as two value sets of the same semantic tokens, the island and glass values, and the phase, claim, and diagram colors (clauses 6, 7, 8, 9, 10, 24).
- add `src/server/review/public/kit/fonts/geist-latin-wght-normal.woff2`, `src/server/review/public/kit/fonts/geist-mono-latin-wght-normal.woff2`, `src/server/review/public/kit/fonts/OFL-Geist.txt`, `src/server/review/public/kit/fonts/OFL-Geist-Mono.txt`: the shipped fonts and their licenses, copied from the mockup's `fonts/` folder (clauses 11, 12).
- add `src/server/review/public/kit/kit.css`: base typography, focus outline, and content element styles from tokens, which later slices extend with light-DOM element styles (clauses 12, 23).
- add `src/server/review/public/kit/kit.js`: `KIT_ELEMENTS` and `defineKit()`, empty until the controls slice registers elements (clause 27).
- add `src/server/review/public/kit/boot.js`: classic script that applies the browser's last choice to `<html>` before the first paint (clause 17).
- add `src/server/review/public/kit/preferences.js`: `applyPreferences`, `loadPreferences`, `savePreferences`, and the system theme listener that keep `data-theme-choice`, `data-theme`, `data-density`, and the theme color in step (clauses 17, 18, 19).
- add `src/server/review/review-preferences.mjs`: `readPreferences` and `writePreferences` on `review-preferences.json` in the review app folder, validating values and writing atomically (clauses 13, 14, 15, 16).
- change `src/server/review/review-server.mjs`: `createProjectReview` serves `kit/` and `styles/` files with types and 404s, `kit/catalog`, and `GET`/`PUT /api/preferences` with the JSON and origin checks (clauses 1, 2, 3, 13, 14, 15).
- change `src/server/review/public/review.html`: the head loads the boot script, tokens, kit, and kit module in order, and the theme color comes from tokens (clauses 4, 19).
- change `src/server/review/public/review.css`: every color, shadow, and motion duration reads a token, the dark-mode patches and the fixed dark top bar go, and code, diagram sheets, and the index chip follow the theme (clauses 8, 9, 20).
- change `src/server/review/public/views/attention-signal.js`: the tab icon badge reads its colors from tokens at runtime (clause 8).
- add `scripts/review-kit/kit-guard.mjs`: `checkKitUsage` and the command with the `raw-value`, `control-style`, and `native-control` rules, exempting `kit/tokens.css` and `kit/plantuml-defaults.js` from `raw-value` (clauses 70, 71, 72, 73).
- change `scripts/native-build/compile.mjs`: the build copies `kit/` and `styles/` with their fonts to `dist/` byte for byte (clause 5).
- change `.github/workflows/validate.yml`: installs `playwright@1.63.0` globally and Chromium with its system dependencies before the tests, and sets `PRISM_REQUIRE_BROWSER: "1"` on the step that runs `npm test` (clause 83).
- change `dist/server/review/review-server.mjs`, `dist/server/review/review-preferences.mjs`, `dist/server/review/public/review.html`, `dist/server/review/public/review.css`, `dist/server/review/public/views/attention-signal.js`, `dist/server/review/public/kit`: regenerated output.
- change `CONTRIBUTING.md`: where design values live, that a theme is one value set, how to run the guard, and that CI runs the browser tests.
