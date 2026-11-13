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
The small **About Prism** button just before **Appearance** names the version of Prism that runs the review app and also opens the component catalog.

The top bar holds the Prism mark, the workspace switcher, the search button that opens the Jump palette, and **Who's working**.
The status bar at the bottom shows where the project's records live, naming a shared store, their sync state, and the repository index.
Times in words, such as when a question was asked, how long ago the records synced, or how long a claim has left, count on while the page is open, and hovering one shows the exact date and time.
The rail at the left edge switches between five places, and the sidebar beside it shows only the current place, under its title and a line that says what it holds.
**Attention** shows what waits on you, and the rail's Attention button carries the number of recorded questions that wait for an answer.
Its sidebar lists **Everything**, then under **By kind** **Questions**, **Review findings**, **Failed verifications**, **Blocked work**, **Ready to ship**, and **Problems**, each with its count, also at 0, then under **By work** the three initiatives with the most items and a row such as `2 more` that shows the rest below it, and under **Answered** **Answered in the last 7 days**.
**Work** lists each initiative that has an initiative record and is neither shipped nor superseded, with its slices, under the groups **In progress**, **Blocked**, **Designed, not started**, and **Not on the roadmap**, each with its count, and leaves out an empty group.
An initiative is **Blocked** when one of its slices is blocked and none is in progress or claimed, and it keeps the roadmap's order inside its group; initiatives that are not on the roadmap go by title.
**Roadmap** switches the Roadmap page between **Board**, **List**, and **Graph** under **View**, marking the view the page shows, and lists **Now**, **Next**, **Later**, and **Parked** under **Lanes**, each with its count of open initiatives; choosing it on the rail also opens the Roadmap page.
A lane opens the board with that lane's heading scrolled into view, also again while the board is open, and its address, such as `review?artifact=roadmap&lane=parked`, does the same in a new window.
**Knowledge** starts with a search field, such as `Search 11 records`, that counts the requirements files, decisions, glossary terms, and diagrams.
Below it, **Start from** holds **Touched by my work** and **Changed this week**, and **Browse by kind** holds **Requirements**, **Decisions**, **Glossary**, and **Diagrams**, each with its count.
**Touched by my work** lists the records behind the slice in the selected tab, or else the slice you selected last since the page loaded, and its count is the number of those records.
Its page groups them under **The contract cites**, read from the slice's design: the requirements sections the slice is assigned, the decisions, requirements files, and diagrams its `slice.md` links to, and the glossary terms its contract clauses name as whole words.
**This work changes** lists the requirements files, decisions, glossary, and diagrams that a line of the slice's `Changes` names, and those that differ between the content the slice started from and the content its latest passing verification tested.
Each record shows its kind, its status from its `Status:` line, and why it is listed, such as `Section 1`, `Clauses 1, 2`, `Linked from the design`, `Planned by the design`, or `Changed by the verified result`.
Without a slice the page says so and lists every slice in progress, so you can open one.
The page and its count follow edits to the slice's design and new passing verifications while they are shown, without a reload.
**Changed this week** lists the requirements files, decisions, glossary, and diagrams changed in the last 7 days, read from the repository's Git history: files Git reports modified, added, or untracked come first as `Not committed`, then those a commit changed, newest first, with the commit's time and author, a renamed file counting as changed.
A merge commit counts the files it changed against its first parent, so a branch merged this week counts at the merge's time and author even when its own commits are older.
When the project is not a Git repository, has no commit yet, or Git cannot be run, the page says `Change history is unavailable:` with the reason, lists the records it could not date, and the sidebar shows no count for **Changed this week**.
**Diagrams** lists every PlantUML file of the plans and decisions folders by the name after `@startuml`, or by its file name, with what it belongs to: the initiative and slice whose folder holds it, the initiative, or the decision beside it.
Typing two or more characters in the search replaces the groups with the matching requirements, decisions, glossary terms, and diagrams, grouped by kind and at most 20 of each, titles that hold the text first.
A record matches when every word you type occurs in its title or its text, ignoring case, and a glossary term opens the Glossary.
Clearing the field or pressing Esc in it brings the groups back.
**History** lists the shipped and superseded initiatives, newest decision first, each with the decision's date, such as `9 Nov`, or `14 Jun 2025` in another year, and a muted `Superseded` mark on superseded ones; hover or focus a row to see when it shipped, or when it was superseded and by which initiative.
It says `Nothing has shipped yet.` while there is none.
Choosing any other place leaves the open page as it is, and the place stays while you change tabs, follow links, use the palette, or go back.
The browser remembers the current place, so a reload or a new window shows it again, and an address with `place=work`, or another place's name, chooses that place.
An address that opens a store artifact or a code file and names no place opens Knowledge, whose sidebar holds the store's scopes and the scope filter.
The page bar's trail starts with the place of the open page, and choosing that crumb makes the place current without leaving the page.
An initiative's row shows its state as a round glyph and its shipped leaf slices out of all, such as `0/4`.
Expanded, it lists at most five of its unfinished slices, each with a triangle in the color of its phase, its holder, and `Blocked` when it is blocked: the slice you have open first, then those in progress or claimed, then blocked ones, then the rest.
A last row, such as `3 more unfinished` with `2 done`, or `All slices` when every unfinished slice is listed, opens the initiative's page with all its slices.
Hover or focus a row to see its full title with its status, its phase, and its claim; the Roadmap lists every initiative, including shipped and envisioned ones.
An initiative expands when you expand it, when its page or one of its slices' pages is open, or when one of its slices is in progress or claimed, and you can collapse it.
Type in **Filter work** to keep only the initiatives and slices whose titles hold the text, ignoring case, each matching slice under its initiative; clear the field, or press Escape in it, to see every group again.
Below the groups, a note says that shipped work moves to History and that emerging and unplanned items stay on the Roadmap.
Every row is a link, so a middle-click or a Shift click opens the page in a new browser tab or window, and the browser's context menu can copy its address; a crumb of the page bar works the same way.
Above 1100 pixels, press `[` or use the sidebar button at the top of the rail to hide the sidebar and keep the rail, and again to show it; the review app keeps the choice for every project and later session, and choosing a place shows the sidebar again.
At a window width of 1100 pixels or less the rail and the sidebar are hidden, and the Navigation button at the left of the top bar opens a drawer that holds the rail and the current place's sidebar; choosing a place in it switches the sidebar, and choosing a page opens it and closes the drawer.
The bell at the right of the top bar then keeps the Attention count and opens the Attention page.
If you widen the window past that width while the drawer is open, the drawer closes and the rail and the sidebar return; if you narrow it while the sidebar has the focus, the focus moves to the Navigation button.

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
Its popover lists every live claim and then every claim that expired, with the holder, the harness the agent runs in when its claim records one (otherwise Agent), the activity, the slice, and the time left.
The sidebar shows a claimed slice's holder at the end of its row.
Claims are read-only in the browser.

