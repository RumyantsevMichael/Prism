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

The browser opens on Attention, or on the artifact you name, and later visits restore the tabs you left open.

`Review browser: auto` in `.prism/workflow.md` uses the internal browser in desktop sessions and the system browser in CLI sessions.
Set `internal` or `external` to override this choice.
The agent opens the internal browser on a review URL that carries no grant, so that tab can only read, as [Which tabs can make changes](#which-tabs-can-make-changes) explains.
Answer the agent in the conversation instead, or ask it to present the review, which opens the system browser, or run `prism review` in the project.
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
The status bar at the bottom shows where the project's records live, naming a shared store, their sync state, and the repository index.
The sidebar is the only navigation.
It lists Attention with its count and Roadmap, then each planned or in-progress initiative and the open initiative whatever its state, then the open library section's documents, and the Library, with Requirements and Decisions and their counts and the Glossary.
An initiative's row shows its state as a round glyph and its shipped leaf slices out of all, such as `0/4`, and its slices nest below it, each with a triangle in the color of its phase, its holder, and a warning mark when it is blocked.
Hover or focus a row to see its full title with its status, its phase, and its claim; the Roadmap lists every initiative, including shipped and envisioned ones.
An initiative or a slice that has subslices expands when you expand it, when it leads to the open page, or when one of its slices is in progress, blocked, or claimed.
Every row is a link, so a middle-click or a Shift click opens the page in a new browser tab or window, and the browser's context menu can copy its address; a crumb of the page bar works the same way.
Above 1100 pixels, press `[` or use the sidebar button at the left of the top bar to collapse the sidebar to a rail of icons that keeps the Attention count, and again to expand it; the browser remembers the choice.
At a window width of 1100 pixels or less the sidebar is hidden, and the Navigation button at the left of the top bar opens it as a drawer that closes when you choose a page; the bell at the right of the top bar keeps the Attention count.
If you narrow the window past that width while the sidebar has the focus, the focus moves to the Navigation button.

The top of the main area holds a tab for each open page.
A link opens in the preview tab, whose title is italic, and the next link replaces it.
Ctrl-click or Cmd-click a link, double-click or middle-click a link in a page, press Ctrl+Enter or Cmd+Enter in the Jump palette, or choose Open as tab in the side panel to open a tab that stays open.
Double-click the preview tab or choose its Keep button to keep it open.
A new tab opens right after the selected tab.
Close a tab with its close button or a middle click, and when you close the last tab the page says that nothing is open.
Tabs that an agent presents carry the agent mark and stay open until you close them, and a presentation of several artifacts opens a tab for each of them and shows the first.
The open tabs belong to the session, so every browser window of the session shows the same tabs, and a reload or a later visit restores them.
When tabs do not fit, the strip scrolls sideways and keeps the selected tab in view, and a long title ends with an ellipsis whose full text shows on hover or focus.
With the focus on a tab, the arrow keys, Home, and End move between tabs, Enter opens one, and Tab reaches that tab's Keep and close buttons.

The page bar below the tabs holds Back and Forward and the trail of the page's place, initiative, and slice by title.
Back and Forward, Alt+Left and Alt+Right, and the browser's own buttons move through the pages you visited in that browser tab, and the address names the selected tab.
A page that an agent presents opens as the next page.
Prism's records and documents appear by title and kind, such as Design, Diagram, or Change map, and only repository files are named by their path.
A tab whose file was moved or deleted, or whose initiative or slice no longer exists, is dimmed and struck through, and its page says so and offers Close tab.
The tab and its page return to normal on their own when the target comes back, for example after a checkout.
When Prism moves a record from its legacy location into `.prism/`, a tab on that record follows it to the new path.

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
Under Recent changes it shows the 20 newest actions applied from the review app, newest first: setting changes and answers of every initiative in the project's records, and index rebuilds of this checkout.
Each change shows the value before and after it, the author's Git name, or email when no name is set, and the checkout label and host the change came from.
A change applied in any tab joins the top of the list at once, also a setting change or answer from another checkout whose records live in the same record store, while another checkout's index rebuild never appears.
A change that a record store sync brings from another machine appears the next time Attention loads.

Only a tab that Prism opened can answer; see [Which tabs can make changes](#which-tabs-can-make-changes).
See [Upgrading to managed records](upgrading-to-managed-records.md#answering-in-the-browser) for the tool timeout that the Claude Code wait needs.

## Changes you make in the page

Every change that the review page makes to Prism's records is an action: answering a question, changing an initiative setting, or rebuilding an index.
The page sends each action with the version of the record it showed you, so when an agent or another tab changed that record in the meantime, Prism refuses your action and changes nothing.
An action changes only Prism's records, and apart from a rebuild starting Prism's own indexer, it never runs a command, changes a project file, or writes to Git.

### Which tabs can make changes

Only a tab that Prism opened for you can make changes.
When Prism opens the browser, for a presentation, a session start, or `prism review`, the address it opens carries a one-time grant after `#write=`, which the tab exchanges for a write session as it loads and then removes from its address.
The grant works once and only within two minutes, and the write session stays with that one browser tab, also across reloads and when you switch it to another checkout of the same review app.
A review URL that an agent prints, or that a tool returns, carries no grant, so a tab opened from it, a second tab on the same address, or a bookmark can only read.
A read-only tab says `This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.`, and its controls are disabled.
To get a tab that can make changes, run `prism review` in the project, or ask the agent to present the review, which opens the system browser, while no tab that can make changes is open.
The review app keeps the write sessions it issued when a newer session replaces it on the same port, and accepts none after it exits and starts again, so after such a restart open the review again the same way.
Only a tab that can make changes counts as an open review tab, so a read-only tab never stops Prism from opening a tab that can.
A session of an earlier Prism release that presents through a newer review app opens only tabs that can read, so for that session any open review tab still counts and it opens no further tab.

Prism records each action with when it happened and who made it.
The author is the `user.name` and `user.email` that Git reports in the checkout whose page you used, with that checkout's `repository/branch` label and this machine's host name.
That author is what the checkout's Git configuration claims, so Prism shows it as information and never as proof of who made the change.
Answers and setting changes go into the initiative's history, which every checkout of a workspace shares, and which keeps the newest 200 entries.
An index rebuild goes into the checkout's own index history, `index-history/<checkout>.json` in Prism's state directory, which stays on this machine.

An initiative has these settings, each with its default and the moment an agent acts on a change:

| Setting | Values | Default | Takes effect |
| --- | --- | --- | --- |
| Autonomy | `conservative`, `broad`, `full` | `conservative` | Decides which later gates wait for you; a gate already open keeps waiting for you. |
| Commit | `off`, `on` | `on` with `full` autonomy, otherwise `off` | For child sessions started after the change. |
| Push | `off`, `on` | `off` | For child sessions started after the change. |
| Continuation | `auto`, `stepwise` | `auto` | When the slice in progress finishes. |
| Review | `marked`, `recommended`, `all` | `marked` | Sets the review mark of slices whose design is not yet accepted. |
| Models | `host defaults`, or a delivery, review, and security review model with an optional examples model | `host defaults` | For child sessions started after the change. |

Turning autonomy to `full`, commit on, or push on asks you to confirm first, because it lets agents act further without you.

Every setting can change at any time, including after work on the initiative started.

### Initiative settings card

The initiative page ends with an **Initiative settings** card, and on every slice page of the initiative the card opens from **Details and settings** at the end of the page bar, below the slice's details.
An initiative whose record cannot be read and that the roadmap does not list has no settings, so its page shows no card.
On a slice page the card names the initiative above its title, because the settings belong to the whole initiative and a change there applies to every slice.
Each setting shows its options as a button group, the sentence on when a change takes effect, and for an on or off setting what the picked option does.
Picking an option applies it at once, except for Models, whose model names you type and then send with **Apply** or Enter; **Reset** drops what you typed.
Choosing **Custom** for Models shows the delivery, review, security review, and examples model fields, and **Apply** stays disabled with a hint such as `Fill in Delivery model.` until every required name is filled in.
A change that needs your confirmation opens a dialog that says what it lets agents do, with **Confirm** and **Cancel**; Esc or **Cancel** leaves the setting as it was.
Every control works with Tab, Enter, and Space.
When an agent or another tab changed the setting after the page showed it, the page refuses your change, shows the current value, and says `Someone changed this since you opened it; it now shows the current value.`
The card checks for changes every few seconds and at once when any tab applies an action, so it shows a value an agent set without a reload.
In a tab that can only read, the card shows the read-only notice and its controls are disabled.
A question's answer shows the situation the agent described, what each option does, and the option the agent recommends with its reason, when the agent gave them.

Each component that `## Components` declares has its own index target, named `<repository>/<component>`, after the root component of the checkout.
Rebuilding a component's index prepares only that component, also one that has no index yet, retries it when its last build failed, and reuses its index without a build while it is up to date.
A rebuild is refused while that component's index is already being built, and a rebuild of another component waits for the running build without stopping it.
In a repository without components, the root component's rebuild prepares the checkout's one index.

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
Under its title a tag names the slice's phase with its gate or status, such as `Design · design gate open`, beside its requirements, and below the lifecycle a strip shows who holds the slice, since when, when the holder last renewed the claim, and the time left, with the exact times on hover or focus.
The Review ledger tab counts the open findings and the Files tab the slice folder's files.
**Details and settings** at the end of the page bar shows the slice's outcome, slug, parent, children, dependencies, and active work, and the initiative's settings.

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
An evidence link, such as a receipt or a baseline snapshot, opens the evidence drawer at the right of the page, which leaves the page usable and stays open while you open records from it; Esc or **Close** closes it.
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
Open as tab opens the file in a tab that stays open, Esc or the close button closes the panel, and dragging its left edge sets its width.
Graph, diagram, and document cards can be maximized, and Esc restores them.

## Find artifacts

Press Ctrl K or Cmd K, or `/`, to open the Jump palette.
It finds places, initiatives, slices, requirements, decisions, glossary terms, and Prism's records by title, and repository files by path, grouped by kind.
A slice's result shows who holds a claim on it, and beside the results a preview shows the active result.
A query of three or more characters also searches the text of Prism artifacts, never source files, and every word must occur in a matching file.
Opening a text match scrolls to and highlights the first occurrence.
When the match is not visible in the rendered view, try the Raw view.
On an initiative or slice page, the palette also lists the page's settings as entries such as `Push: Off`, and choosing one moves the focus to that setting's control.
In the palette, the arrow keys move through the results, Enter opens one, and Esc closes the palette.

## Index status

The index item at the right of the status bar shows the open project's native index, and its panel lists every build step.
Its panel lists each index target of the checkout, the root component first and then each declared component, with its indexing state and a **Rebuild** button that rebuilds only that component's index.
While a component's index is being built, its row says `An index build is already running.` in place of the button.
In a repository with components, the item combines every component's index and names the component being built.
A long component identity ends in an ellipsis, and its tooltip names it whole.
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
When an agent presents a review for another project while a tab that can make changes is open, that tab shows a notice with a link instead of a second tab opening.

The app starts with the MCP server of the first Prism session, outlives that session, and exits after 30 minutes with no session and no open viewer.
A session of a newer Prism release replaces an app of an older release on the same port, and open review pages reload into the new version.
A session never replaces a newer app.

A new session opens the review browser on its project when no review tab of any project that can make changes is open.
Starting several sessions at once opens at most one window.
Cloud, CI, print-mode, and display-less sessions open nothing.
Add `- Review browser on start: off` under `## Interaction` in `.prism/workflow.md` to turn this off for a project, or set `PRISM_REVIEW_BROWSER_ON_START=off` to turn it off for every project you work on.
`Review browser: internal` also turns it off, because only the agent can open the internal browser, and a tab there can only read.
It keeps its state in `~/Library/Application Support/Prism` on macOS, `%LOCALAPPDATA%\Prism` on Windows, and `$XDG_STATE_HOME/prism` or `~/.local/state/prism` elsewhere.
A session serves its project from its own review server when the shared app cannot start, and `PRISM_REVIEW_APP=off` makes every session do so.
When a session falls back on its own, its page shows a banner with the reason, and the agent's review links say that the link belongs to that session, because another session may show the same project at a different link.
Each fallback also adds a line with the time, project, and reason to `fallbacks.log` in that state directory and to the session's error output.

`prism review` opens the project in the shared review app and returns.
It opens the system browser only when no review tab that can make changes is open, and such a tab shows the project or a notice with a link to it instead.
When the shared app cannot start or `PRISM_REVIEW_APP=off` is set, `prism review` serves the review itself until you stop it with `Ctrl-C`.

## Security

The server binds to `127.0.0.1`, selects an available port, and uses an unguessable session URL.
The shared app reuses the port it last bound when that port is free, so the browser keeps the site's notification permission and stored settings after a restart, while the session URL of every cold restart is new.
It serves plain HTTP, which browsers treat as a secure context on `127.0.0.1`, so no certificate trust step is needed.
It refuses requests whose host is not `127.0.0.1` or `localhost`.
It renders entirely in the browser and does not send project sources to a remote renderer.
