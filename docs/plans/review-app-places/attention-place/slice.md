# The Attention place

> Shipped history: initiative `review-app-places` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

Attention filters by kind and by initiative, lists failed verifications, and shows what was answered this week.

## Changes

- change `src/server/review/workspace-model.mjs`, `dist/server/review/workspace-model.mjs`: `computeAttention` adds failed verifications and answered questions, `computeNavigation` adds `places.attention`, and `parseEntityRef` reads the filtered Attention refs (§36, §37, §38, §39, §40, §41, §42, §43)
- change `src/server/review/public/review.js`, `dist/server/review/public/review.js`: `renderAttentionPlace` lists Everything, the kinds, By work with its more row, and Answered (§36, §38)
- change `src/server/review/public/views/attention.js`, `dist/server/review/public/views/attention.js`: `renderAttention` shows a filter's name and count with the way back, the failed verifications, and the answered page (§39, §40, §41)
- change `docs/user-guide/review-browser.md`: the Attention place's filters and the answered page are described (§36, §39, §40)
