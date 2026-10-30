# Review browser

The review browser shows a project's Prism artifacts and renders their diagrams locally.
Agents open it for design and correctness reviews, and you can answer recorded questions in it.

## Open the browser

Prism opens one viewer session after design audit and before final correctness confirmation.
Repeated viewer requests update that session instead of opening another browser tab.
Ask the agent to open the viewer at any time during an active session.

Start a review from a Prism checkout when no agent session is active:

```bash
./bin/prism review
./bin/prism review docs/requirements/reports.md
```

The browser opens on Attention, or on the artifact you name, and later visits restore the tabs you left open.

`Review browser: auto` in `.prism/workflow.md` uses the internal browser in desktop sessions and the system browser in CLI sessions.
Set `internal` or `external` to override this choice.
When the selected browser is unavailable, Prism presents the URL and source artifacts.

## Layout

The top bar holds the project switcher, the index status chip, and the open tabs.
The sidebar keeps Attention and Roadmap at the top and the Library, with Requirements, Decisions, and the Glossary, at the bottom.
Between them it expands only the path to what is open: the open initiative's slices or the open library section's documents.
Press `[` or the sidebar toggle to collapse the sidebar to an icon rail that keeps the Attention badge.

A link opens in the preview tab, which the next link replaces.
Ctrl-click or Cmd-click a link, double-click its tab, or choose Keep on the tab to keep it open.
Tabs that an agent presents stay open until you close them.

A banner appears when the review server stops responding, and it clears when the connection returns.

## Attention

Attention lists the questions that an agent recorded for you, with the artifacts to inspect, including read-only source files.
Answer a question on Attention or in the conversation.
In Claude Code a waiting agent resumes on its own shortly after your answer.
Elsewhere the agent receives the answer with your next message, even a short one such as "go".
Attention also lists blocked slices, open findings, and active work.

Anyone who can open the review page's URL can answer for you, so do not share that URL.
See [Upgrading to managed records](upgrading-to-managed-records.md#answering-in-the-browser) for the tool timeout that the Claude Code wait needs.

## Roadmap, initiatives, and slices

The roadmap shows initiatives as a board, a list, or a dependency graph.
The board has one lane per band and one column per state, and each card shows its priority rank within its band.
Click a lane to collapse it.
Shipped and superseded initiatives appear only with "Show shipped and superseded".

An initiative page shows its slices as a board, a list, or a graph.
The board has one column per slice status, and the card of an active slice also shows its activity, workers, and review lanes.
The list shows the slice tree, and the graph orders leaf slices by execution order.
Below them, the page lists the unstarted leaves that can be designed next.
A slice page shows the slice's change map, its review ledger, its other files, and the design narrative from `slice.md`.

The change map page starts with a readiness line that jumps to the first blocked change.
Each change has one card with its reason, its before and after references, its own problems, and its reuse evidence.
A reference opens the file, at the heading when the reference names one.
Group changes by action or by file, and blocked changes come first.
The graph mode shows the same changes as before, change, and after nodes, and a node jumps to its card.

JSON records such as the coordination state have a Structured and a Raw view.

## Documents and diagrams

Prism stores diagrams as PlantUML `.puml` source files, and the browser renders them without creating image files.
Markdown links open the linked file or heading in the review.
A link to a missing file or a target outside the project is marked as missing, and an external link opens in a new browser tab.
A document with three or more headings gets a contents list that marks the current section.

Hover over or focus any internal link to preview its target.
An initiative preview shows its state, band, intent, and progress, and a slice preview shows its status and outcome.
A link to a document section previews that section.
Graph, diagram, and document cards can be maximized, and Esc restores them.

## Find artifacts

Press Ctrl K or Cmd K, or `/`, to open the Jump palette.
It finds initiatives, slices, documents, and files by name.
A query of three or more characters also searches the text of Prism artifacts, never source files, and every word must occur in a matching file.
Opening a text match scrolls to and highlights the first occurrence.
When the match is not visible in the rendered view, try the Raw view.
In the palette, Enter opens the result in the preview tab, Ctrl+Enter keeps it open, and Esc closes the palette.

## Index status

The chip next to the project name shows the open project's native index, and its panel lists every build step.
See [Watch an index build in the review browser](repository-intelligence.md#watch-an-index-build-in-the-review-browser) for what each state means.

## Several projects

All Prism sessions of one user share one review app on one local port, and each project has its own page there.
The project switcher names the project as `repository/branch`, falls back to the worktree folder without a branch, and shows a detached checkout by its commit.
It lists recent projects under their repository, even a repository with one checkout, with their open questions, and marks the ones an agent session is using now.
When an agent presents a review for another project while a tab is open, that tab shows a notice with a link instead of a second tab opening.

The app starts with the MCP server of the first Prism session, outlives that session, and exits after 30 minutes with no session and no open viewer.
A session of a newer Prism release replaces an app of an older release on the same port, and open tabs reload into the new version.
A session never replaces a newer app.

A new session opens the review browser on its project when no review tab of any project is open.
Starting several sessions at once opens at most one window.
Cloud, CI, print-mode, and display-less sessions open nothing.
Add `- Review browser on start: off` under `## Interaction` in `.prism/workflow.md` to turn this off for a project, or set `PRISM_REVIEW_BROWSER_ON_START=off` to turn it off for every project you work on.
`Review browser: internal` also turns it off, because only the agent can open the internal browser.
It keeps its state in `~/Library/Application Support/Prism` on macOS, `%LOCALAPPDATA%\Prism` on Windows, and `$XDG_STATE_HOME/prism` or `~/.local/state/prism` elsewhere.
A session serves its project from its own review server when the shared app cannot start, and `PRISM_REVIEW_APP=off` makes every session do so.

`prism review` opens the project in the shared review app and returns.
It opens the system browser only when no review tab is open, and an open tab shows the project or a notice with a link to it instead.
When the shared app cannot start or `PRISM_REVIEW_APP=off` is set, `prism review` serves the review itself until you stop it with `Ctrl-C`.

## Security

The server binds to `127.0.0.1`, selects an available port, and uses an unguessable session URL.
It serves plain HTTP, which browsers treat as a secure context on `127.0.0.1`, so no certificate trust step is needed.
It refuses requests whose host is not `127.0.0.1` or `localhost`.
It renders entirely in the browser and does not send project sources to a remote renderer.
