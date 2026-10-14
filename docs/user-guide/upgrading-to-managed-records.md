# Upgrading to managed roadmap and initiative records

This release changes how Prism stores the roadmap and each initiative's slice graph.
Agents now change both only through MCP tools, and the review browser navigates by them.

## What changed

- The roadmap is a managed record, `roadmap.json`, beside the configured roadmap file, which becomes a generated view.
- Each initiative's slice graph is a managed record, `initiative.json`, in the initiative's plans folder, with a generated `initiative.md`.
- `map.puml` and `roadmap.puml` are no longer written or read as the source of truth.
- The `write-map` skill is removed; orchestration applies splits, dependencies, and slice status through the initiative record.
- `slice.md` keeps only the design narrative, because the record owns titles, outcomes, and requirement assignments.
- The initiative directory is the root slice folder, and every other slice folder sits directly under it.
- Questions that wait on you are recorded, and the review browser opens on Attention, where you can answer them.

## What migrates by itself

The next `orchestrate` run for an initiative with a `map.puml` and no `initiative.json` imports the map into the record.
The import keeps slugs, titles, statuses, dependencies, and requirement assignments, and takes each outcome from the slice's `slice.md`.

## What needs you

An existing roadmap migrates through the `roadmap` skill.
The agent proposes the record from your roadmap files, and you confirm it before anything is written.
A hand-written `roadmap.md` is replaced by the generated view only after that confirmation.
Older diagram files stay in place until you delete them.

## Answering in the browser

Attention lists every recorded question with the artifacts to inspect, including read-only source files.
In Claude Code the agent waits for your browser answer in a background tool call and resumes on its own.
The wait needs a tool timeout longer than Claude Code's background handoff: keep `MCP_TOOL_TIMEOUT` unset or above two minutes.
Elsewhere, or when the wait cannot run in the background, send any message after answering, and the agent receives the answer with it.
Anyone who can open the review page's URL can answer for you, so do not share that URL.
