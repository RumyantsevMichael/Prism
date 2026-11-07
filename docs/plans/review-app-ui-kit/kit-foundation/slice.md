# Design values, fonts, and stored appearance

## Changes
- add `src/server/review/public/kit/tokens.css`: every design value, copied from the proposed values, with the light and dark themes as two value sets of the same semantic tokens (§5, §6, §7, §8, §9).
- add `src/server/review/public/kit/fonts/inter-latin-wght-normal.woff2`, `src/server/review/public/kit/fonts/inter-latin-ext-wght-normal.woff2`, `src/server/review/public/kit/fonts/jetbrains-mono-latin-wght-normal.woff2`, `src/server/review/public/kit/fonts/jetbrains-mono-latin-ext-wght-normal.woff2`, `src/server/review/public/kit/fonts/OFL-Inter.txt`, `src/server/review/public/kit/fonts/OFL-JetBrains-Mono.txt`: the shipped fonts from `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` 5.3.0 with their licenses (§10, §11).
- add `src/server/review/public/kit/kit.css`: base typography, focus outline, and content element styles from tokens, which later slices extend with light-DOM element styles (§11, §22).
- add `src/server/review/public/kit/kit.js`: `KIT_ELEMENTS` and `defineKit()`, empty until the controls slice registers elements (§26).
- add `src/server/review/public/kit/boot.js`: classic script that applies the browser's last choice to `<html>` before the first paint (§16).
- add `src/server/review/public/kit/preferences.js`: `applyPreferences`, `loadPreferences`, `savePreferences`, and the system theme listener that keep `data-theme-choice`, `data-theme`, `data-density`, and the theme color in step (§16, §17, §18).
- add `src/server/review/review-preferences.mjs`: `readPreferences` and `writePreferences` on `review-preferences.json` in the review app folder, validating values and writing atomically (§12, §13, §14, §15).
- change `src/server/review/review-server.mjs`: `createProjectReview` serves `kit/` and `styles/` files with types and 404s, `kit/catalog`, and `GET`/`PUT /api/preferences` with the JSON and origin checks (§1, §2, §3, §12, §13, §14).
- change `src/server/review/public/review.html`: head loads the boot script, tokens, kit, and kit module in order, and the theme color comes from tokens (§4, §18).
- change `src/server/review/public/review.css`: every color, shadow, and motion duration reads a token, the dark-mode patches and the fixed dark top bar go, and code, diagrams, and the index chip follow the theme (§7, §8, §19).
- change `src/server/review/public/views/attention-signal.js`: the tab icon badge reads its colors from tokens at runtime (§7).
- add `scripts/review-kit/kit-guard.mjs`: `checkKitUsage` and the command with the `raw-value`, `control-style`, and `native-control` rules (§55, §56, §57, §58).
- change `scripts/native-build/compile.mjs`: the build copies `kit/` and `styles/` with their fonts to `dist/` (§1).
- change `dist/server/review/review-server.mjs`, `dist/server/review/review-preferences.mjs`, `dist/server/review/public/review.html`, `dist/server/review/public/review.css`, `dist/server/review/public/views/attention-signal.js`, `dist/server/review/public/kit`: regenerated output.
- change `CONTRIBUTING.md`: where design values live, that a theme is one value set, and how to run the guard.
