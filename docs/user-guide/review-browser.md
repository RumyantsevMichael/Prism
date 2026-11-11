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

The top bar holds the Prism mark, the workspace switcher, the search button that opens the Jump palette, and **Who's working**.
The status bar at the bottom shows where the project's records live, their sync state, and the repository index.
The sidebar is the only navigation.
It lists Attention and Roadmap, every initiative with its state, the open initiative's slices or the open library section's documents, and the Library, with Requirements, Decisions, and the Glossary.
A slice that has subslices expands when you expand it or when one of its subslices is open.
At a window width of 1100 pixels or less the sidebar is hidden, and the Navigation button at the left of the top bar opens it as a drawer that closes when you choose a page.
If you narrow the window past that width while the sidebar has the focus, the focus moves to the Navigation button.

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
The approval of a requirement or ADR takes the same answers, and its card names the file, its scope, its recorded status, and the whole status that approving records, wrapped onto further lines when it is long.
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
An answer to the approval of a requirement or ADR reaches, once and in the same ways, only an agent working in the checkout that asked for the approval, however long you take to answer.
Agents in other checkouts or on other machines are not told, but any agent that reads that file also reads your latest answer and its note, so requested changes are not lost when nothing waits.
Attention also lists blocked slices, open findings, and active work.
Under Earlier questions it shows the 20 most recently closed questions with your answer, or with the reason the agent gave when it closed a question you had not answered in the browser.
Under Recent changes it shows the 20 newest actions applied from the review app, newest first: setting changes and answers of every initiative in the project's records, answers to the approvals of the requirements and ADRs this checkout sees, each with the file and its scope, comments on the files this checkout sees, each with the file, its scope, the line, and the start of the comment, and index rebuilds of this checkout.
Each change shows the value before and after it, the author's Git name, or email when no name is set, and the checkout label and host the change came from.
A change applied in any tab joins the top of the list at once, also a setting change or answer from another checkout whose records live in the same record store, and an approval answered or a comment made in another checkout of that store when this checkout sees the file, while another checkout's index rebuild never appears.
An answered approval stays under Recent changes after it leaves Needs you.
A change that a record store sync brings from another machine appears the next time Attention loads.

