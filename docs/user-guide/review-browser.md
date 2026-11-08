# Review browser

The review browser shows a project's Prism artifacts and renders their diagrams locally.
Agents open it for design and correctness reviews, and you can answer recorded questions in it.

## Open the browser

Prism opens the browser when a design waits for your approval or a question waits for your answer.
Repeated viewer requests update that session instead of opening another browser tab.
Ask the agent to open the viewer at any time during an active session.

Start a review from a Prism checkout when no agent session is active:

```bash
./bin/prism review
./bin/prism review docs/requirements/reports.md
```

The browser opens on Attention, or on the artifact you name, and later visits return to the page you left open.

`Review browser: auto` in `.prism/workflow.md` uses the internal browser in desktop sessions and the system browser in CLI sessions.
Set `internal` or `external` to override this choice.
When the selected browser is unavailable, Prism presents the URL and source artifacts.

## Layout

The browser follows the operating system's light or dark setting and changes with it while the page is open.
It shows compact density by default.
The review app keeps the theme and density for you, so every project and every later session shows the same choice.
Choose the theme and density from the **Appearance** button at the end of the status bar.
Its menu offers the themes System, Light, and Dark, the densities Compact and Comfortable, and **Component catalog**.
A choice applies at once, and System follows the operating system again.
**Component catalog** opens the review app's component catalog in a new tab, which shows every control of the interface with its options, states, and keys.
The catalog's own toolbar changes its theme, density, and width for that tab only, and stores nothing.

The top bar holds the Prism mark, the project switcher, the search button that opens the Jump palette, and **Who's working**.
The status bar at the bottom shows where the project's records live, their sync state, and the repository index.
The sidebar is the only navigation.
It lists Attention and Roadmap, every initiative with its state, the open initiative's slices or the open library section's documents, and the Library, with Requirements, Decisions, and the Glossary.
A slice that has subslices expands when you expand it or when one of its subslices is open.
At a window width of 1100 pixels or less the sidebar is hidden, and the Navigation button at the left of the top bar opens it as a drawer that closes when you choose a page.

The page bar at the top of the page holds Back and Forward and the trail of the page's place, initiative, and slice by title.
Back and Forward, Alt+Left and Alt+Right, and the browser's own buttons move through the pages you visited in that browser tab.
A page that an agent presents opens as the next page.
Prism's records and documents appear by title and kind, such as Design, Diagram, or Change map, and only repository files are named by their path.
A page whose file was moved or deleted, or whose initiative or slice no longer exists, says so and offers to close it, and it shows the page again on its own when the target comes back, for example after a checkout.
When Prism moves a record from its legacy location into `.prism/`, a page on that record follows it to the new path.

**Who's working** shows up to three avatars of the agents that hold a live claim on a slice, and how many are working.
Its popover lists every live claim and then every claim that expired, with the holder, the activity, the slice, and the time left.
The sidebar shows a claimed slice's holder at the end of its row.
Claims are read-only in the browser.

A banner appears when the review server stops responding, and it clears when the connection returns.
When the server stays silent for about 15 seconds, the banner says that the review app stopped and the page is no longer live, and actions that need the server say so instead of failing silently.
A restarted app uses a new link, so ask the agent to open the review browser to get one, or run `./bin/prism review` from a Prism checkout.
The page keeps checking and recovers on its own when the same app or its upgraded successor answers.

## Attention

Attention lists the questions that an agent recorded for you, with the artifacts to inspect, including read-only source files.
The newest question comes first, and so does the newest answer that still waits for the agent.
Answer a question on Attention or in the conversation.
Each decision and action request explains itself so you can answer without having followed the run: below the question it shows what happened, what was tried, and an example, and a decision lists what each option leads to and which option the agent recommends and why.
Prism refuses to record a decision or action request without that explanation, or a decision without a consequence for each option and a recommendation, so a question always reaches you with them.
Questions recorded by an earlier Prism version show only their question.
A design or correctness review needs Approve or Request changes, and Request changes also needs a note that says what should change.
A decision takes one of its options, a note in your own words, or both.
An action request needs only Mark as done, with an optional note.
The button that sends your answer stays disabled until the answer is complete, and the text beside it says what is missing.
While a question waits, the tab title starts with the number of waiting questions and the tab icon shows a dot, so a background tab shows it too.
Choose "Notify me about new questions" on Attention to also get a desktop notification when a question arrives while the page is in the background.
The browser keeps that permission per review app address, and a restarted review app uses a new address, so it can ask again.
In Claude Code a waiting agent resumes on its own shortly after your answer.
When you resume a session with open questions, Prism lists them for the agent with your first message, and the agent waits on them again, so later browser answers still resume it on its own.
In Codex the agent ends its turn, and Prism's Stop hook keeps the turn open for up to 55 minutes and continues it with your answer.
Codex runs that hook only after you trust Prism's current hook definition through `/hooks`.
Elsewhere, or after the 55 minutes, the agent receives the answer with your next message, even a short one such as "go".
Attention also lists blocked slices, open findings, and active work.
Under Earlier questions it shows the 20 most recently closed questions with your answer, or with the reason the agent gave when it closed a question you had not answered in the browser.

