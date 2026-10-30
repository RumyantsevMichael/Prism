# Upgrading to managed roadmap and initiative records

Prism 0.10.0 changed how Prism stores the roadmap and each initiative's slice graph.
Agents change both only through MCP tools, and the review browser navigates by them.

## What changed

- The roadmap is a managed record, and the configured roadmap file becomes its generated view.
- Each initiative's slice graph is a managed record, with a generated `initiative.md` in the initiative's plans folder.
- `map.puml` and `roadmap.puml` are no longer written or read as the source of truth.
- The `write-map` skill is removed; orchestration applies splits, dependencies, and slice status through the initiative record.
- `slice.md` keeps only the design narrative, because the record owns titles, outcomes, and requirement assignments.
- The initiative directory is the root slice folder, and every other slice folder sits directly under it.
- Questions that wait on you are recorded, and the review browser opens on Attention, where you can answer them.

## What migrates by itself

The next `orchestrate` run for an initiative with a `map.puml` and no initiative record imports the map into the record.
The import keeps slugs, titles, statuses, dependencies, and requirement assignments, and takes each outcome from the slice's `slice.md`.

## What needs you

An existing roadmap migrates through `prism:workflow-init`.
The agent proposes the record from your roadmap files, and you confirm it before anything is written.
A hand-written `roadmap.md` is replaced by the generated view only after that confirmation.
Older diagram files stay in place until you delete them.

## Records under .prism

Prism now keeps every machine record in the project's `.prism` directory, beside `workflow.md`:

```text
.prism/
  roadmap.json
  initiatives/<initiative>/initiative.json
  initiatives/<initiative>/state.json
  initiatives/<initiative>/slices/<slice>/review.json
  initiatives/<initiative>/slices/<slice>/change-map.json
```

Slice narratives, diagrams, recovery notes, and the generated `roadmap.md`, `initiative.md`, and `review.md` stay in the configured paths, because those are what people read.
The first time Prism reads or writes a record, it moves every record from the earlier layout for all initiatives at once, including a `concept-delta.json`, which becomes `change-map.json`.
The move keeps each file's bytes, so open reviews and accepted gates stay valid.
Commit the moved files together with the deleted originals.
If both locations hold different versions of one record, Prism keeps both and uses the one under `.prism`; compare them and delete the older copy yourself.
Prism also writes `.prism/.gitattributes`, which marks records as generated so GitHub and GitLab collapse them in pull request diffs, and `.prism/.gitignore` for transient lock files.
MCP tools now take `initiative` and `slice` identifiers instead of record paths, so a script that passed `statePath`, `reviewPath`, or `deltaPath` needs the identifiers instead.

## Answering in the browser

Attention lists every recorded question with the artifacts to inspect, including read-only source files.
In Claude Code the agent waits for your browser answer in a background tool call and resumes on its own.
The wait needs a tool timeout longer than Claude Code's background handoff: keep `MCP_TOOL_TIMEOUT` unset or above two minutes.
Elsewhere, or when the wait cannot run in the background, send any message after answering, and the agent receives the answer with it.
Anyone who can open the review page's URL can answer for you, so do not share that URL.
