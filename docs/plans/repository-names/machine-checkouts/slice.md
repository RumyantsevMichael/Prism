# List this machine's checkouts

## Outcome

Each machine lists its checkouts of each named repository in Prism's application folder, never in the store.

## Changes

- add `src/server/workflow/machine-checkouts.mjs`: `recordCheckout`, which reads, prunes, and atomically rewrites the machine's checkout list under a lock (§26, §28-§30).
- change `src/server/workflow/repository-names.mjs`: the first accepting check of a checkout in a process records it (§27).
- change `src/server/mcp.mjs`: a server whose host names the project at start runs the name check in the background (§27).
- change `dist/server/workflow/machine-checkouts.mjs`, `dist/server/workflow/repository-names.mjs`, `dist/server/mcp.mjs`: regenerated output of the sources above.
- change `docs/user-guide/shared-records.md`: that each machine remembers its checkouts locally and never shares their paths.

The code view is [code.puml](code.puml).