Anyone who can open the review page's URL can answer for you, so do not share that URL.
See [Upgrading to managed records](upgrading-to-managed-records.md#answering-in-the-browser) for the tool timeout that the Claude Code wait needs.

## Roadmap, initiatives, and slices

The roadmap shows initiatives as a board, a list, or a dependency graph.
The board has one lane per band and one column per state, and each card shows its priority rank within its band.
Click a lane to collapse it.
Shipped and superseded initiatives appear only with "Show shipped and superseded".

An initiative page shows its slices as a board, a list, or a graph.
The board has one column per slice status, and the card of an active slice also shows its activity, workers, and review lanes.
A slice whose design waits for your answer at its design gate shows as in design review until the agent accepts the design, even though its record still says not started.
The list shows the slice tree, and the graph orders leaf slices by execution order.
A slice that records a [component](workflow.md#components) carries a small label with its `<repository>/<component>` identity in the slice tree, on its board card, and on its slice page, and a slice without one, such as a split scope or a slice accepted before components existed, has no label.
Below them, the page lists the unstarted leaves that can be designed next, leaving out those in design review.
A slice page shows the slice's diagrams, its design from `slice.md`, the verification run, the review ledger, and every file in the slice folder.
It is the page to read at a design gate.

Every PlantUML file directly in the slice folder gets a tab above the design, with `code.puml` first when it exists.
A diagram sits on a sheet that follows the light or dark theme.

The design is `slice.md` itself, with Prism's checks placed in it.
Each contract clause shows how many frozen tests check it, and opening that count shows one plain-language example per test, each linked to its test file.
A clause that no test checks is flagged, and the count of such clauses sits at the top.
A slice of a split scope has no Contract of its own, so its page lists the scope's clauses that its Changes serve, with the same test counts.
A small model writes the examples from the contract and the tests alone, so read the linked test when an example decides your answer.
Prism checks that each example cites a real clause and a test name that occurs in its file, and marks the examples as stale when the contract or a test file changed after they were written.

Each line of the design's Changes section becomes a card.
A colored badge after the file name says whether the file is added, changed, or removed.
For a changed or removed file, the card names each function or type involved with the lines it spans in the project's code index.
Hover one to see those lines, or click it to open the file with them marked.
Line numbers come from the latest published index, so they can drift if the file changed after that build, and they are missing until the first build finishes.
In a repository with [components](workflow.md#components), they come from each component's latest index, so a file of a component that has no index yet has no line numbers.
Below the file, the card gives the reason for the change, then the contract clauses it serves and the tests cited for those clauses.
A change that names no clause supports the slice as a whole.
After a passing verification run, each card also says what the verified result actually changed, and marks each file "as planned", "partly as planned", or "planned but untouched".
Files the result changed that the Changes section does not name are listed under "Changed without a plan".
An unplanned or untouched file is not an error, but it is the first place to look.

For a slice with an accepted design, Prism derives the change map itself after a passing verification run, by comparing the source when the design was accepted with the source the run tested.
It lists the functions, sections, and files that were added, changed, or removed, and the slice page says when it is still being built.
An agent-planned change map, from slices designed before verification runs, starts with a readiness line that jumps to the first blocked change.

Each change has one card with its reason, its before and after references, its own problems, and its reuse evidence.
A reference opens the file, at the heading when the reference names one.
Group changes by action or by file, and blocked changes come first.
The graph mode shows the same changes as before, change, and after nodes, and a node jumps to its card.

Each review wave card, slice page, and initiative page shows run totals from the recorded runs: runs, wall time, elapsed and summed active time, token categories, and tool calls.
Every measure carries a visible coverage mark, such as `exact`, `approximate`, `partial`, or `unavailable`.
An unavailable measure shows `—`, never `0`, and a scope without recorded runs says "No run recorded yet."
A split parent's slice page shows its own totals and its totals with descendants.
Active time excludes idle gaps over the stated threshold, and new runs appear without reloading the page.

JSON records such as the coordination state have a Structured and a Raw view.

## Documents and diagrams

Prism stores diagrams as PlantUML `.puml` source files, and the browser renders them without creating image files.
Markdown links open the linked file or heading in the review.
A link to a missing file or a target outside the project is marked as missing, and an external link opens in a new browser tab.
A document with three or more headings gets a contents list that marks the current section.
Each heading with text under it has a fold toggle beside it, and a link or contents entry that leads into a folded section opens it.
Code in source files, Markdown code blocks, previews, and diagram source is highlighted by language.

Hover over or focus any internal link to preview its target.
An initiative preview shows its state, band, intent, and progress, and a slice preview shows its status and outcome.
A link to a document section previews that section.
A link to a PlantUML file previews the diagram drawn small enough to fit.
A file's preview has a Show in side panel button, and Alt+click on a link does the same: the whole file opens in a panel beside the current page, at the linked heading or lines.
The panel draws a PlantUML file, and the diagrams a document links, as its page does, fitted to the panel's width, with the same zoom and source controls.
The side panel holds one file at a time, so opening another replaces it, and a link inside the panel opens its target in the panel.
Open as page opens the file as the page, Esc or the close button closes the panel, and dragging its left edge sets its width.
Graph, diagram, and document cards can be maximized, and Esc restores them.

## Find artifacts

Press Ctrl K or Cmd K, or `/`, to open the Jump palette.
It finds places, initiatives, slices, requirements, decisions, glossary terms, and Prism's records by title, and repository files by path, grouped by kind.
A slice's result shows who holds a claim on it, and beside the results a preview shows the active result.
A query of three or more characters also searches the text of Prism artifacts, never source files, and every word must occur in a matching file.
Opening a text match scrolls to and highlights the first occurrence.
When the match is not visible in the rendered view, try the Raw view.
In the palette, the arrow keys move through the results, Enter opens one, and Esc closes the palette.

## Index status

The index item at the right of the status bar shows the open project's native index, and its panel lists every build step.
In a repository with components, the item combines every component's index and names the component being built, and its panel lists each component with its state.
A long component identity ends in an ellipsis, and the item's tooltip names it whole.
See [Watch an index build in the review browser](repository-intelligence.md#watch-an-index-build-in-the-review-browser) for what each state means.

## Several projects

All Prism sessions of one user share one review app on one local port, and each project has its own page there.
The project switcher names the project as `repository/branch`, falls back to the worktree folder without a branch, and shows a detached checkout by its commit.
A checkout of a workspace shows the workspace's name first, as `workspace · repository/branch`; see [Name the workspace](shared-records.md#name-the-workspace).
Checkouts whose records live in one shared store form one workspace, with the name kept in its store, or until one is set named after the store's folder or, for a remote store, after its repository, with one count of open questions and each checkout listed under it as `repository / branch`, because their roadmap, initiatives, and questions are the same, whichever repository each checkout belongs to.
Choose the workspace's name to open its records through the checkout already open, else one an agent session is using, else the one you used last.
Every checkout of a workspace shows the same roadmap, initiatives, and questions, so choose a checkout only for its own source files and index.
Every other recent project is listed under its repository, even a repository with one checkout, with its open questions.
The switcher marks the projects an agent session is using now, and lists workspaces first and then repositories, each in name order, so entries never move while you look.
When an agent presents a review for another project while a tab is open, that tab shows a notice with a link instead of a second tab opening.

The app starts with the MCP server of the first Prism session, outlives that session, and exits after 30 minutes with no session and no open viewer.
A session of a newer Prism release replaces an app of an older release on the same port, and open review pages reload into the new version.
A session never replaces a newer app.

A new session opens the review browser on its project when no review tab of any project is open.
Starting several sessions at once opens at most one window.
Cloud, CI, print-mode, and display-less sessions open nothing.
Add `- Review browser on start: off` under `## Interaction` in `.prism/workflow.md` to turn this off for a project, or set `PRISM_REVIEW_BROWSER_ON_START=off` to turn it off for every project you work on.
`Review browser: internal` also turns it off, because only the agent can open the internal browser.
It keeps its state in `~/Library/Application Support/Prism` on macOS, `%LOCALAPPDATA%\Prism` on Windows, and `$XDG_STATE_HOME/prism` or `~/.local/state/prism` elsewhere.
A session serves its project from its own review server when the shared app cannot start, and `PRISM_REVIEW_APP=off` makes every session do so.
When a session falls back on its own, its page shows a banner with the reason, and the agent's review links say that the link belongs to that session, because another session may show the same project at a different link.
Each fallback also adds a line with the time, project, and reason to `fallbacks.log` in that state directory and to the session's error output.

`prism review` opens the project in the shared review app and returns.
It opens the system browser only when no review tab is open, and an open tab shows the project or a notice with a link to it instead.
When the shared app cannot start or `PRISM_REVIEW_APP=off` is set, `prism review` serves the review itself until you stop it with `Ctrl-C`.

## Security

The server binds to `127.0.0.1`, selects an available port, and uses an unguessable session URL.
The shared app reuses the port it last bound when that port is free, so the browser keeps the site's notification permission and stored settings after a restart, while the session URL of every cold restart is new.
It serves plain HTTP, which browsers treat as a secure context on `127.0.0.1`, so no certificate trust step is needed.
It refuses requests whose host is not `127.0.0.1` or `localhost`.
It renders entirely in the browser and does not send project sources to a remote renderer.
