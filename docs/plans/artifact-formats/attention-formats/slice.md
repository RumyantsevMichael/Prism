# Format findings on Attention

## Changes

- add `src/server/workflow/artifact-marks.mjs`: `readLegacySets`, `markLegacy`, and `removeLegacy`, the legacy sets with their authors and times (§20–§22).
- change `src/server/workflow/record-store.mjs`: the record key for legacy sets, synced like the other workspace records (§20).
- change `src/server/workflow/actions.mjs`: the targets `artifacts:<type>` and `legacy:<set id>`, the actions `artifacts.mark-legacy` and `artifacts.remove-legacy`, and a field that chooses several options (§20, §21).
- change `src/server/workflow/artifact-check.mjs`: `legacy` from the legacy sets, and a per-file cache keyed by content so Attention rereads only changed artifacts (§16, §22, §23).
- change `src/server/review/workspace-model.mjs`: `formats` in Attention, the `format-findings` item, the `formats` kind, and the `attention:formats` page and label (§17, §18, §23).
- change `src/server/review/review-server.mjs`: `attention:formats` opens through the review link and `present_review` (§18).
- change `src/server/review/public/views/attention.js`, `src/server/review/public/review.js`, `src/server/review/public/styles/workflow-views.css`: the format items with their earlier-format and no-format groups, findings, legacy sets, and actions, and the sidebar's kind row (§19).
- change `src/server/review/public/kit/elements/prism-choice.js`, `src/server/review/public/kit/catalog.js`: a choice of several options, with its catalog specimens, if the kit has none (§19, §20).
- change `scripts/review-demo/seed.mjs`: the demo's requirements, ADRs, and glossary conform, and one uncited old note shows a format finding (§17).
- change `test/server/review-places-attention.test.mjs`, `test/server/review-places-attention-browser.test.mjs`: the counts and rows that the new kind adds (§18).
- change `docs/user-guide/review-browser.md`: format findings and legacy marks on Attention (§17–§21).
