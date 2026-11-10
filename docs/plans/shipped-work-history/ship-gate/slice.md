# Ship only finished work and keep its roadmap entry

> Shipped history: initiative `shipped-work-history` shipped on 2026-11-10, so this document records finished work.
> Current intent lives in Approved requirements, Accepted ADRs, the glossary, and feature files.

## Outcome

Ship refuses open work, a ready-to-ship report says why not, and a shipped roadmap entry keeps its content.

## Changes

- add `src/server/workflow/shipped-history.mjs`: `shippedDecision`, which reads an initiative's `shipped` decision from the roadmap record without importing the roadmap module, `openWork`, which lists an initiative's pending gates, live claims, and pending proposals, and `ShippedHistoryError` with clause 15's message and its `initiative` and `shippedAt`, which later slices share (§2, §4)
- change `src/server/workflow/roadmap.mjs`: `ship` checks open work after an existing decision and refuses with `open_work`, `deriveItem` reports `readyToShip: false` with an `open_work` diagnostic, `update_initiative` and `set_requires` refuse a shipped entry with `initiative_shipped`, and the `update_roadmap` description names both refusals (§1, §2, §3, §4)
- change `src/server/mcp.mjs`: `stateErrorData` passes the `gates`, `claims`, `proposals`, `initiative`, and `shippedAt` of a roadmap or shipped-history refusal, so the error data carries them (§2, §4)
- add `dist/server/workflow/shipped-history.mjs`: the generated copy of the new module
- change `dist/server/workflow/roadmap.mjs`, `dist/server/mcp.mjs`: the generated runtime of the changed sources
- change `docs/user-guide/workflow.md`: shipping refuses open gates, live claims, and pending proposals, and a shipped roadmap entry keeps its title, intent, requirements, and required initiatives (§2, §4)
