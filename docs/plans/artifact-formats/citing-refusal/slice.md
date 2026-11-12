# Refuse work that cites a nonconforming artifact

## Changes

- add `src/server/workflow/artifact-citations.mjs`: `citedArtifacts`, the existing artifacts that an operation's requirement references and its slice documents' links and frozen tests name, and `refuseNonconforming`, the `artifact_nonconforming` error with its migration offer (§24–§27).
- change `src/server/workflow/initiative.mjs`: `create`, `split`, `report_defect`, `add_fix`, `propose_design`, and `accept_design` check their citations before every other check (§24–§26).
- change `src/server/workflow/roadmap.mjs`: `add_initiative` and `update_initiative` check the requirement references they add (§24, §26, §27).
- change `src/server/mcp.mjs`: the `update_initiative` and `update_roadmap` descriptions name the refusal (§26).
- change `test/server/fixtures/shipped-work.mjs`, `test/server/review-entities.test.mjs`, `test/server/review-stale-tabs.test.mjs`: the requirement files they cite conform (§24).
- change `docs/user-guide/workflow.md`: why work that cites a nonconforming artifact is refused and how to ask for its migration (§26).
