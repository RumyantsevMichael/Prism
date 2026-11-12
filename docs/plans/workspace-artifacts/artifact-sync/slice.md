# Sync artifacts like records

## Changes
- change `src/server/workflow/store-artifacts.mjs`, `dist/server/workflow/store-artifacts.mjs`: an update that changed a file schedules the record store's sync (§24).
- change `src/server/workflow/record-store-sync.mjs`, `dist/server/workflow/record-store-sync.mjs`: files under `artifacts/` and the status records beside them join the files whose merge conflict keeps the upstream bytes and saves the local ones, and `takeSavedConflicts` reports a saved artifact by its location (§25).
- change `src/server/mcp.mjs`, `dist/server/mcp.mjs`: the saved-version note names a saved artifact by the checkout's path, its scope label, and the saved copy (§25).