Only a tab that Prism opened can answer; see [Which tabs can make changes](#which-tabs-can-make-changes).
See [Upgrading to managed records](upgrading-to-managed-records.md#answering-in-the-browser) for the tool timeout that the Claude Code wait needs.

## Changes you make in the page

Every change that the review page makes to Prism's records is an action: answering a question, changing an initiative setting, commenting on a file in the record store, or rebuilding an index.
The page sends each action with the version of the record it showed you, so when an agent or another tab changed that record in the meantime, Prism refuses your action and changes nothing.
An action changes only Prism's records, and apart from a rebuild starting Prism's own indexer, it never runs a command, changes a project file, or writes to Git.
Answering the approval of a requirement or ADR also needs a tab that can make changes, and Prism records nothing when the file changed since the approval was asked.
When more than one pending approval holds the same id, as a copied status record or a scope move that stopped halfway can leave, Prism lists each one, names every file and scope that holds the id, and refuses an answer to any of them, so the agent asks again for the file it means.
A comment needs a tab that can make changes and a Git `user.name` in the checkout, and Prism stores nothing when the file changed since the page showed it; the page then shows the current file and keeps your comment unsent.
While the record store cannot be used, such as when it is unavailable or the checkout's repository name is refused, Prism refuses an approval answer or a comment with the same reason that reading the file gives, and records nothing.

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

The initiative page, and every slice page of the initiative, ends with an **Initiative settings** card.
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
A store artifact's links resolve by its place in the store; see [Every scope in one view](#every-scope-in-one-view).
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

### Review a file in the record store

In a project whose `.prism/workflow.md` names a record store, a requirement, ADR, plan file, glossary, or roadmap view opens with a Review card above its content.
The card names the file's scope, `workspace`, the repository, or `<repository>/<component>`, and says whether a person accepted the file and whether it changed since.
A file is accepted when a person approves it, when the design of the slices whose folder holds it is accepted, or when its initiative ships.
Below that, the card shows the lines that changed since the accepted version, with the line numbers of both versions, or the whole file as added when no version was accepted yet.
It then lists the comments on the file, oldest first, each with its author's Git name, the host it came from, the line it names, and its time, and marks a comment made on an earlier version of the file.
Comments that a record store sync brings from other machines appear the next time the page checks the file, and comments from this machine's tabs appear at once.
The page checks again 1.5 seconds after its last check ended, never while one still runs, and the review app reads only the comment files that the page lists and those that changed since its last read, so a file with many comments keeps the page responsive.
The heading counts every comment on the file, while the list shows the first 20; while more follow, select **More comments** under the list to show the next 20, until every comment shows.
After **More comments** shows the next comments, keyboard focus moves to the **More comments** button that follows them, or to the first comment it added when none follows, also when the page redrew the list meanwhile.
Agents read the comments in the same pages of at most 20, with the total and where the next page starts.

To find a line's number, open **Lines of the current version** on the Review card, which lists every line of the file as it is now with its number, also when the file matches its accepted version and for lines that the changes leave out.
The list is closed when the page opens, and it stays open or closed as you left it while comments arrive and the file changes, with the line you scrolled to still in view.
To comment, enter that line number, with or without spaces around it, and your comment of at most 4000 characters, then select Comment.
A file takes at most 1000 comments: once it holds 1000, Prism refuses a further comment with `comment_limit` and stores nothing, and a file whose comment folder holds more than 1000 files, as a sync from elsewhere could bring, shows no comments at all.
The comment goes to the record store as a file of its own, so it reaches every checkout that sees the file and every machine that syncs the store, and the file itself does not change.
On a workspace's page you can comment on the files of every scope, also another repository's, and the comment names its author by the Git name of the store's clone on this machine.
Agents read the comments with the file through `get_artifact`.
A file's comments belong to it: when an agent moves the file to another scope its comments move with it, and when an agent removes the file its comments are removed with it, so a new file at the same path starts without them.
A comment you are still typing stays in the form when the file moves to another scope, and Comment then sends it to the file in its new scope.
A comment made on one machine while another machine moves the file follows the file once the two machines' stores have synced.
A comment made on one machine while another machine removes the file leaves the store when they sync, whichever machine synced first, also when that machine then writes or moves another file to the same path, which keeps the path.
The comment is saved in the sync folder of the machine whose sync met the two changes and is named with its line and text to the agent in that machine's next Prism result, so nothing you wrote is lost and it never shows on the later file.
The notes that name saved files hold at most 32 KiB in one result; when a sync saves more, the note counts the files it leaves out and names the store's `.prism-sync` folder, which holds every saved copy.
The card and Recent changes on Attention take only comments and approvals in the form Prism writes them, so a damaged file that a sync brings shows nowhere, and Recent changes lists an entry dated more than five minutes ahead of this machine's clock only once that time comes.

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

## Workspaces

All Prism sessions of one user share one review app on one local port, and the app shows workspaces.
A workspace is one record store with every checkout and repository on this machine that shares it, and a project that keeps its records itself is a workspace of one.
Every spelling of one store, such as its HTTPS and SSH URLs, names one workspace.
Each workspace has its own page at `w/<id>/` below the app's address, whichever checkout opened it.
The switcher in the top bar lists workspaces only, named by the workspace name kept in the store, else after the store's last path segment, or, for a project without a store, after its folder; see [Name the workspace](shared-records.md#name-the-workspace).
Under each workspace's name it lists its repositories and how many of their checkouts this machine has, and its tooltip names the store and each checkout's folder, as information rather than places to open.
Each entry marks a workspace that an agent session is using now and counts its open questions, and the switcher keeps the entries in name order, so they never move while you look.
The switcher's button shows the workspace's name first, as `workspace · repository/branch`, naming the checkout whose source files and index the page shows: the checkout that presented a review last.
An older link to a checkout's page, which has `p/<id>/` in its address, opens the same page of the checkout's workspace, and an artifact it names by the checkout's path opens by its place in the store.
Open tabs name each store artifact by its place in the store, so a tab opened from one checkout stays the same artifact from every other checkout of the workspace.
The app's own address opens the workspace an agent session used most recently, else the workspace used most recently.
With no workspace yet, it shows a page that offers to add one, and opens the first workspace as soon as you add it or a Prism session or `prism review` in a project adds it.
When an agent presents a review for another project while a tab that can make changes is open, that tab shows a notice with a link instead of a second tab opening.

### Every scope in one view

A workspace's page shows the artifacts of every scope its store holds together: the workspace, each repository, and each repository's components, also the repositories with no checkout on this machine.
The **Store** section at the foot of the sidebar lists each scope by its label, `workspace`, the repository, or `<repository>/<component>`, with its count of artifacts, and each scope opens to list its artifacts by their place in it, such as `requirements/billing.md`.
A scope lists its first 50 artifacts there, and the Jump palette finds every other one.
Each store artifact's page names its scope in a label beside its heading and in its Review card, and shows its place in the store, such as `repositories/api/requirements/billing.md`.
The page names a store artifact by that place, `store:<location>`, in its tabs, links, and address, never by a checkout's path, so one link opens the same file from every checkout and from a workspace with no checkout.
A link or tab that still names a checkout's path opens the store artifact at that path.

The scope chips above the list are the scope filter: select one or more scopes to show only their artifacts in the sidebar and the Jump palette, select a chosen chip again to drop it, and select **All scopes** to show every scope again.
The filter stays in the page's address as `scopes=<label>,<label>`, so it survives a reload and a shared link, and it never changes the workspace the page shows.

A relative Markdown link in a store artifact opens the artifact it names, looked for first beside the artifact's place in the store, and then at the path the link names from the file's checkout path, as a checkout of its repository on this machine configures its folders, or as Prism's default folders do without one, in the file's own scope or else the workspace scope.
A link that names no artifact keeps its text and shows **link not found** beside it, and the page's heading counts such links.

A store that holds no artifacts yet, because no Prism session moved a checkout's files into it, shows a note in the **Store** section that names its repositories and says that each keeps its artifacts in its checkouts until a Prism session there moves them into the store.

### Add a workspace from its store

Choose **Add workspace…** in the switcher, or **Add a workspace** on the page without one, and give the store's address: an HTTPS or SSH URL, a `host:path` address such as `git@github.com:acme/store.git`, or the absolute path of a folder.
Only a tab that can make changes adds or removes a workspace; see [Which tabs can make changes](#which-tabs-can-make-changes).
Prism clones only the store, into `stores/` of its state directory, with the machine's Git configuration and credential helpers, and never asks for a password on a terminal.
A store that this machine already keeps, because a checkout here names it, is added without cloning.
An address that carries credentials is refused before Git runs: a user name, password, or token in an HTTP or HTTPS URL, any user name in a `git://` URL, a password in SSH user information, or a query or fragment, which can carry a token.
An SSH login name such as the `git` of `git@github.com:acme/store.git` is no credential and is accepted, because SSH signs in with the machine's keys.
Credentials come from the machine's Git configuration, such as a credential helper or SSH keys.
When the clone fails, the dialog shows Git's reason without any user name, password, or token, and Prism keeps no folder and no workspace.
Prism also refuses, and leaves as it is, a folder at the clone's place in `stores/` that is no clone of that store.
A store with no commit yet is added only after you confirm it with **Add empty store**.
When the store turns out to be one this machine already keeps under another address, such as an SSH host alias, the address joins that workspace instead, which Prism tells by the store's first commit.
A plain `http://` or `git://` address always stays a workspace of its own with its own clone: it never joins the workspace of an encrypted address such as HTTPS or SSH, and an encrypted address never joins it.
An added workspace stays in the switcher across restarts of the app until you remove it.
Until a checkout of one of its repositories is registered with the app, its page reads the records from the store's clone on this machine, and the switcher's button shows the workspace's name alone.
An answer, comment, or approval that you give on that page is committed in the store's clone and pushed to the store, as an agent's record write is.
Those commits carry the clone's Git identity from the machine's Git configuration, or `Prism <prism@localhost>` when Git names none, and each change's history entry names you and this machine's review app.

### Keep a workspace in sync

While a page of a workspace whose store is a Git remote is open, the app fetches the store's upstream when the first page opens and then every 60 seconds, merges it into the store's clone on this machine, and pushes the clone's own record changes.
When no page of the workspace is open, the app fetches nothing, and reading the page starts no fetch of its own.
After a fetch fails, the next one waits twice as long as the wait before it, up to 15 minutes, until a fetch succeeds, so a store that cannot be reached costs at most one Git process every 15 minutes.
A checkout whose `.prism/workflow.md` turns Store sync off is never synced by the app.
The sync item in the status bar shows when the workspace last synced, such as **Synced 2 min ago**.
When the store cannot be reached, it shows **Store unreachable** with the time of the last fetch that succeeded, and its tooltip and details name the store and Git's reason, without any user name, password, or token.
The page keeps showing the copy it last synced meanwhile, and its details list when the next fetch is due.

### Remove a workspace

Choose **Remove** for the open workspace in the switcher.
Removing never changes the store itself.
Prism deletes the store's clone on this machine only when no checkout here names the store and the clone holds no commit, changed file, or saved conflict copy that is not pushed; otherwise it keeps the clone and says which checkout names the store or that the clone holds changes that are not pushed.
A folder store is your own folder, which Prism never deletes.
A removed workspace that still has registered checkouts stays in the switcher, no longer marked as added.

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

`prism review` opens the project's workspace in the shared review app and returns.
`prism review --workspaces` opens the app's own address, from any folder, with a tab that can make changes when no such tab is open.
It opens the system browser only when no review tab that can make changes is open, and such a tab shows the project or a notice with a link to it instead.
When the shared app cannot start or `PRISM_REVIEW_APP=off` is set, `prism review` serves the review itself until you stop it with `Ctrl-C`.

## Security

The server binds to `127.0.0.1`, selects an available port, and uses an unguessable session URL.
The shared app reuses the port it last bound when that port is free, so the browser keeps the site's notification permission and stored settings after a restart, while the session URL of every cold restart is new.
It serves plain HTTP, which browsers treat as a secure context on `127.0.0.1`, so no certificate trust step is needed.
It refuses requests whose host is not `127.0.0.1` or `localhost`.
It renders entirely in the browser and does not send project sources to a remote renderer.