A banner appears when the review server stops responding, and it clears when the connection returns.
When the server stays silent for about 15 seconds, the banner says that the review app stopped and the page is no longer live, and actions that need the server say so instead of failing silently.
A restarted app uses a new link, so ask the agent to open the review browser to get one, or run `./bin/prism review` from a Prism checkout.
Opening an old link after a restart, or the app's port without a link, shows a page that says the link no longer works; it cannot list your projects, because the link is what keeps other users of the computer from reading them.
The app's own address opens the workspace an agent session used most recently, and a link to a workspace or checkout the app no longer lists opens that workspace too, with a notice to choose another from the workspace switcher; with no workspace yet, it opens the page that offers to add one.
The page keeps checking and recovers on its own when the same app or its upgraded successor answers.
A check that gets no answer within 8 seconds counts as no answer, so a server that is too busy to answer shows the banner instead of a page that silently stops changing.

You can keep as many review tabs open as you like, of one project or of several, in one browser.
A browser opens at most six connections to the review app for all its tabs together, so the tabs share one live connection: one tab holds it, passes what it hears to the others, and hands it to another tab when you close it.
A tab in the background checks nothing until you show it again, and then it catches up at once.

## Attention

Attention lists the questions that an agent recorded for you, with the artifacts to inspect, including read-only source files.
The newest question comes first, and so does the newest answer that still waits for the agent.
Answer a question on Attention or in the conversation, except the approval of a requirement or ADR and the correctness review that confirms a ship, which count only when you answer them on Attention.
Each decision and action request explains itself so you can answer without having followed the run: below the question it shows what happened, what was tried, and an example, and a decision lists what each option leads to and which option the agent recommends and why.
Prism refuses to record a decision or action request without that explanation, or a decision without a consequence for each option and a recommendation, so a question always reaches you with them.
Questions recorded by an earlier Prism version show only their question.
A design or correctness review needs Approve or Request changes, and Request changes also needs a note that says what should change.
Approving the correctness review of a finished initiative lets the agent ship it, which in a project with a record store also accepts the Proposed ADRs that its slice designs link, as [Ship an initiative](workflow.md#ship-an-initiative) describes.
The approval of a requirement or ADR takes the same answers, and its card names the file, its scope, its recorded status, and the whole status that approving records, wrapped onto further lines when it is long.
Approving writes that status into the file's `Status:` line, and for `Approved` the day you answer into its `Approved:` line, as [Statuses change only at gates](shared-records.md#statuses-change-only-at-gates) describes.
A decision takes one of its options, a note in your own words, or both.
To answer in your own words after choosing an option, choose that option again, or press **Clear choice** beside **Your answer**.
An action request needs only Mark as done, with an optional note.
The button that sends your answer stays disabled until the answer is complete, and the text beside it says what is missing.
While a question waits, the tab title starts with the number of waiting questions and the tab icon shows a dot, so a background tab shows it too.
Choose "Notify me about new questions" on Attention to also get a desktop notification when a question arrives while the page is in the background.
The browser keeps that permission per review app address, and a restarted review app uses a new address, so it can ask again.
In Claude Code a waiting agent resumes on its own shortly after your answer.
When you resume a session with open questions, Prism lists the ones that session asked for the agent with your first message, and the agent waits on them again, so later browser answers still resume it on its own.
In Codex the agent ends its turn, and Prism's Stop hook keeps the turn open for up to 55 minutes and continues it with your answer.
Codex runs that hook only after you trust Prism's current hook definition through `/hooks`.
Elsewhere, or after the 55 minutes, the agent receives the answer with your next message, even a short one such as "go".
An answer to a question that an agent asked reaches only the session whose agent or sub-agents asked it, so another session working in the same project, on the same initiative or another, never receives it.
An answer to the approval of a requirement or ADR reaches, once and in the same ways, only an agent working in the checkout that asked for the approval, however long you take to answer.
Agents in other checkouts or on other machines are not told, but any agent that reads that file also reads your latest answer and its note, so requested changes are not lost when nothing waits.
Attention also lists blocked slices, open findings, failed verifications, and active work.
A slice that is not done is a failed verification while its latest verification run failed, with the reason in words, such as `The tests failed, 2 tests failed`, until a later run passes or the slice is done.
Choosing a kind or an initiative in the sidebar opens Attention filtered to it, at an address such as `attention:failed` or `attention:work/<initiative>`, which shows only those items, says above them the filter and its count, such as `Failed verifications · 1 of 13 items`, and offers **Show everything**.
Each filtered item opens where it is handled: a question opens Attention with that question picked so you can answer it, and a failed verification opens its slice.
Questions are the recorded questions that wait for an answer and the notes left for you; problems are unreadable or invalid records, a missing or invalid roadmap, initiatives with a record that the roadmap does not list, the roadmap's open questions, and workflow settings warnings.
**Answered in the last 7 days** lists the questions answered or closed in the last 7 days, newest first, each with its initiative and slice and your answer or the reason the agent closed it.
Under Earlier questions it shows the 20 most recently closed questions with your answer, or with the reason the agent gave when it closed a question you had not answered in the browser.
Under Recent changes it shows the 20 newest actions applied from the review app, newest first: setting changes and answers of every initiative in the project's records, answers to the approvals of the requirements and ADRs this checkout sees, each with the file and its scope, comments on the files this checkout sees, each with the file, its scope, the line, and the start of the comment, and index rebuilds of this checkout.
Each change shows the value before and after it, the author's Git name, or email when no name is set, and the checkout label and host the change came from.
A change applied in any tab joins the top of the list at once, also a setting change or answer from another checkout whose records live in the same record store, and an approval answered or a comment made in another checkout of that store when this checkout sees the file, while another checkout's index rebuild never appears.
An answered approval stays under Recent changes after it leaves Needs you.
A change that a record store sync brings from another machine appears the next time Attention loads.

Only a tab that Prism opened can answer; see [Which tabs can make changes](#which-tabs-can-make-changes).
See [Upgrading to managed records](upgrading-to-managed-records.md#answering-in-the-browser) for the tool timeout that the Claude Code wait needs.

## Changes you make in the page

Every change that the review page makes is an action: answering a question, changing an initiative setting, commenting on a file in the record store, rebuilding an index, or launching, stopping, or resuming a launched session.
The page sends each action with the version of the record it showed you, so when an agent or another tab changed that record in the meantime, Prism refuses your action and changes nothing.
Apart from a rebuild, which starts Prism's own indexer, and the launched-session actions of [Launched sessions](#launched-sessions), an action changes only Prism's records, and it never runs a command, changes a project file, or writes to Git.
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
Once an initiative ships, its state is history, so every action on the initiative, its slices, and its questions shows as unavailable with the reason `The initiative shipped on <date>, so its state is history.`, and Prism refuses one sent anyway and changes nothing.
Index actions are not part of an initiative, so shipping one leaves them available.

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

## Launched sessions

A launched session is a headless Claude Code or Codex session that runs Prism's orchestrate skill for one initiative on this computer, started from the review page.
It works on the initiative as an agent you started in a terminal would, and you watch, stop, and resume it from the page.

### Launch an initiative

The initiative page's **Initiative settings** card ends with **Launch with Claude Code** and **Launch with Codex** under **Launched session**; a slice page offers no launch.
A launch action is unavailable with a reason such as `Claude Code was not found: no claude executable on PATH.` while its host's executable, `claude` or `codex`, is not on the review app's `PATH`, and with `A launched session of <initiative> is running on this machine.` while a launched session of the initiative runs on this computer.
Checkouts whose records live in the same place, such as two checkouts of one shared store, count as one initiative here, so only one launched session of an initiative runs on this computer at a time.
Like every action, a launch needs a tab that can make changes.

Before anything starts, Prism asks you in a dialog of the operating system, outside the browser, so a script that drives the page cannot launch on its own.
The dialog says `Start a <host> session on this computer that runs Prism's orchestrate skill for the initiative <initiative> in <checkout>? Further launches in the next 30 minutes will start without asking.`, offers **Launch** and **Cancel**, and Cancel is its default answer.
When you choose **Launch**, the session starts and the launch window opens: for the next 30 minutes, further launches and resumes on this computer start without asking, and the window's end stops no running session.
When you choose **Cancel**, or nobody answers within 2 minutes, nothing starts and nothing is recorded, and for 30 seconds after that a new launch is refused with `You declined a launch moments ago; wait a little before launching again.`.
While one dialog is open, another launch is refused with `Another launch is waiting for your confirmation.`.

| System | The dialog |
| --- | --- |
| Linux, FreeBSD, OpenBSD | `zenity`, or `kdialog` without it, on the display that `DISPLAY` or `WAYLAND_DISPLAY` names for the review app |
| macOS | `osascript` |
| Windows | `powershell.exe` |

A computer that cannot show the dialog refuses every launch with `This computer cannot show a confirmation outside the browser:` and what is missing, such as `no graphical display (DISPLAY or WAYLAND_DISPLAY) is set for the review app` or `neither zenity nor kdialog is installed`.

### What runs

Claude Code runs as `claude -p --verbose --session-id <session id> --input-format stream-json --output-format stream-json --permission-mode auto --permission-prompts none` with the prompt `/prism:orchestrate <initiative>`.
Codex runs as `codex app-server` with the approval policy `on-request`, the automatic approval reviewer, and the `workspace-write` sandbox, and the prompt `$prism:orchestrate <initiative>`.
Each runs in the checkout's folder with the review app's environment, without the variables of an agent session that the review app may have inherited, and with `PRISM_LAUNCH` set to the launch's id.
The host's own permission handling and the project's own host settings apply: Prism grants no permission and answers no question of the host itself, so an action the host's automatic handling refuses ends as a refusal that the session shows.
A session keeps running when the review app exits, idles out, restarts, or is replaced by a newer release, because a supervisor process of its own starts and watches the host.
Each launched session keeps its record in `launches/<launch id>/` in the review app folder, readable only by you, and Prism removes it 14 days after the session's last run ended.
The host's session id stays in that record on this computer: no shared record, history entry, or log holds it, and only this computer's page shows it, in the command that continues the session in a terminal.

### The Launched sessions place

Open **Launched sessions** from the Jump palette, where its detail reads `Headless sessions on this computer`, or at the address `review?artifact=launches`.
It lists every launched session on this computer whose checkout shares this checkout's records, the most recently launched first.
Each session shows its initiative's title, which opens the initiative page, the host, when it was launched, its running time, which counts every second while a run runs, its state, the reason for the state, how its last run ended, and its **Stop** and **Resume** actions.
**Runs** shows how many times the session ran when it ran more than once.
While no run runs and the host reported its session id, the session also shows the command that continues it in a terminal, `claude --resume <session id>` or `codex resume <thread id>`, with the folder to run it in, and **Copy** copies the command.
The place reads the list again every 5 seconds and after each action you apply there.
Without a launched session it says `Nothing launched on this computer yet. Launch an initiative from its page.`.

| State | Meaning |
| --- | --- |
| Running | The host is working. |
| Waiting for you | A question that the session asked waits for your answer. |
| Blocked | The host refused an action that the session needed, with a reason such as `Claude Code refused Bash: <the host's reason>`. |
| Finished | The last run ended by itself. |
| Failed | The host reported an error, its process ended with an exit code other than 0 or by a signal, or Prism stopped supervising it, each with its reason. |
| Stopped | You stopped the last run. |

A session whose supervisor ended without recording the run's end shows `Prism stopped supervising this session; its host process may still run.`.

### Stop, resume, or continue a session

**Stop** interrupts the host's turn as the host's own Stop button does, after which the host ends its turn and exits by itself.
When the host still runs 10 seconds after you stopped it, Prism ends the host process; `PRISM_LAUNCH_STOP_GRACE_MS` sets another wait in milliseconds.
A stop ends only the host process, so a process that the host or its agent started and detached may keep running, as after the host's own Stop button.
**Stop** stays available while a run runs, also after the initiative shipped.

**Resume** starts the same host session again headless, with the dialog unless the launch window is open.
It is unavailable while the session runs, after the initiative shipped, while another launched session of the initiative runs, while the host's executable is not on `PATH`, and when the host never reported its session id.
To continue a session in a terminal instead, run its command in its folder once no run runs.

When you answer, on this computer, a question that a launched session asked, Prism resumes that session without asking, unless it still runs.
A session that still runs receives the answer itself, and when that run then ends by itself with the question still open, Prism resumes it once; a run you stopped is never resumed for an answer.
An answer that a teammate gives on another computer reaches the records but starts nothing here: the session then says `An answer given on another machine waits; resume this session here to continue.`, and **Resume** continues it.

Each launch, resume, and stop goes into the initiative's history, except a stop after the initiative shipped, which only the session's own record keeps.
Only the review page launches, stops, or resumes a session: no agent tool and no Prism command does.

## Roadmap, initiatives, and slices

The roadmap shows initiatives as a board, a list, or a dependency graph, chosen under **View** in the Roadmap place's sidebar, which is the only place to switch them.
The review app keeps the chosen view, the archive toggle, and the collapsed lanes, so every later roadmap opens the way you left it.
The board stacks one full-width lane per band in priority order, an empty band on one line, and each card shows its priority rank within its band and its state.
Click a lane's arrow to collapse it.
Shipped and superseded initiatives appear only with "Show shipped and superseded".
A superseded initiative's page says below its title when it was superseded and by which initiative, linked, and the decision's reason.

An initiative page shows its slices as a board, a list, or a graph.
The board has one column per slice status, and the card of an active slice also shows its activity, workers, and review lanes.
A slice whose design waits for your answer at its design gate shows as in design review until the agent accepts the design, even though its record still says not started.
The list shows the slice tree, and the graph orders leaf slices by execution order.
A slice that records a [component](workflow.md#components) carries a small label with its `<repository>/<component>` identity in the slice tree, on its board card, and on its slice page, and a slice without one, such as a split scope or a slice accepted before components existed, has no label.
Below them, the page lists the unstarted leaves that can be designed next, leaving out those in design review.
A slice page shows the slice's diagrams, its design from `slice.md`, the verification run, the review ledger, its [verified files](#a-slices-files-after-verification), and every file in the slice folder.
It is the page to read at a design gate.
Under its title a tag names the slice's phase with its gate or status, such as `Design · design gate open`, beside its requirements, and below the lifecycle a strip shows who holds the slice, since when, when the holder last renewed the claim, and the time left, with the exact times on hover or focus.
The Review ledger tab counts the open findings and the Files tab the slice folder's files.
The review ledger's findings board has a `DEFERRED` column after `VERIFIED` for findings that you accepted with a follow-up at the review loop decision, and a deferred finding's details name its decision gate, its follow-up, and the wave that deferred it.
The review summary counts deferred findings apart from unresolved ones, and the slice's review card lists each deferred finding with its severity, title, decision gate, and follow-up.
On Attention, the review loop decision shows its summary with the findings of each wave as a table.
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

### Shipped history

A shipped initiative records finished work, so its page and each of its slice pages show the label `Shipped history: <initiative> shipped on <date>; this page records finished work.` above their content.
Each slice document of a shipped initiative, its `slice.md`, shows the same label above the document.
When that document changed after the initiative shipped, ignoring the history mark that Prism writes into it, the label adds `This document changed after the initiative shipped.`
A link preview of such a document carries the same label.
An open question of a shipped initiative moves out of Needs you on Attention into a Shipped history group, marked `Cannot be answered` with the reason `The initiative shipped on <date>, so its state is history.`, and it does not count among the questions that wait on you or in the Attention badge.
For an initiative that shipped before Prism recorded its slice documents, the first page that reaches it records their content then and marks each one as history, so commit those marked files apart from other changes.
Take current intent from Approved requirements, Accepted ADRs, the glossary, and feature files, and treat a shipped initiative's pages only as a record of what was built.

## Documents and diagrams

Prism stores diagrams as PlantUML `.puml` source files, and the browser renders them without creating image files.
Markdown links open the linked file or heading in the review.
A link to a missing file or a target outside the project is marked as missing, and an external link opens in a new browser tab.
A store artifact's links resolve by its place in the store; see [Every scope in one view](#every-scope-in-one-view).
A document with three or more headings gets a contents list that marks the current section.
In a wide window the contents stay beside the text while it scrolls, and a list longer than the window scrolls on its own and keeps the current section in view.
In a window 1100 pixels wide or narrower the contents sit above the text and fold open from their header.
Consecutive lines of text render as one paragraph, as in CommonMark, so a document written one sentence per line reads as ordinary paragraphs.
Each heading with text under it has a fold toggle beside it, and a link or contents entry that leads into a folded section opens it.
Code in source files, Markdown code blocks, previews, and diagram source is highlighted by language.

Hover over or focus any internal link to preview its target.
An open preview stays while the pointer crosses other links on its way to the preview, and switches to another link only when the pointer rests on it.
An initiative preview shows its state, band, intent, and progress, and a slice preview shows its status and outcome.
A link to a document section previews that section.
A link to a PlantUML file previews the diagram drawn small enough to fit.
A file's preview has a Show in side panel button, and Alt+click on a link does the same: the whole file opens in a panel beside the current page, at the linked heading or lines.
The panel draws a PlantUML file, and the diagrams a document links, as its page does, fitted to the panel's width, with the same zoom and source controls.
The side panel holds one file at a time, so opening another replaces it, and a link inside the panel opens its target in the panel.
Open as tab opens the file in a tab that stays open, Esc or the close button closes the panel, and dragging its left edge sets its width.
Graph, diagram, and document cards can be maximized with their Maximize button, and Esc restores them.
A maximized document keeps its Restore button in view while it scrolls, in its contents header when it has contents.

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
On a workspace's page the text search covers the store artifacts of every scope, each match with its scope label, whichever checkout the page reads through.
It also searches the code of each component whose index is ready in a checkout on this machine, and lists those matches as **Code in indexed components**, each with its component.
Under **Left out of this search** it names every other component the workspace knows, with why: `no checkout here` for a repository without a checkout on this machine, `no ready index` for a component whose index is not built, and `search failed` for one whose search failed.
The components a workspace knows are those of each checkout on this machine, those that each code clone's branches declare, and those that hold a component scope folder in the store, plus each repository's root component.
When the match is not visible in the rendered view, try the Raw view.
On an initiative or slice page, the palette also lists the page's settings as entries such as `Push: Off`, and choosing one moves the focus to that setting's control.
In the palette, the arrow keys move through the results, Enter opens one, and Esc closes the palette.

## Index status

The index item at the right of the status bar shows the open project's native index, and its panel lists every build step.
Its panel lists each index target of the checkout, the root component first and then each declared component, with its indexing state and a **Rebuild** button that rebuilds only that component's index.
While a component's index is being built, its row says `An index build is already running.` in place of the button.
In a repository with components, the item combines every component's index and names the component being built.
On a workspace's page the panel lists the components of every repository with a checkout on this machine, by repository name, and offers no rebuild for a repository without one, because a rebuild runs in a checkout.
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
The switcher's counts of open questions follow a question that an agent recorded or answered within about 15 seconds, and one answered in the browser within about 5 seconds.
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
A link whose path falls outside every artifact folder names a code file of the artifact's repository, or, for a workspace artifact, of the checkout the page reads through.
It opens that file from a checkout of the repository on this machine that offers it for review, in a tab named `code:<repository>:<path>`.
A file that no registered checkout offers opens from the repository's code clone, while its code content is on, at the remote's default branch, the branch that the remote's `HEAD` named at the clone's last fetch; the tab shows that branch's label, and a checkout that offers the file always wins over the clone.
A link to a secret by its file name, such as `.env` or a private key, never opens from the clone.
A binary file or a file over 512 KiB still shows as a link, and opening it says that the file is not shown because it is binary or over 512 KiB, rather than that it was moved or deleted.
When no checkout of that repository is registered on this machine and its code clone does not hold the file, the link keeps its text and shows **not available on this machine** beside it, and the page's heading counts such links apart.
A link that names no artifact and no file keeps its text and shows **link not found** beside it, and the page's heading counts such links.
An image, a link inside a fenced code block of backticks or tildes, and a link inside inline code are not links.
The Jump palette lists each store artifact once, names its scope in its row, and finds only the artifacts of the scopes the filter shows.

A store that holds no artifacts yet, because no Prism session moved a checkout's files into it, shows a note in the **Store** section that names its repositories and says that each keeps its artifacts in its checkouts until a Prism session there moves them into the store.

### Code content

The **Code** page in the sidebar's **Library** lists each repository of the workspace with its code content state: **Off**, **On**, or **Unreachable**.
Choose **Turn code content on** for a repository to have Prism keep a clone of its code on this machine, also when this machine has no checkout of it.
Prism clones the first remote that the store's registration of the repository lists, with the machine's Git configuration and credential helpers and without asking for a password on a terminal, into `code/` of its state directory, one clone per remote.
The clone is bare and blobless: it holds every branch of the remote with its commits and folders, and it fetches a file's contents only when someone opens the file, so it uses little disk.
A repository whose registration lists no remote cannot take code content.
Only a tab that can make changes turns code content on or off; see [Which tabs can make changes](#which-tabs-can-make-changes).
Which repositories have code content on survives a restart of the app.

While a page of the workspace is open, each fetch of the workspace also fetches every repository with code content on, bringing new branches and dropping branches that left the remote.
When a repository's remote cannot be reached, the Code page shows it as **Unreachable** with Git's reason, and the clone keeps what it fetched last; when the first clone fails, Prism keeps no folder and tries the clone again at the next fetch.
For a repository with code content on, the Code page lists the files and folders of every branch, each with the labels of the branches that hold it, and opens a file to show each version of it with the labels of the branches that hold that version, so it never asks you to choose a branch.
It shows no secret, binary file, or file over 512 KiB, and it never names the Git host's address.
Choose **Turn code content off** to delete the repository's clone from this machine.
Removing an added workspace that leaves the switcher also turns code content off for each of its repositories and deletes each clone that no other workspace on this machine still uses.
Code clones never show a password prompt or a credential dialog, because a teammate can change the remote they fetch from; they sign in only through a credential helper or SSH key that answers without asking.

### A slice's files after verification

The **Files** tab of a slice page lists, under **Verified files**, every file that the slice's latest passing verification run recorded: each file whose content differs from the slice's start content, and its frozen tests.
Each run records only a fingerprint of each file, its Git blob hash, and never its content.
While the repository's code content is on, the page reads each file at the verified commit when a branch of the repository holds that commit.
After a squash merge or force push removes the verified commit, the page reads the files at the commit of the default branch that Prism recorded when the initiative shipped.
Each file is marked **same as verified** when its content at that commit is the content the run tested, and **changed after verification** when it differs, as for a file the run tested with an uncommitted change.
When neither commit is in the repository's code clone, or the repository's code content is off or unreachable, each file is **not available** and the card says why; a slice without a passing run has no verified files yet.

Work on a slice that exists only on the machine that holds it, unpushed or uncommitted, shows only as its presence under **Work in progress**, such as `in progress in feature-x on vm, not pushed`, named from the slice's latest verification run and its live claim, and never as its content.
The review app shows no content of a commit that no branch of a code clone holds.

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
A shared app that is still running but slow to answer, for example on a busy machine, counts as busy rather than gone: a session waits up to 30 seconds more for it and never starts a second app beside it.
A session that fell back tries the shared app again at most once a minute while the review is in use, and its new review links lead to the shared app once it answers, while tabs already open on the session's own server keep working.

`prism review` opens the project's workspace in the shared review app and returns.
`prism review --workspaces` opens the app's own address, from any folder, with a tab that can make changes when no such tab is open.
It opens the system browser only when no review tab that can make changes is open, and such a tab shows the project or a notice with a link to it instead.
When the shared app cannot start or `PRISM_REVIEW_APP=off` is set, `prism review` serves the review itself until you stop it with `Ctrl-C`.

## Logs

Every Prism process writes to one log file, `logs/prism.log` in the state directory above, so the review app, each session's MCP server, and their index builds leave one record.
Each line is a JSON object with the time, level, event, process name and id, and the event's own fields.
The log records each process start and stop, index builds with their phases, durations, and failures, review app requests that fail or take more than two seconds, MCP tool calls that fail, and uncaught errors.
It also records each time a process stops answering for more than a second, with what it was doing at the time, such as the index phase of the component being built.
Past 5 MiB the file moves to `prism.log.1`, replacing the older one.
Set `PRISM_LOG_LEVEL` to `debug`, `info` (the default), `warn`, `error`, or `off`, and set `PRISM_LOG_DIR` to write the log to another folder.
An MCP server also writes its warnings and errors to its error output, which the agent host keeps with its own logs.
The log holds project paths, component names, and tool names, but no file contents, search queries, or tool arguments.

## Security

The server binds to `127.0.0.1`, selects an available port, and uses an unguessable session URL.
The shared app reuses the port it last bound when that port is free, so the browser keeps the site's notification permission and stored settings after a restart, while the session URL of every cold restart is new.
It serves plain HTTP, which browsers treat as a secure context on `127.0.0.1`, so no certificate trust step is needed.
It refuses requests whose host is not `127.0.0.1` or `localhost`.
It renders entirely in the browser and does not send project sources to a remote renderer.
