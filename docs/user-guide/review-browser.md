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

Your [personal setting](workflow.md#personal-settings) `reviewBrowser` chooses the browser, and its default `auto` uses the internal browser in desktop sessions and the system browser in CLI sessions.
Set it to `internal` or `external` to override this choice.
The agent opens the internal browser on a review URL that carries no grant, so that tab can only read, as [Which tabs can make changes](#which-tabs-can-make-changes) explains.
Answer the agent in the conversation instead, or ask it to present the review, which opens the system browser, or run `prism review` in the project.
When the selected browser is unavailable, Prism presents the URL and source artifacts.

### How the page stays current

The review app keeps each page it has built until a file that the page reads changes, so an open tab that nothing changes costs almost nothing.
It watches the record store, the checkout's `.prism` folder, and the artifact paths in `.prism/workflow.md`, and a change that an agent, a store sync, or an edit by hand makes there shows in an open tab within about a second.
On Windows, where a watched folder could not be deleted or renamed, and on a file system that reports no changes made elsewhere, such as a network drive on macOS or Linux or a Windows folder opened from WSL, the review app compares the folders' times at each read instead, so a file that is added, removed, or replaced shows at once, and an edit made in place shows within 5 seconds.
Anywhere else it also checks every 30 seconds for a change that a watcher missed.
The store's details, which the store button in the status bar opens, say under **Outside changes** whether such changes show at once, and list each folder that Prism checks instead of watching, with the reason.
A tab connected to the review app reads the checkout's other files and the store's sync status every 5 seconds, and every 1.5 seconds while its connection is down.

## Layout

The browser follows the operating system's light or dark setting and changes with it while the page is open.
It shows compact density by default.
The review app keeps the theme and density for you, so every project and every later session shows the same choice.
The **Settings** button, the gear at the start of the status bar, or Ctrl+, (Cmd+, on a Mac) opens Settings, and the same key closes it.
**Appearance** offers the themes System, Light, and Dark and the densities Compact and Comfortable.
A choice applies at once, and System follows the operating system again.
**Layout** shows or hides the sidebar on windows wider than 1100 pixels and returns the sidebar to its default width.
**Personal** shows your [personal settings](workflow.md#personal-settings), which stay on this machine and apply to every project and every host you run Prism in: **Questions** (Question tool or Numbered options), **Review browser** (Auto, Internal, or External), **Open at session start** (On or Off), and **Offer Prism** (Ask or Off).
Each row shows the value Prism uses and where it comes from: **Your choice**, **Adopted from a repository's configuration**, **From this repository's configuration**, or **Default**.
A choice saves at once on this machine, reaches no one else, and the row then says **Your choice**; agents see it the next time they read your settings.
Settings reads your settings again each time it opens, so it shows a change an agent made meanwhile.
Changing a personal setting needs a tab that [can make changes](#which-tabs-can-make-changes): a tab that can only read shows each value with its choices disabled under the read-only notice.
When Prism cannot read `personal-settings.json` in its application folder, the section warns that it uses the repository's values and its defaults, and it refuses every change until you fix or remove the file, so nothing in it is overwritten.
**Record store** says where the project's records live and opens the store's details.
**Prism's own runs** chooses, once for this computer, the host and model of the runs that Prism starts on its own, such as a run that moves records to a new format.
Its **Host** select offers **Any available host** and every host Prism supports, a host this computer lacks shown as unavailable with its reason, and its **Model** picker offers the models, efforts, and provider that the chosen host reports, as the models of an initiative's **Settings** do, or a model name typed as written.
**Any available host**, like no stored choice, starts each run with Codex and its GPT-6 Luna model where Codex lists it, and otherwise on the first host Prism finds on this computer with a small model, Claude Code's `haiku` or Codex's first listed model whose name ends in `-luna` or `-mini`, so its **Model** picker takes no choice.
**Apply** stores the choice in `prism-runs.json` in the review app folder, readable only by you, and only a tab that Prism opened can apply it; a run already started keeps its own host and model.
When the chosen host is no longer found, or the stored choice cannot be read, a run starts on the first host Prism finds with its default model and says why, and with no host found it does not start.
**Coding agents** lists the [ACP agents](#acp-agents) that Prism can launch or install, as [Coding agents in Settings](#coding-agents-in-settings) describes.
**About Prism** names the version of Prism that runs the review app, and **Open the catalog** opens the review app's component catalog in a new tab, which shows every control of the interface with its options, states, and keys.
The catalog's own toolbar changes its theme, density, and width for that tab only, and stores nothing.

The top bar holds the Prism mark, the workspace switcher, the search button that opens the Jump palette, and the **Agents** button.
The status bar at the bottom starts with **Settings**, then shows where the project's records live, naming a shared store, with their sync state, whose color the store icon takes, and ends with the repository index.
Times in words, such as when a question was asked, how long ago the records synced, or how long a claim has left, count on while the page is open, and hovering one shows the exact date and time.
The rail at the left edge switches between five places, and the sidebar beside it shows only the current place, under its title and a line that says what it holds.
**Attention** shows what waits on you, and the rail's Attention button carries the number of recorded questions that wait for an answer.
Its sidebar lists **Everything**, then under **By kind** **Questions**, **Review findings**, **Failed verifications**, **Blocked work**, **Ready to ship**, **Problems**, and **Format findings**, each with its count, also at 0, then under **By work** the three initiatives with the most items and a row such as `2 more` that shows the rest below it, and under **Answered** **Answered in the last 7 days**.
**Work** lists each initiative that has an initiative record and is neither shipped nor superseded, with its slices, under the groups **In progress**, **Blocked**, **Designed, not started**, and **Not on the roadmap**, each with its count, and leaves out an empty group.
An initiative is **Blocked** when one of its slices is blocked and none is in progress or claimed, and it keeps the roadmap's order inside its group; initiatives that are not on the roadmap go by title.
**Roadmap** starts with **Whole roadmap**, which opens the Roadmap page, and lists **Now**, **Next**, **Later**, and **Parked** under **Lanes**, each with its count of open initiatives; choosing it on the rail also opens the Roadmap page.
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
**Diagrams** lists every PlantUML file of the plans and decisions folders by the name after `@startuml`, or by its file name, with what it draws, such as `Sequence`, `Class`, or `Code view`, and what it belongs to as a link: the initiative and slice whose folder holds it, the initiative, or the decision beside it.
**Requirements**, **Decisions**, **Glossary**, and **Diagrams** each show one table with a filter and a **Group by** choice above it, and the review app keeps each page's grouping among your preferences.
In a workspace whose store holds more than one scope, each of these pages also groups by **Scope**, which it does until you choose another grouping, and a row names its scope in a chip only while the page groups some other way.
**Requirements** lists each requirements file with how many requirements it holds, its status, the date it was approved or created, and one link for each slice that builds it with the requirements that slice builds, such as `req 1, 2`, and groups by **Status**, **Area**, the subfolder that holds the file, **Initiative**, or **None**.
**Decisions** lists each decision with what it supersedes or what superseded it, read from its `Supersedes:` line, its status, its date, and what it applies to: the requirements files its `Requirements` section links and the initiatives whose slice designs link it, and groups by **Area**, **Status**, **Initiative**, or **None**.
**Diagrams** groups by **Belongs to**, **Kind**, or **None**.
**Glossary** lists each term with its meaning, one glossary per scope in a workspace, and a term that another scope's glossary also defines shows that scope in a chip with `also defines it`; it groups by **Scope** or **None**.
The filter keeps the rows whose title, status, or links hold every word you type, and Escape clears it.
On **Requirements** and **Decisions**, the line under the page's title also says how many of the listed files break their format, such as `3 of 9 break their format`.
A requirements file, ADR, or glossary that breaks its Prism format, as `check_artifacts` reports it, carries a `Breaks its format` badge on each row that names it: in the Knowledge lists and search, in **Touched by my work** and **Changed this week**, among a slice's requirements, in the Jump palette, and on the format findings page.
Hovering the badge names the rules the file breaks, such as `requirements.header, requirements.sections`.
The file's own page shows **This file breaks its format** above the document, with each broken rule, its message, and its line.
A file that keeps its format shows neither.
Typing two or more characters in the search replaces the groups with the matching requirements, decisions, glossary terms, and diagrams, grouped by kind and at most 20 of each, titles that hold the text first.
A record matches when every word you type occurs in its title or its text, ignoring case, and a glossary term opens the Glossary.
Clearing the field or pressing Esc in it brings the groups back.
**History** lists the shipped and superseded initiatives, newest decision first, each with the decision's date, such as `9 Nov`, or `14 Jun 2025` in another year, and a muted `Superseded` mark on superseded ones; hover or focus a row to see when it shipped, or when it was superseded and by which initiative.
It says `Nothing has shipped yet.` while there is none.
Choosing any other place leaves the open page as it is, and the place stays while you change tabs, follow links, use the palette, or go back.
The browser remembers the current place, so a reload or a new window shows it again, and an address with `place=work`, or another place's name, chooses that place.
An address that opens a store artifact or a code file and names no place opens Knowledge, whose sidebar holds the scope filter.
The page bar's trail starts with the place of the open page, and choosing that crumb makes the place current without leaving the page.
An initiative's row shows its state as a round glyph and its shipped leaf slices out of all, such as `0/4`.
Expanded, it lists at most five of its unfinished slices, each with a triangle in the color of its phase, its holder, and `Blocked` when it is blocked: the slice you have open first, then those in progress or claimed, then blocked ones, then the rest.
A last row, such as `3 more unfinished` with `2 done`, or `All slices` when every unfinished slice is listed, opens the initiative's page with all its slices.
Hover or focus a row to see its full title with its status, its phase, and its claim; the Roadmap lists every initiative, including shipped and envisioned ones.
An initiative expands when you expand it, when its page or one of its slices' pages is open, or when one of its slices is in progress or claimed, and you can collapse it.
Type in **Filter work** to keep only the initiatives and slices whose titles hold the text, ignoring case, each matching slice under its initiative; clear the field, or press Escape in it, to see every group again.
Below the groups, a note says that shipped work moves to History and that emerging and unplanned items stay on the Roadmap.
Every row is a link, so a middle-click or a Shift click opens the page in a new browser tab or window, and the browser's context menu can copy its address; a crumb of the page bar works the same way.
The sidebar's head names the place, and hovering its title says what the place holds.
Above 1100 pixels, press `[` or use the button at the end of the sidebar's head to hide the sidebar and keep the rail, and press `[` again to show it; the review app keeps the choice for every project and later session.
While the sidebar is hidden, choosing a place on the rail opens its sidebar over the page without moving the page, and choosing a page in it, Escape, or a click outside it hides it again; the button in its head, now **Keep the sidebar open**, shows the sidebar again for good.
Drag the sidebar's edge to make it from 200 to 480 pixels wide, or focus the edge and use the arrow keys; a double click on the edge returns it to its default width, and the review app keeps the width for you.
At a window width of 1100 pixels or less the rail and the sidebar are hidden, and the Navigation button at the left of the top bar opens a drawer that holds the rail and the current place's sidebar; choosing a place in it switches the sidebar, and choosing a page opens it and closes the drawer.
The bell at the right of the top bar then keeps the Attention count and opens the Attention page.
If you widen the window past that width while the drawer is open, the drawer closes and the rail and the sidebar return; if you narrow it while the sidebar has the focus, the focus moves to the Navigation button.

The top of the main area holds a tab for each open page.
A link opens in the preview tab, whose title is italic, and the next link replaces it.
Ctrl-click or Cmd-click a link, double-click or middle-click a link in a page, press Ctrl+Enter or Cmd+Enter in the Jump palette, or choose Open as tab in the side panel to open a tab that stays open.
Double-click the preview tab, or press Ctrl+Enter or Cmd+Enter while it has the focus, to keep it open.
A new tab opens right after the selected tab.
Close a tab with its close button or a middle click, and when you close the last tab the page says that nothing is open.
Tabs that an agent presents carry the agent mark before their title and stay open until you close them, and a presentation of several artifacts opens a tab for each of them and shows the first.
An agent can present tabs as a named group, whose head shows the agent before the group's name: the avatar of the claim that agent held when it presented the group, whose hover text names the holder, the harness and model, the activity, and the time left, or else an agent avatar named by its harness and model.
Tabs, buttons, menus, and other controls do not select their text when you click, double-click, or drag on them, while documents, code, figures, messages, and fields stay selectable, except a graph or diagram, which you drag to pan.
The open tabs belong to the session, so every browser window of the session shows the same tabs, and a reload or a later visit restores them.
When tabs do not fit, the strip scrolls sideways and keeps the selected tab in view, and a long title ends with an ellipsis whose full text shows on hover or focus.
With the focus on a tab, the arrow keys, Home, and End move between tabs, Enter opens one, and Tab reaches that tab's close button.

The page bar below the tabs holds Back and Forward and the trail of the page's place, initiative, and slice by title.
Back and Forward, Alt+Left and Alt+Right, and the browser's own buttons move through the pages you visited in that browser tab, and the address names the selected tab.
A page that an agent presents opens as the next page.
Prism's records and documents appear by title and kind, such as Design, Diagram, or Change map, and only repository files are named by their path.
A tab whose file was moved or deleted, or whose initiative or slice no longer exists, is dimmed and struck through, and its page says so and offers Close tab.
The tab and its page return to normal on their own when the target comes back, for example after a checkout.
When Prism moves a record from its legacy location into `.prism/`, a tab on that record follows it to the new path.

The **Agents** button shows up to three avatars of the agents at work and how many work, such as `4 working`, counting the launched sessions that run or wait for you and the live claims that no launched session holds.
While launched sessions failed, ended without a result, or wait for you, it adds a red badge such as `1 failed`, a blue badge such as `1 ended without a result`, and an amber badge such as `1 waits`, in that order, and a screen reader also hears how many claims expired.
In a window 1100 pixels wide or less the blue badge says `1 no result`, the button shows two avatars, and while a badge shows the count drops the word `working`, so the top bar keeps its width.
A screen reader still hears every word.
In a window 600 pixels wide or less the button shows two avatars and one small count of the launched sessions that need you on its corner, sessions that ended without a result included, red while one failed and amber otherwise, and no words.
Opening it shows the **Agents** menu.
Its **Needs you** group, left out while nothing needs you, lists each launched session that failed, ended without a result, or waits for you, in that order, with its initiative, its harness, its model, what it works on, its state, and how long it ran.
A waiting session offers **Answer**, which opens Attention with the question it waits on selected and its answer form shown, and a failed one offers **Open**, which opens [the Agents page](#the-agents-page) with its details shown.
A session that ended without a result offers **Answer**, which opens its card on Attention.
Below that, **Launched from Prism** counts the launched sessions that are not archived, **Started outside Prism** the live claims, and **Expired claims** the claims that expired less than a day ago, also at 0, and each opens the Agents page showing only those; **Open Agents** opens the whole page.
The menu lists no claim, so every claim shows on the Agents page.
Wherever the browser shows a claim, on a slice, an initiative, the roadmap, the sidebar, or the Agents page, it names the harness the agent runs in and the model of the session's main agent as `<harness> · <model>`, such as `Codex · gpt-5.5`, when the claim records them, and `Agent` and no model otherwise.
When a claim records a session that you can open from a link, such as a Claude Code on the web session, an inline claim, a claim's strip, and its row on the Agents page end with a **Session** link that opens that session in a new tab.
Only the person whose session it is can open it, so a teammate may see a link that does not open for them.
An avatar claim shows no link, and a claim whose host has no session to open, such as a local Claude Code or Codex session, shows none either.
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
When the agent names the initiative the approval serves, and the slice when there is one, the card's **Asked for** row links to them, and shows an id that the roadmap does not list yet, as requirements that start a new initiative do before their roadmap entry exists, as text marked not on the roadmap yet.
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

### Who asked a question

Under its question each card names the session that asked it, as `Asked by <harness> on <machine> · <repository>/<branch>`, such as `Asked by Claude Code on studio · shop/main`, with ` · cloud session` added for a Claude Code on the web session.
A question asked before Prism recorded who asks, or whose record is missing or damaged, reads `Asked by an unknown session`.
Beside that line a chip names the state of the asking session, and its description says why when Prism cannot tell:

| Chip | Meaning |
|---|---|
| Waits for your answer | A wait of an agent, on any machine that shares the records, holds the question, so your answer reaches it on its own. |
| Open, not waiting | The session is open on this computer but no wait holds the question. |
| Not running | The session is not open on this computer. |
| Prism cannot tell | The session is a cloud session, ran on another machine, ran in a harness that Prism cannot ask, or its harness did not answer. |

Prism tells whether a Claude Code session is open from `claude agents --json`, run in the checkout that asked, a Codex session from its thread lock under `CODEX_HOME`, or `~/.codex` without it, and a session that Prism launched from its launch.
Only the machine that asked can tell, because the session's id stays in that machine's review app folder and never reaches the shared records.
A wait holds its questions for 15 minutes and renews the hold every 5 minutes, so a wait that stopped without ending, such as one whose computer crashed, stops counting as waiting within 15 minutes.
For a session that is open but not waiting, the card says `Prism cannot reach this session, because no wait holds the question. Send any message in that <harness> session, and it reads the answer.`
A question that no session will read, because its asking session is not running or Prism cannot tell, has **Withdraw** under that line.
Withdraw closes the question without an answer and removes it from Attention, records who withdrew it and when, and starts no session.
It is unavailable while a session waits on the question, while the asking session is open, and once the question has an answer.
Withdrawing a requirement's or ADR's approval leaves the file's recorded status and accepted version as they were.
A session that later waits on a withdrawn question learns at once that you withdrew it, and does not act on it as answered.
An answered question whose answer cannot reach its asking session, because no wait holds it and that session is not open, has **Continue the work** on its card.
It lists the ways to continue, and names why each one that does not apply cannot, such as a question that names no initiative or an initiative that the roadmap does not list, was superseded, or shipped.
**New orchestration session** is the default: it launches the question's initiative as **Launch** does, with the initiative's host and models, and its start names the answered question, so the new session acts on your answer first.
**Resume the session that asked** continues the asking Claude Code or Codex session itself, under its own session id and headless in its own checkout, with a message that your answer is in Prism's records.
It applies only on the computer where that session ran, while that session is not running and Prism can tell so, and while no launched session of the question's initiative runs there, and never to a cloud session.
The confirmation names the session's host, the question, and the checkout, and shares the 30-minute window of **Launch**.
The resumed session then shows under the agents as a launched session, which **Stop** and **Resume** act on as on any other.
**Wake the cloud session that asked** posts one turn into the Claude Code on the web session that asked, from your own computer, through `claude -p <pointer> --cloud <session>` run in this checkout.
The turn is only a pointer, `Prism: question <id> of the initiative <initiative> has an answer in the review app. Read it from Prism's records before you continue.`, so neither your answer nor anything else of the question reaches Claude Code, and the cloud session reads the answer from Prism's records.
It applies only to a question that a cloud session asked, only when this review app does not itself run in a Claude Code cloud session, since a wake must be sent from your own computer, and only when `claude` is on `PATH`.
Claude Code delivers the wake only when it is signed in to the account that started the cloud session.
The confirmation names the cloud session's link, the question, and the initiative, says that Prism sends only a pointer, and shares the 30-minute window of **Launch**.
Under the asking line the card then shows the latest wake that this computer sent, as `Wake sent <time>` when Claude Code delivered it within 120 seconds, or `Wake not delivered: <reason>` with the last line Claude Code printed, such as a session of another account, or the reason it timed out.
You can wake the session again from the same card, and the latest wake stays only in this computer's review app folder.
Nothing starts until you confirm the launch, resume, or wake outside the browser, and a declined confirmation starts or sends nothing.
Answering a question starts no session by itself, here or when an answer arrives from another machine through the shared records.
Continue is unavailable while a session waits on the question or the asking session is open, since that session reads your answer itself, and for a session that Prism launched, which resumes from its launched session.
An answered requirement or ADR approval whose asking session Prism recorded stays under Answered with its answer, so you can continue its work, until a newer approval of the same file is asked or for 7 days.
Attention also lists blocked slices, open findings, failed verifications, and active work.
In a window as narrow as a phone, Attention opens on its list, and picking an item shows its card in place of the list, with **All items** to go back.
A slice that is not done is a failed verification while its latest verification run failed, with the reason in words, such as `The tests failed, 2 tests failed`, until a later run passes or the slice is done.
Choosing a kind or an initiative in the sidebar opens Attention filtered to it, at an address such as `attention:failed` or `attention:work/<initiative>`, which shows only those items, says above them the filter and its count, such as `Failed verifications · 1 of 14 items`, and offers **Show everything**.
Each filtered item opens where it is handled: a question opens Attention with that question picked so you can answer it, and a failed verification opens its slice.
Questions are the recorded questions that wait for an answer and the notes left for you; problems are unreadable or invalid records, a missing or invalid roadmap, initiatives with a record that the roadmap does not list, the roadmap's open questions, and workflow settings warnings.
Format findings are the requirement files, ADRs, glossaries, and feature files that break their Prism format, one item per kind of file, as `check_artifacts` reports them, in the checkout and in every record store scope the checkout sees.
The page `attention:formats`, which an agent can also open with `present_review`, shows each kind with its count, its files that keep an earlier Prism format under **Earlier Prism format** apart from the others under **No Prism format**, each file's path and the scope that holds it, and each broken rule with its message and line.
Every file that breaks its format counts, and nothing hides one; a changed file shows its new findings the next time the page loads, and a file that comes to keep its format leaves the count.
**Answered in the last 7 days** lists the questions answered or closed in the last 7 days, newest first, each with its initiative and slice and your answer or the reason the agent closed it.
Under Earlier questions it shows the 20 most recently closed questions with your answer, or with the reason the agent gave when it closed a question you had not answered in the browser.
Under Recent changes it shows the 20 newest actions applied from the review app, newest first: setting changes and answers of every initiative in the project's records, answers to the approvals of the requirements and ADRs this checkout sees, each with the file and its scope, comments on the files this checkout sees, each with the file, its scope, the line, and the start of the comment, and index rebuilds of this checkout.
Each change shows the value before and after it, the author's Git name, or email when no name is set, and the checkout label and host the change came from.
A change applied in any tab joins the top of the list at once, also a setting change or answer from another checkout whose records live in the same record store, and an approval answered or a comment made in another checkout of that store when this checkout sees the file, while another checkout's index rebuild never appears.
An answered approval stays under Recent changes after it leaves Needs you.
A change that a record store sync brings from another machine appears the next time Attention loads.

Only a tab that Prism opened can answer; see [Which tabs can make changes](#which-tabs-can-make-changes).
See [Upgrading to managed records](upgrading-to-managed-records.md#answering-in-the-browser) for the tool timeout that the Claude Code wait needs.

### Format migration runs

A [format migration run](workflow.md#format-migrations) that waits for your answers is a question on Attention, which counts its asked points.
A run that failed is a failed verification with its reason until a later run of its files follows it, and a run that waits for a host is a problem with the reason.
Each opens the run's page, at the address `migration-run:<run id>`, which an agent can also open with `present_review`.
The page is titled `Format migration` with the kind of file, and for a record store scope its scope label, and shows the run's status, why Prism started it, when, and each file of the run with its path and scope.
For each file it shows the summary of what changes and why, and in place of a line diff its statement map: each statement of the source, word for word in source order with its line, and where it landed, followed under **Added by the format** by each line the format added that holds no source statement.
Text that an agent wrote, such as a summary, a recommendation, or a path inside it, is shown as plain text and never becomes a link.

While the run asks, the page is its one question.
It numbers every point across the run, says what each asks, such as `Which value is missing?` or `Do these entries mean the same?`, and shows Prism's recommendation.
Each answer already holds that recommendation, so you change only what you disagree with and press **Send answers** once for the whole run.
Prism then applies every file of the run together, or none of them.
A value may be `unknown` only for a Draft requirement file or a Proposed ADR, and a value takes no line break.
When a run moves a separate source into another file, the page says that Prism removes the source once every statement has a home, and offers no choice to keep it.
After the run applied, the page shows each statement map, each point Prism settled with its reason, and each point you answered with your answer and who answered when.
After the run failed, the page shows the reason and offers **Run again**, which starts a new run of the files that still break their format.
A file in a record store that a run migrated says on its page `Prism migrated this file into its format`, with the date and a link to the run's page.

## Changes you make in the page

Every change that the review page makes is an action: answering a question, changing an initiative setting, commenting on a file in the record store, rebuilding an index, or launching, stopping, or resuming a launched session.
The page sends each action with the version of the record it showed you, so when an agent or another tab changed that record in the meantime, Prism refuses your action and changes nothing.
Apart from a rebuild, which starts Prism's own indexer, the launched-session actions of [Launched sessions](#launched-sessions) on [the Agents page](#the-agents-page), and the agent installs of [Install, update, or remove an agent](#install-update-or-remove-an-agent), which run `npm` or `uv` in Prism's own folder, an action changes only Prism's records, and it never runs a command, changes a project file, or writes to Git.
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
| Host | Each host Prism supports: Claude Code, Codex, and each [ACP agent](#acp-agents) this computer offers | None stored, shown as the first host found on this computer | For launches started after the change; a running or resumed session keeps the host it started on. |
| Autonomy | `conservative`, `broad`, `full` | `conservative` | Decides which later gates wait for you; a gate already open keeps waiting for you. |
| Commit | `off`, `on` | `on` with `full` autonomy, otherwise `off` | For agents started after the change. |
| Push | `off`, `on` | `off` | For agents started after the change. |
| Continuation | `auto`, `stepwise` | `auto` | When the slice in progress finishes. |
| Review | `marked`, `recommended`, `all` | `marked` | Sets the review mark of slices whose design is not yet accepted; a slice whose design is already accepted keeps its review. |
| Models | For each host, a provider and the model and effort of the coordinator, design and implementation, code review, security review, and design gate summary agents | The host's own default for each | The coordinator's for launches started after the change, and each agent's for agents started after it. |

Choosing a host that is not found on this computer is refused with its reason, such as `Claude Code was not found: no claude executable on PATH.`
An ACP agent is stored as `acp-<id>`, and a checkout on a computer that does not offer that agent shows it as not found.
A change to Models names one host and keeps the choices of every other host.
It takes only a provider, model, or effort that the host reports, its default, or a model name you typed, which Prism cannot check; a value the host does not offer is refused with a reason such as `Claude Code on this computer does not offer the model claude-opus-3.`
While the host cannot report its options, Models takes only the host's defaults and typed model names.
An initiative's earlier Models value keeps its meaning: `host defaults` reads as the host's default for every choice, and named delivery, review, security review, and examples models read as typed models of the design and implementation, code review, security review, and design gate summary agents of every host.
A named model that is no model name, such as `Claude Opus 4.1`, is kept as an earlier model name, and that agent runs with the host's default model instead, because Prism never passes the name to a host.
A Models change that still holds it is refused with a reason such as `Prism kept the earlier model name Claude Opus 4.1, which Claude Code cannot take as a model.`, and choosing another model, the host's default, or a model name you type replaces it.

Turning autonomy to `full`, commit on, or push on asks you to confirm first, because it lets agents act further without you.

Every setting can change at any time, including after work on the initiative started.
Once an initiative ships, its state is history, so every action on the initiative, its slices, and its questions shows as unavailable with the reason `The initiative shipped on <date>, so its state is history.`, and Prism refuses one sent anyway and changes nothing.
Index actions are not part of an initiative, so shipping one leaves them available.

### Initiative settings

**Settings** at the top of the initiative page opens the **Settings of <initiative>** dialog, and on every slice page of the initiative an **Initiative settings** card opens from **Details and settings** at the end of the page bar, below the slice's details.
An initiative whose record cannot be read and that the roadmap does not list has no settings, so its page offers none.
On a slice page the card names the initiative above its title, because the settings belong to the whole initiative and a change there applies to every slice.
Each setting shows its options as a button group, the sentence on when a change takes effect, and for an on or off setting what the picked option does.
**Host** is one choice of every host Prism supports, as found on this computer: Claude Code, Codex, and each [ACP agent](#acp-agents), each with a line under its label.
The line says what choosing the host does, or why it cannot run: a host this computer lacks shows its reason, such as `Codex was not found: no codex executable on PATH.`, and cannot be chosen, and an ACP agent whose models were read shows its sign-in or failed reason, such as `<label> needs you to sign in before it can run:` and its sign-in methods.
**Models** follows the host that the choice shows, and switching the host shows the choices kept for that host, so switching back shows the first host's choices as they were.
It shows a **Provider** picker when the host reports providers, as Codex does, and then one picker for the **Coordinator** and one for each kind of agent: **Design and implementation**, **Code review**, **Security review**, and **Design gate summary**.
Each picker shows the chosen model and effort, such as **Fable 5.2 · High effort**, or **Host default** and **Host default effort** for the host's own choice.
While the review app asks the host for its options, each picker reads **Reading <host>’s models…**; a host that does not answer shows its reason, such as `Claude Code did not report its run options: it gave no answer within 20 seconds.`, and its pickers still offer the host's default and a model name you type.
A model picker opens a list you can filter, with **Host default**, the models the host reports with their descriptions, and **Other model…** last, and below the list the effort levels of the chosen model, which change when you choose another model.
A host or provider that reports no models says so, such as `Codex reported no models.`, and offers only the host's default and **Other model…**.
The **Models** section, and each model picker below its effort levels, names the program its list came from, with the version that program reported and its path, such as `Listed by Claude Code 2.1.330 at /opt/homebrew/bin/claude.`, so a list of only older models points at an older installation that comes first on the review app's `PATH`.
A host that reports no version says so, such as `Listed by Codex at /usr/local/bin/codex, which did not report its version.`, and a host that did not answer reads `Prism asked Claude Code at /opt/homebrew/bin/claude.`
**Other model…** shows a **Model name** field: Enter takes a name of letters, digits, and `. _ - : / @ [ ] +` that starts with a letter or digit, and the picker then says `Prism cannot check a model you typed; Claude Code receives it as written.`
A choice the host does not offer, such as a saved model this computer's host no longer lists or an effort the newly chosen model does not take, shows as **Not offered** with its reason until you choose a value the host offers.
A saved choice the review app cannot check, because the host did not report its options or Codex could not list its models, shows as **Not checked** with the host's own reason, such as `Not checked: Claude Code did not report its run options: Not logged in.`, and **Apply** refuses it with that reason, so you can retry once the host answers instead of replacing a choice it may still offer.
An earlier model name that Prism kept shows as not offered in the same way, and **Apply** sends it back as it was, so the change is refused until you choose another model for that agent.
In the dialog, the options you pick wait for **Apply**, which counts them, such as **Apply 2 changes**, and applies them one by one; it stops at a change that is refused or that you do not confirm, and closes once all of them applied.
**Cancel**, Esc, or **Close** closes the dialog and drops the changes you have not applied.
On a slice page's card, picking an option applies it at once.
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

## ACP agents

Besides Claude Code and Codex, Prism lists as a host each Agent Client Protocol (ACP) agent that you declare on this computer, and each one installed in the review app folder's `agents/` folder, whose `current.json` names the version in use.
Every host list reads the declarations and installs again on each request, so an agent you declare, install, or remove appears or disappears without restarting the review app.
The **Host** setting lists Claude Code, then Codex, then the installed agents in the order they were installed, then the declared ones in file order, each as `acp-<id>` with its label.
Prism's own runs do not run on ACP agents, so **Prism's own runs** lists each of them as unavailable.
**Launch** starts a [launched session](#launched-sessions) on an ACP agent as on Claude Code or Codex, and [What runs](#what-runs) says how it runs there.

To show an ACP agent's models and efforts, the review app starts the agent's own command in the checkout, opens one session with Prism's tools, reads the options the agent reports, and closes the session without sending it any prompt.
The **Coordinator** picker lists the agent's models in the agent's order and the efforts of the chosen model lowest first, each after **Host default**, and leaves out every other option the agent reports, such as its mode.
The pickers of the other agents offer only **Host default** and say `<label> chooses the models of its own child agents.`, because the protocol gives Prism no way to choose them.
An agent that speaks another protocol version shows `<label> speaks ACP version <n>, and Prism speaks version 1.`
An agent whose session does not start Prism's tools shows `<label> did not start Prism's tools, so it cannot run Prism's workflow: it ignores the tool servers that Prism names when it opens a session, or starts them later than Prism waits.`
An agent that needs you to sign in shows `<label> needs you to sign in before it can run:` and the names of the sign-in methods it names, each with its description only when the description says more than the name, followed by `Prism checks that it starts Prism's tools once you have signed in.`, since an agent opens no session before then; Prism never signs in for you, so sign in with the agent's own command in a terminal, and the pickers read the agent again the next time they open.
While the initiative's ACP host shows one of these reasons, **Launch** is unavailable with that reason and asks you nothing.
In the **Launch** and **Settings** dialogs the reason shows once, under the host in the **Host** choice, and **Launch** stays unavailable while the chosen host cannot run; the dialog's banners show only reasons that the **Host** choice does not, such as a model the host does not offer.

Declare agents in `acp-agents.json`, which Prism only reads and never writes:

| Platform | File |
| --- | --- |
| Any | The file that `PRISM_ACP_AGENTS` names, when it is set |
| Windows | `%APPDATA%\Prism\acp-agents.json` |
| macOS | `~/Library/Application Support/Prism/acp-agents.json` |
| Linux and others | `$XDG_CONFIG_HOME/prism/acp-agents.json`, or `~/.config/prism/acp-agents.json` without that variable |

```json
{
  "agents": [
    { "id": "gemini", "label": "Gemini CLI", "command": "gemini" }
  ]
}
```

Each entry takes these fields:

| Field | Rule |
| --- | --- |
| `id` | 1 to 40 lowercase letters, digits, and `-`, starting with a letter or digit; the host is `acp-<id>`. |
| `label` | 1 to 60 characters without control characters. |
| `command` | An absolute path, or a bare name of 1 to 100 letters, digits, `.`, `_`, and `-` that `PATH` resolves. |
| `args` | Optional: at most 32 strings of at most 2000 characters. |
| `env` | Optional: at most 32 names of the form `[A-Za-z_][A-Za-z0-9_]*`, each with a string of at most 2000 characters. |
| `autoMode` | Optional: the agent's mode value, of at most 100 characters, that runs without asking for each step. |
| `resumeCommand` | Optional: at most 500 characters holding `{session}`, the terminal command that continues a session. |

Prism takes an agent's command, arguments, and environment only from this file or an install record, and the review page cannot name any of them.
An entry that breaks a rule or takes the `id` of an installed agent is no host.
An entry that repeats an earlier entry's `id` is left out, and the earlier entry counts for that `id`.
The ids `claude-acp` and `codex-acp` are no hosts either, because Prism runs Claude Code and Codex through its own integrations.
A missing file declares no agent, and a file that cannot be read or parsed declares none.
An agent whose command is not found shows its reason, such as `Gemini CLI was not found: no gemini executable on PATH.`

`GET api/coding-agents` lists every installed and declared agent with its origin, its installed version, and whether it can be launched, with the reason when it cannot, such as the rule its entry breaks, and an unreadable declaration file is listed once with its reason.

### Agents from the registry

`GET api/coding-agents` also lists the agents of the public ACP registry at `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, or of the index that `PRISM_ACP_REGISTRY_URL` names.
That URL must use `https`, or `http` to `127.0.0.1` or `localhost`, and any other URL is not read.
Prism keeps a read of the index for 10 minutes, so an agent that the registry adds or updates can take that long to show.

Prism lists only the registry agents that this computer can run: those with a build for this operating system and processor, such as `linux-x86_64`, `linux-x86_64-musl` on a musl Linux, `darwin-aarch64`, or `windows-x86_64`, and those with an `npx` or `uvx` package, which every computer takes.
The registry's `claude-acp` and `codex-acp` are never listed, because Prism runs Claude Code and Codex through its own integrations.
Each agent shows its name, version, authors, license, source (its repository, else its website, else its download), and description, and whether it is installed, with an update when the registry lists another version of the installed one.

Prism installs only what it can check and lock, so an agent cannot be installed, and says why, when:

- its build for this computer lists no SHA-256 checksum, so its download cannot be checked;
- its build is neither a `.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`, or `.tbz2` archive nor the program itself, such as a `.dmg` or `.tar.xz` download;
- its `npx` package does not name an exact version, such as `@google/gemini-cli@0.70.0`;
- its `uvx` package does not pin one with `==`, such as `fast-agent-acp==0.10.1`;
- `npm`, for an `npx` package, or `uv`, for a `uvx` package, is not on `PATH`.

While the registry cannot be read, the list says why, keeps every installed and declared agent with the details its install recorded, and offers no install or update until the registry answers again.

### Coding agents in Settings

**Coding agents** in [Settings](#layout) lists every agent of `GET api/coding-agents`, read again each time you open the section: the installed agents, then the registry's other agents for this computer, then the declared ones.
Each row shows the agent's name and version, its authors, license, and source, which opens in a new tab, and its description.
An installed agent is marked **Installed**, a declared one **Declared**, and an available update shows as **Update <version>**.
A registry agent that is not installed offers **Install**, or in its place the reason it cannot be installed, such as a build without a SHA-256 checksum.
An installed agent offers **Update** while the registry lists another version, and **Remove**, which asks you in the page first.
A declared agent offers neither, because Prism does not install it; change it in `acp-agents.json`.
An installed or declared agent that cannot run says why under its description, such as `Broken agent was not found: no executable file at /nowhere/broken-agent.`
**Install** and **Update** wait for the confirmation outside the browser that [Install, update, or remove an agent](#install-update-or-remove-an-agent) describes, and the row says so meanwhile; a refused or declined one shows its message in the row.
Below the list the section says when the registry was read, and while the registry cannot be read a warning names its reason, such as `it answered HTTP 503`, and the list keeps only the installed and declared agents.
In a tab that can only read, the section shows the read-only notice and its buttons are disabled.

### Install, update, or remove an agent

The actions `agents.install`, `agents.update`, and `agents.remove` on the target `agent:<id>` install, update, and remove a registry agent on this computer.
Install and update read the registry again when you apply them, so they install the version the registry lists at that moment, not the one a page showed earlier.
Before anything is downloaded, Prism asks you every time in a dialog of your operating system, outside the browser.
The dialog names the agent, its authors, its exact version, its license, its source, and the download or package, and says that it runs with your permissions on this computer.
Its default answer cancels, and a cancelled dialog installs nothing and refuses the action with `confirmation_declined`.

Prism runs no install, build, or lifecycle script of an agent or its dependencies, and runs no code of a download before you confirm:

| Kind | Before the dialog | After the dialog |
| --- | --- | --- |
| Build for this computer | Nothing | Downloads the build, checks its SHA-256 against the registry's, and only then unpacks it with Prism's own code, or places it as the program when the download is the program itself, refusing any entry with an absolute path, a `..` part, or a link that leads outside the version folder, read as written or followed through the archive's other links, whether or not its target exists |
| `npx` package | Resolves a lockfile with `npm install --package-lock-only --ignore-scripts` | Installs from that lockfile with `npm ci --ignore-scripts` and checks that the installed version is the registry's |
| `uvx` package | Resolves hashed requirements with `uv pip compile --generate-hashes --no-build` | Creates a virtual environment and installs them with `uv pip sync --no-build --require-hashes`, so a requirement that needs a build fails, and checks that the requirements pin the registry's package and version and that the environment holds a program named after the package |

A download whose checksum or package version differs from the registry's installs nothing, leaves no file of it behind, and is refused with `install_mismatch`, naming the expected and the found value.
An agent that needs its install scripts to work fails when it starts, with its own error.
Every `uv` run has `UV_PYTHON_DOWNLOADS=never`, so `uv` uses only a Python already on the computer, and a computer without one refuses the install with `uv`'s own reason.

Each install lives in the review app folder's `agents/<id>/<version>/` beside its `install.json`, which records the registry entry, the command, arguments, and environment, and the install time.
`agents/<id>/current.json` names the version that new sessions run.
Each install lays out its downloads, the `npm` and `uv` caches, and the new version in a folder of its own under `agents/.staging/`, which it removes when it ends, and moves the version into `agents/<id>/<version>/` only once every check passed, so nothing outside `agents/` changes, neither your own `npm` or `uv` configuration nor any sign-in.

An update makes the new version current only once it installed and its command, arguments, and environment keep the rules of a [declaration](#acp-agents), and otherwise it is refused with `install_failed` and the rule it breaks, so a failed update keeps the earlier version in use.
Each launched session runs on the version that was current when its run started, and a later run of it, such as a resume, runs on the version current then.
The earlier version's folder is removed once no launched session runs on that version: when the last such session's run ends, or at the next start or periodic check of any review app on this computer, even if the review app that ran the update has ended.
While it is still kept for such a session, an update back to that version is refused with `agent_running`, so the running session keeps its files; stop the session and update again.
A removal deletes every folder of the agent, reads nothing from the registry, and is refused with `agent_running` while a launched session runs on it; afterwards the agent is no host.
One install, update, or removal runs at a time on a computer, and another one meanwhile is refused with `install_running`.

## Launched sessions

A launched session is a headless Claude Code, Codex, or [ACP agent](#acp-agents) session that runs Prism's orchestrate skill for one initiative on this computer, started from the review page.
It works on the initiative as an agent you started in a terminal would, and you watch, stop, and resume it from the page.
At the start of each launch and each resume, Prism tells the run that no person reads its messages.
The run then asks you only through a gate that the review page shows, or it decides by itself where its autonomy lets it.
Claude Code gets this note as an appended system prompt, Codex as the instructions of its thread, and an ACP agent as the last text block of its prompt.
Prism also launches a session of its own for each [format migration run](workflow.md#format-migrations), without asking and without the dialog, which runs Prism's `migrate-artifact` skill for that run alone, gets no such note, and asks you only on the run's own page.

### Launch an initiative

**Launch** at the top of the initiative page opens the run configuration, a dialog named **Launch <initiative>**; a slice page offers no launch.
It shows the latest run when there is one, then **Host**, **How the run works** with **Autonomy**, **Commit**, **Push**, **Continuation**, and **Review**, and **Models** with the coordinator and each kind of agent, each set to the initiative's current value as **Settings** shows it.
Each option says what it does when you point at it, and the chosen option's effect shows under its group.
Opening the dialog starts nothing.
Changing **Host** shows the choices kept for that host and renames the launch button, such as **Launch with Codex**, and each host shows under its label why it cannot run, as in **Settings**, and a host this computer lacks cannot be chosen.
**Cancel**, Escape, and the close button discard the dialog's changes and launch nothing.
**Launch with <host>** saves every changed choice as the initiative's settings, asking you in the page first for a risky one such as **Push** on, and then starts the session, so the initiative's history records the settings before the launch.
While a choice is not offered, the button is disabled and the dialog names the field and its reason, such as `Code review: Claude Code on this computer does not offer the model claude-opus-3.`, until you choose a value the host offers.
A refused or declined launch, such as `You declined the launch.`, shows its message in the dialog and keeps it open, with the settings already saved.
With no host stored, the launch runs the first host found on this computer.
The launch is unavailable, and the dialog still shows the settings with its launch button disabled, with `No host that Prism supports was found on this computer. Prism supports Claude Code and Codex.` while neither `claude` nor `codex` is on the review app's `PATH`, with a reason such as `Codex was not found: no codex executable on PATH.` while the initiative's host is missing, and with `A launched session of <initiative> is running on this machine.` while a launched session of the initiative runs on this computer.
It is also unavailable with `This initiative's saved settings cannot be read, so Prism cannot tell which host, models, and efforts to launch with.` while the initiative's coordination state cannot be read, so nothing starts with another host or other choices than the ones you saved.
Before it asks you anything, the launch checks the provider and every model and effort that **Models** keeps for the host against what the host on this computer reports, and refuses the first one the host does not offer with its field and reason, such as `Coordinator: Claude Code on this computer does not offer the model claude-opus-3.` or `Design and implementation: Prism kept the earlier model name Claude Opus 4.1, which Claude Code cannot take as a model.`; a launch whose choices are all host defaults asks the host nothing.
When the host cannot report its options, the launch is refused with the field that needed them and the host's reason, such as `Coordinator: Claude Code did not report its run options: it gave no answer within 20 seconds.`, so you can retry once the host answers instead of replacing a choice it may still offer.
The session runs with the coordinator's model and effort: Claude Code receives them as `--model <model>` and `--effort <effort>`, and Codex starts its thread with the model and provider and its turn with the effort, and each is left out for the host's default.
A model name you typed reaches the host only as that model, and the session's prompt stays `/prism:orchestrate <initiative>`.
A resume runs with the provider, model, and effort that the session was launched with, not with the settings at the time of the resume.
Checkouts whose records live in the same place, such as two checkouts of one shared store, count as one initiative here, so only one launched session of an initiative runs on this computer at a time.
Like every action, a launch needs a tab that can make changes.

The initiative page also shows how the initiative's latest launched session on this computer stands.
While that session failed, is blocked, waits for you, or runs, the page head shows `Last run failed`, `Last run blocked`, `Waiting for you`, or `Running` beside **Launch**, and pressing it opens the run configuration; in a tab that cannot make changes the state stands beside **Open in Agents**, which opens the Agents page.
At the top of the run configuration, **Latest run** names the session's host and state, with its reason, such as `Claude Code reported an error:` and the host's own message or `Codex ended with exit code 1.`, and **Open in Agents** opens the Agents page.
The page reads this every few seconds, so a session that fails moments after it starts shows there without a reload.

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

Claude Code runs as `claude -p --verbose --session-id <session id> --input-format stream-json --output-format stream-json --permission-mode auto --permission-prompts host --permission-prompt-tool stdio` with the prompt `/prism:orchestrate <initiative>`.
Codex runs as `codex app-server` with the approval policy `on-request`, the automatic approval reviewer, and the `workspace-write` sandbox, and the prompt `$prism:orchestrate <initiative>`.
An ACP agent runs as the command, arguments, and environment of its declaration or install record, and Prism declares no file system or terminal capability to it.
Prism opens one session in the checkout whose only MCP server is Prism's own, run by the review app's Node with `NODE_USE_ENV_PROXY=1`, `PRISM_LAUNCH`, and the review app folder, and it sets the agent's automatic mode, the declaration's `autoMode` or else the agent's `auto` mode, then the coordinator's model and effort, before the prompt.
Prism never sets a mode that bypasses or accepts all permissions, such as `bypassPermissions` or `agent-full-access`, even when a declaration names it, and an agent without an automatic mode keeps its own.
A value the agent does not offer fails the run before its prompt with `<label> does not offer <value> for <option>.`.
Prism waits up to 60 seconds for its tools to start in the agent's session, and an agent that does not start them ends with that reason and receives no prompt.
Prism's skills are not installed in an ACP agent, so the prompt carries the text of the orchestrate skill, as an attached resource where the agent takes one, and the instruction to run it for the initiative and to read every other skill file it names with Prism's `get_skill` tool.
Prism answers no other request of the agent's, and a permission request it asks waits on Attention as described in [Permission requests](#permission-requests).
A run on an ACP agent fails with `<label> stopped: <reason>.` when the agent stops for a refusal, its token limit, or its turn limit.
A format migration run's session reads only.
It runs in an empty folder of its own, `launch-work/<launch id>` in the review app folder, outside the checkout, and that folder is removed with its launch.
Claude Code runs with `--tools ""`, so it has no built-in tool and reads no file, `--mcp-config` naming only Prism's own server, `prism-run`, scoped to the run, with `--strict-mcp-config`, so no MCP server of your own configuration or of another plugin loads, `--settings` with `disableClaudeAiConnectors` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`, so no claude.ai connector loads, an `--allowedTools` list of that server's five tools alone, a `--disallowedTools` list that denies `Read` of the checkout and everything below it, which wins over any allow rule or added folder in your own Claude Code settings, naming a Windows checkout as Claude Code matches it, such as `//c/Users/me/api`, no `--add-dir`, and `--permission-mode dontAsk` in place of the automatic permission mode, so no shell command runs, and the prompt is `/prism:migrate-artifact <run id>`.
Codex runs with the approval policy `never` and the `read-only` sandbox, readable only in its folder, Prism's own folder, Codex's plugin cache, and the platform's own, and with a thread configuration whose `mcp_servers` names only Prism's scoped server, with the prompt `$prism:migrate-artifact <run id>`.
Whether Codex replaces your own `mcp_servers` with that configuration or adds it to them is not confirmed, and an MCP server that Codex loads runs outside its sandbox, so keep MCP servers that read your files out of the Codex configuration of a computer that runs Prism's own runs on Codex.
The session's environment holds `PRISM_MIGRATION_RUN` with the run's id and `PRISM_MIGRATION_PROJECT` with the checkout's real path, and a Prism server started with them lists and takes only `get_migration_run`, `get_artifact`, `propose_migration`, `finish_migration_run`, and `fail_migration_run`, each for that run and that project only, so a call may leave `projectRoot` out.
There `get_migration_run` also gives the configured paths, whether a record store is configured, each source's Git history, and `format`, the set type's current format with the path and exact text of its reference in the Prism that serves the run, which the session takes in place of reading the reference file, and `get_artifact` reads the run's artifacts and the files of their type under its configured path, by that type's extension and name rules, in the checkout too and without a store, and refuses every other path, every dot-file, and everything in a dot-folder, such as `.env`, `.prism`, or `.git/config`, and every other call with `migration_scope`.
An initiative's session runs in the checkout's folder; each runs with the review app's environment, without the variables of an agent session that the review app may have inherited, and with `PRISM_LAUNCH` set to the launch's id.
In an initiative's session, the host's own permission handling and the project's own host settings apply first: Claude Code decides what it can in its auto mode and Codex under its automatic reviewer, and each asks Prism only the rest, so how often a session asks depends on your host settings.
Prism answers no question of the host itself, and an action that the host's automatic handling refuses ends as a refusal that the session shows.
A session keeps running when the review app exits, idles out, restarts, or is replaced by a newer release, because a supervisor process of its own starts and watches the host.
Each launched session keeps its record in `launches/<launch id>/` in the review app folder, readable only by you, and Prism removes it 14 days after the session's last run ended.
The host's session id stays in that record on this computer: no shared record, history entry, or log holds it, and only this computer's page shows it, in the command that continues the session in a terminal.
Each run keeps the last 64 KiB of its host's standard error, with the host's session id replaced, in `run-<n>.stderr` of the launch's folder, and a run that failed without an error answer gives as its reason the last line of that text that is not a stack frame.
A run on an ACP agent also keeps the usage the agent reported: the tokens of its answer, the context used and its size, and the cost, each shown as not reported when the agent gave none.
Each run also keeps the model its host reports as soon as the host names it, from Claude Code's first `init` event or from the result of Codex's thread start or resume, and a launched session names the model of its latest run; a run whose host names no model, or a value longer than 128 characters or holding a control character, keeps none.

### Permission requests

Each permission request that a launched session's host still asks, Claude Code's prompt to use a tool, a Codex approval of a command, a file change, or more permissions, or an ACP agent's request to run a tool, keeps the session waiting and waits for you on this computer's Attention.
An ACP agent's request to call one of Prism's own tools, which the agent names as `prism/<tool>`, `prism__<tool>`, `prism.<tool>`, `prism:<tool>`, or `mcp__prism__<tool>` for a tool that Prism's server listed to it in the run, is the exception: Prism allows it once without asking you, because those calls are what the run was launched to make, and counts it in the run's record.
It lists with the initiative, the host, the action that the host named, the host's reason, and when it was asked, oldest first, and it counts toward the waiting questions that the page's title and desktop notification show.
The action holds everything that an allow of the request covers, as compact JSON after a short name:
- A Claude Code request shows the tool and the input it would run with, such as `Write {"file_path":".claude/settings.local.json","content":"{}"}`, because that input is what an approval allows.
- A Codex command shows the command, such as `touch /etc/hosts`, followed by the folder, environment, kind, and network host it runs with whenever Codex sets them, such as `curl https://example.com {"cwd":"/","networkApprovalContext":{"host":"example.com","protocol":"https"}}`; the amendments Codex proposes are left out, because Prism never applies one.
- A Codex file change shows `File change` and the paths, kinds, and diffs of every file it writes, as Codex last described the change before it asked, plus the folder it asks to write under for the rest of the session when it asks for one, such as `File change {"changes":[{"path":"src/new.txt","kind":{"type":"add"},"diff":"hello\\n"}]}`.
- A Codex permissions request shows `Permissions` and the permissions it asks for.
- An ACP agent's request shows its tool call's title followed by the tool call's raw input, such as `Write file {"file_path":"notes.txt","content":"hello"}`, with the title, kind, and raw input taken from the agent's earlier updates of the same tool call when the request leaves them out; an agent that sends no raw input shows only the title, or `a tool of kind <kind>` without one, because that is all it says the tool call does.
The action and the reason show on one line with every character the host sent visible: a backslash shows as `\\`, a line feed as `\n`, a carriage return as `\r`, a tab as `\t`, and any other control, format, or line or paragraph separator character as `\u{<code>}`, such as `\u{202E}`, so no host text can hide part of itself or add a line.
An action or reason longer than 1,000 characters shows as its first 1,000 characters followed by `…`, and such a request can only be refused: **Allow** answers `approval_too_long` before any dialog, because a confirmation could not show what you would allow.
The session shows **Waiting for you** with the reason `Asks you to allow: <action>.`.
On Attention each request lists under **Needs you**, before the questions, with a lock, the action as its title, `Permission · <initiative> · <host>` under it, and how long ago it was asked.
Its card is headed `<host> asks you to allow: <action>`, lists **Initiative**, **Host**, **Action**, and **Reason**, and offers **Allow** and **Refuse** with the hint `You confirm outside the browser.`.
When Prism refuses your answer, such as an **Allow** answered with `approval_too_long`, `approval_unavailable`, or a declined confirmation, the card shows why in plain words and the request stays on Attention until you refuse it or it ends.
A request lives only in the session's folder on this computer, so it never reaches a shared record or another machine, and only the review app of the computer whose session asked it can answer it.

**Allow** asks you again outside the browser every time, in a dialog of the operating system that names the initiative and the host, then shows the whole action and the whole reason each on its own line, and whose default button refuses; an open launch window does not skip it.
The process that runs the session and answers its host shows that dialog itself, and it allows only the request whose own dialog you confirmed, so no file or message that another program of this computer writes, the session's host included, can approve anything.
Only once you choose **Allow** there does Prism answer the host, and it answers with the host's allow for this one request alone: Claude Code runs the tool with the input it asked for, Codex accepts the command or file change and nothing more, and an ACP agent gets its allow-once option.
When you choose **Refuse** in that dialog, or nobody answers within 2 minutes, the request keeps waiting and the action is refused with `confirmation_declined` or `confirmation_timeout`.
A request whose host offers no allow that covers only this one request, such as an ACP agent that offers only an always-allow option, cannot be allowed and is refused with `approval_unavailable`.
Some requests can only be refused, and **Allow** answers `approval_unavailable` before any dialog, with the request still waiting until you refuse it or it ends:
- A Codex permissions request, because the narrowest grant Codex takes lasts for the rest of its turn: `Codex asks for these permissions for the rest of its turn, so Prism can only refuse it.`
- A Codex file change that asks to write under a folder for the rest of the session: `Codex asks to allow writes under <folder> for the rest of the session, so Prism can only refuse it.`
- A Codex file change whose files Codex did not describe before it asked, or described as no change, whose action shows as `A file change that Codex did not describe`: `Codex did not say which files this change writes, so Prism can only refuse it.`
- A Codex command request without a command, whose action shows as `A command that Codex did not name` followed by the folder, environment, kind, and network host Codex sets: `Codex did not say which command this runs, so Prism can only refuse it.`
- A Claude Code request without a tool name, whose action shows as `A tool that Claude Code did not name` followed by its input: `Claude Code did not say which tool this runs, so Prism can only refuse it.`
- An ACP agent's request whose tool call has neither a title nor a raw input, whose action shows as `A tool of kind <kind> that <label> did not describe`: `<label> did not say what this tool call does, so Prism can only refuse it.`

**Refuse** needs no dialog: Claude Code is told `The person refused this on Attention.`, Codex declines, or for a permissions request is granted no permission, and an ACP agent gets its reject-once option, or a cancelled answer when it offers none.
When the session's run ends, or you stop it, while a request waits, Prism refuses the request to the host if it still runs and removes it from Attention.
When Codex changes the patch of a file change while its request waits, what an allow would cover has changed, so Prism declines that request and removes it from Attention, and a dialog for it that is open then allows nothing.
When the host reports that it settled a waiting request by itself, as Codex does with `serverRequest/resolved`, an ACP agent with `$/cancel_request`, and Claude Code with `control_cancel_request`, Prism removes the request from Attention without answering it, the session no longer shows **Waiting for you** for it, and a dialog for it that is open then or that you confirm later allows nothing.
An answer to a request that no longer waits in the session is refused with `unknown_request`.
Each answer is recorded in the initiative's history as `launch.permission` with the decision and the action.

### How the review app reads a host's models

The review app offers only the models, providers, and effort levels that a host on this computer reports, so it asks the host itself, and only for a tab that can make changes.
Claude Code is asked as `claude -p --verbose --no-session-persistence --settings {"disableAllHooks":true} --strict-mcp-config --mcp-config {"mcpServers":{}} --input-format stream-json --output-format stream-json` with one `initialize` request and no prompt.
Codex is asked through `codex app-server` for its providers and its visible models, without opening a thread.
Either way, the host runs in the checkout's folder without the variables of an agent session, starts no model turn, so it spends no usage, keeps no session in its history, and runs none of your hooks or MCP servers.
The review app closes the host's input once it has the answer, and ends a host that still runs 5 seconds later.
A host that gives no answer within 20 seconds is ended and reported as `<host> did not report its run options: it gave no answer within 20 seconds.`; set `PRISM_RUN_OPTIONS_TIMEOUT_MS` for the review app to wait from 200 to 60000 milliseconds instead.
A host that sends more than 4 MiB, or lists more than 1000 models or 100 providers, is reported as failed with that reason, and the review app shows at most 100 characters of each name, 300 of each description, and 16 effort levels for a model.
A host's answer is kept for 10 minutes per checkout, and per provider for Codex, while an answer that failed is asked for again next time.
The review app leaves out every option that it does not know or that changes how the host grants permissions, so those stay at the host's own values.

### The Agents page

The Agents page lists every agent working on this workspace and every session launched on this computer, one row each.
Open **Agents** from the top bar's **Agents** menu or the Jump palette, or at the address `review?artifact=agents`; the old address `review?artifact=launches` opens it too.
Its lead reads `Every agent working on this workspace, and every session launched on this computer.`.
It lists every launched session on this computer whose checkout shares this checkout's records, and every live or expired claim on the workspace's slices that no launched session here holds.
A launched session holds the claims its own agent takes, so its slice shows in its row rather than in a row of its own.

**Show** narrows the table: **All**, **Needs you**, **Launched from Prism**, **Started outside Prism**, **Expired**, and **Archived**, each with its count.
**All** shows neither an archived session nor a claim whose lease passed a day ago or more, and counts only what it shows; a claim leaves it once its expiry is a day old.
**Launched from Prism** shows the **Needs you** and **Launched from Prism** groups, every launched session that is not archived, **Expired** shows every expired claim however long ago it expired, and **Archived** shows only the archived sessions.
The addresses `agents:needs-you`, `agents:this-computer`, `agents:other`, `agents:expired`, and `agents:archived` open the page with that choice made.

The table's columns are **Agent**, **Host · model**, **Working on**, **State**, and **Time**, and a last column holds a row's actions.
Its groups come in this order, each with the count of what the Show choice shows of it, and a group without agents is left out:

| Group | What it lists |
| --- | --- |
| Needs you | Launched sessions that failed, then those that ended without a result, then those that wait for your answer, the latest launched first. |
| Launched from Prism | Every other launched session that is not archived, the latest launched first. |
| Started outside Prism | Agents that hold a live claim, the claim that lapses first first. |
| Claims that expired | Claims whose lease passed, the latest to lapse first. |
| Archived | Archived launched sessions, the latest launched first, shown only under **Archived**. |

A launched session's name is its initiative's title, which opens the initiative page, or for a format migration run's session `Format migration` with the type's label, such as `Format migration · Requirements`, which opens the run's page, and under it the row says when it started, how its last run ended, and how many runs it had when more than one.
A claim's name is the claim's label, such as `Dana on studio-mac`, which opens the slice it works on.
**Host · model** names the harness and the model as `<harness> · <model>`, the harness alone without a model, and `Agent` when nothing names them.
**Working on** says `Ended <time> ago: <reason>` for a failed session, and otherwise the activity and the slice, such as `design · Retention policy`, or the session's reason.
**Time** is how long a launched session has run, which counts every second while it runs, `<n> min left` for a live claim, and `expired <time> ago` for an expired one.
A session that waits offers **Answer**, which opens Attention with the question it waits on selected and its answer form shown; a running session offers **Stop**; any other session offers **Open**, which unfolds its details under its row.
A finished, failed, stopped, or blocked session that is not archived also offers **Archive** beside **Open**, and an archived one offers **Unarchive** there.
A session that ended without a result offers **Answer**, which opens its card on Attention, and **Archive**, while its question is open, and otherwise **Open** and **Archive**.
A claim offers no action.

The details of a session on an ACP agent start with the usage the agent reported for its last run: **Tokens** with the total and the cached tokens, such as `182,400 (12,000 cached)`, **Context** as the used and whole context, such as `61,200 of 200,000`, and **Cost** with its currency, such as `0.42 USD`, each `Not reported by <agent>` when the agent gave none.
The details hold the session's reason, the command that continues it in a terminal while no run runs and the host reported its session id, `claude --resume <session id>`, `codex resume <thread id>`, or an ACP agent's declared `resumeCommand` with `{session}` replaced, with the folder to run it in and **Copy**, which copies the command, and the session's own actions, such as **Resume**.
The page reads the list again every 5 seconds and after each action you apply there, and moves a claim to **Claims that expired** once its lease passes.
In a tab that cannot make changes the page says so, **Stop**, **Archive**, **Unarchive**, and **Archive all ended** stay unavailable with the tip `This tab can only read.`, and the details offer no action, while **Answer** still opens the question.
With no agent and no launched session it says `No agent works on this workspace, and nothing was launched on this computer.`.

A launched session's state is one of these:

| State | Meaning |
| --- | --- |
| Running | The host is working. |
| Waiting for you | A question or a permission request of the session waits for your answer. |
| Blocked | The host refused an action that the session needed, with a reason such as `Claude Code refused Bash: <the host's reason>`. |
| Ended without a result | The last run ended normally, but it left no question, no pause, and no ship, so Prism asks you what it must do next. |
| Finished | The last run ended by itself with a result: an open question of the initiative, a pause that the run recorded, or a ship of the initiative. |
| Failed | The host reported an error, its process ended with an exit code other than 0 or by a signal, or Prism stopped supervising it, each with its reason. |
| Stopped | You stopped the last run. |

A session whose supervisor ended without recording the run's end shows `Prism stopped supervising this session; its host process may still run.`.

When a run on any host ends normally without a result, Prism adds one question to the initiative on Attention.
The question is `The launched <host> run of <initiative> ended without a result. What should it do next?`, such as `The launched Gemini CLI run of reports ended without a result. What should it do next?`.
Its context shows the run's last message, or says `The run left no message.`.
Prism replaces the host session id in the last message with `<host session id>` and keeps at most 6000 characters of it.
When the same session ends without a result again, the new question replaces the earlier unanswered one.
A launched Claude Code run gets one reminder before its turn ends without a result.
The reminder tells the run that no person reads its reply, and that it must ask through a gate, record a pause, or continue the work.
The run gets no reminder while a background task of the run runs, or directly after an earlier reminder, so the second stop always ends the turn.
Codex and ACP agent runs get no reminder.
This question never makes the session wait for you.

On this computer, Attention lists the question under **Needs you** as one card, on every host: Claude Code, Codex, and any ACP agent by its label.
The list row shows the question as its title, and `Run ended without a result · <initiative> · <host>` under it, such as `Run ended without a result · Export reports · Gemini CLI`.
The card shows the chip `Run ended without a result` and the same place line `<initiative> · <host>` that a [permission request](#permission-requests) card shows.
The card lists **Initiative**, **Host**, **Launched**, and **Ended**, and shows the run's last message under **Last message**, or `The run left no message.`.
Write your answer under **Your answer**, then press **Answer and resume**.
**Archive session** archives the session, closes its question, and starts no run.
The review app shows no transcript of the run, only its last message.
On another computer the question shows as any other assistance question, with **Mark as done**.
When Prism cannot record the question, the session still shows as ended without a result, with the reason `Prism could not record a question for this run: <message>`.

When you answer this question on this computer, Prism resumes the session as for any question that the session asked.
A resumed Claude Code or Codex session receives your answer as its next prompt, and a resumed ACP session gets its launch prompt again, whose orchestrate step reads your answer first.
An answer from another computer starts nothing here, and the session stays ended without a result until you resume it.
When you archive the session, Prism closes its unanswered question and starts no run, and unarchiving the session does not open the question again.
When the session runs again, whether you resume it here or continue a Claude Code or Codex session in a terminal, Prism closes its unanswered question with the reason `The launched session runs again.`.
An answered question stays open for the run to act on.
An ACP session that you continue in a terminal runs no Prism hook, so its question stays until you answer it or archive the session.

### Archive a session

Archive a session that ended so that it stops asking for you: an archived failed session leaves **Needs you**, the agents menu, and the mark on the top bar's **Agents** button.
**Archive** on a finished, failed, stopped, blocked, or ended without a result session's row archives it, and the row leaves its group and every count at once while the toast says `Archived. The Archived filter keeps it.`.
When the session ran again before you pressed it, the row stays and the toast says why, such as `Only a finished, failed, stopped, or blocked session can be archived.`.
**Archive all ended** beside **Show** archives every finished, failed, stopped, blocked, and ended without a result session at once, without asking, and the toast counts them, such as `Archived 3 sessions. The Archived filter keeps them.`.
It shows while the Show choice includes **Needs you** or **Launched from Prism** and one of the sessions it shows can be archived.

**Show** **Archived** lists the archived sessions, each with its state, **Open**, which unfolds its terminal command, **Copy**, and **Resume** as for any launched session, and **Unarchive**, which brings it back to its group with the toast `Unarchived.`.
An archived session that runs or waits for you again leaves the archive by itself, and shows in its group and counts again by the next refresh.
An archived session is removed 14 days after its last run ended, as any other launched session is, and until then keeps its record and its terminal command.
Archiving is kept on this computer only, beside the session's record, so it changes nothing in the project, its records, or its history, and a teammate's page is not affected.

### Stop, resume, or continue a session

**Stop** interrupts the host's turn as the host's own Stop button does, after which the host ends its turn and exits by itself.
An ACP agent receives `session/cancel` while its prompt runs, and Prism closes its input once the prompt answers, or at once before the prompt.
When the host still runs 10 seconds after you stopped it, Prism ends the host process; `PRISM_LAUNCH_STOP_GRACE_MS` sets another wait in milliseconds.
A stop ends only the host process, so a process that the host or its agent started and detached may keep running, as after the host's own Stop button.
**Stop** stays available while a run runs, also after the initiative shipped.

**Resume** starts the same host session again headless, with the dialog unless the launch window is open.
An ACP agent reopens its session with `session/resume`, or with `session/load` when it cannot resume, and Prism sets the recorded mode, model, and effort again and sends the prompt again; an agent that can do neither fails with `<label> cannot resume a session.`.
It is unavailable while the session runs, after the initiative shipped, while another launched session of the initiative runs, while the host's executable is not on `PATH`, and when the host never reported its session id.
To continue a session in a terminal instead, run its command in its folder once no run runs.

When you answer, on this computer, a question that a launched session asked, Prism resumes that session without asking, unless it still runs.
A session that still runs receives the answer itself, and when that run then ends by itself with the question still open, Prism resumes it once; a run you stopped is never resumed for an answer.
An answer that a teammate gives on another computer reaches the records but starts nothing here: the session then says `An answer given on another machine waits; resume this session here to continue.`, and **Resume** continues it.

Each launch, resume, and stop goes into the initiative's history, except a stop after the initiative shipped, which only the session's own record keeps.
Only the review page launches, stops, or resumes a session: no agent tool and no Prism command does.

## Roadmap, initiatives, and slices

The roadmap shows initiatives as a board, a list, or a dependency graph, chosen under **View** in the toolbar above them.
Beside it, **Group by** groups the board and the list by **Band** or by **Status**, and "Show shipped and superseded" adds the archived initiatives.
The review app keeps the chosen view, the grouping, the archive toggle, and the collapsed lanes, so every later roadmap opens the way you left it; a lane link always shows the board grouped by band.
The board stacks one full-width lane per band in priority order, or per status in the order work moves through them, with an empty group on one line.
A card shows its priority rank within its band, or its band when grouped by status, its state, and one bar segment per slice in the slice's status color with the count of done slices.
At its end, a **needs** icon and an **unblocks** icon count the initiatives it depends on and those that depend on it; hovering or focusing one marks those initiatives on the board, dims the others, and names them in its tooltip, and pressing it keeps them marked.
The list shows the same groups with each initiative's dependencies as links under its title.
Click a lane's arrow to collapse it.
Next to the counts at the top, a link names how many open roadmap questions there are and opens Attention showing only them, where they are answered; the Roadmap page itself lists none.
A superseded initiative's page says below its title when it was superseded and by which initiative, linked, and the decision's reason.

An initiative page names its lane and its rank there above its title, such as `Initiative · Now · #1`, and under the title its state and intent.
Its run totals, **Launch**, and **Settings** sit at the end of its head.
A bar shows one segment per leaf slice in its status's color, done first and not started last, with a count such as `0 of 4 done · 2 in progress · 1 blocked`.
Below it a fold, open until you close it, shows the rationale, the initiatives it needs and unblocks by title, its requirements with one chip per file that lists their numbers, and its records.
An initiative page shows its slices as a board, a list, or a graph, and keeps the view you choose as a preference.
The board has one column per slice status, and the card of an active slice also shows its activity, workers, and review lanes.
A slice whose design waits for your answer at its design gate shows as in design review until the agent accepts the design, even though its record still says not started.
The list shows the slice tree, and the graph orders leaf slices by execution order.
A slice that records a [component](workflow.md#components) carries a small label with its `<repository>/<component>` identity in the slice tree, on its board card, and on its slice page, and a slice without one, such as a split scope or a slice accepted before components existed, has no label.
Beside the view choice, a line lists the unstarted leaves that can be designed next, leaving out those in design review, and those that can start once their prerequisites finish.
A slice page shows the slice's design views, its design from `slice.md`, the verification run, the review ledger, its [verified files](#a-slices-files-after-verification), and every file in the slice folder.
It is the page to read at a design gate.
Under its title a tag line names the slice's phase with its gate or status, such as `Design · design gate open`, beside its requirements, and ends with who holds the slice, the activity, and the time left, with the exact times on hover or focus.
The tabs are Design, Views, Verification, Review, Files, and Change map.
The Views tab counts the views, the Review tab the open findings, and the Files tab the slice folder's files.
The Change map tab is last and marked Deprecated, because the Files tab and the verified result replace it; it stays until existing slices no longer need it.
The Verification tab shows the latest verification run, and each frozen test, each failing test, and the run's log open in the side panel.
A frozen test shows the content the design froze: the work tree's file, the copy Prism keeps for a slice that has not started, or, with a note, the changed file when no frozen copy is left.
A failing test opens its frozen test at the line that names it when exactly one frozen test names it, and otherwise stays plain text, so it never opens a test that only shares its name.
Open the log opens the run's output at its end: the whole log, or its last 2 MB when it is larger, on the machine that ran the command, and elsewhere the last 4,000 characters that the run record keeps, with a note naming the machine and where the full log is.
The Review tab holds the slice's review ledger, which the review record's own page shows too.
Its summary line names the current wave and whether it is open or accepted, counts the unresolved findings, those that block shipping until verified, the deferred ones, and open conflicts, and shows each reviewer with the result of their lane.
The wave's run totals end the line, and choosing them shows the full table.
Below, filters show the findings of one reviewer, of the severities you keep pressed, or raised in one wave.
The findings are grouped by status in the order work moves, `OPEN`, `IN PROGRESS`, `REOPENED`, `FIXED`, `VERIFIED`, and `DEFERRED`, each most severe first with its severity's bars, and a line names the statuses that have no findings.
Choosing a finding shows it beside the list, or under it in a narrow window, with where it was raised, its contract clause, its evidence, what closes it, the implementer's evidence, and its history; the ledger opens on the most severe unresolved finding.
A deferred finding is one you accepted with a follow-up at the review loop decision, and its row and details name its decision gate, its follow-up, and the wave that deferred it.
Folds below hold the waves, with their reviewers, what each compared, its findings, its run totals, and a button that filters the list to the findings it raised, then the assessments, any conflicts, the operation history, and the record's details.
On Attention, the review loop decision shows its summary with the findings of each wave as a table.
**Details and settings** at the end of the page bar shows the slice's outcome, slug, parent, children, dependencies, and active work, and the initiative's settings.

The Views tab shows each view that the `## Views` section of the slice's `slice.md` declares, in the declared order, as one card named by the question the view answers.
The line above the question names the view's kind and file, such as `Sequence view · flow.puml`.
The line under it reads `This view explains §1 and §2 of the contract in <contract>; where the view and the contract differ, the contract decides.`
Each `§n` opens the Design tab at that clause and highlights it, or opens the contract's page at that clause when this page does not list it, and the contract opens the design that holds the contract.
A diagram or wireframe view is drawn, with the zoom, source, and Maximize controls of a diagram card, and an API view shows its JSON source, which scrolls after about sixteen lines and has a Copy button.
Open shows the view on its own page.
A scope whose design planned slices shows its own views first, then each planned slice that declares views under the slice's title, with Open slice beside it, and one line names the planned slices that declare no views.
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
On an initiative page the head sums them up, such as `3 h 55 min active · ≈ 19.9M tokens`, and opens the whole table.
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
A graph or diagram larger than its card pans when you drag it with a mouse or pen, and with a finger on a touch screen, while a click on a link or a graph's item still opens it; its text is not selected by the drag, and Show source and Copy give the diagram's text.
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
A link to a document section previews that whole section, up to the next heading of its level, and a link to a document without a section previews the whole document.
A link to a source file previews its first 400 lines, and a link to lines of one previews those lines.
A preview is as wide as a readable column and never wider than the window, sits beside its link without covering it, and scrolls when its content is taller than the room there, fading at its end while more lies below.
The preview follows its link when the page scrolls, and closes once the link leaves the window.
A link to a PlantUML file previews the diagram drawn small enough to fit.
A declared design view opened on its own page, or in the side panel, takes its question as its title with its kind above it, and the same line with its clause links under the title.
A file's preview has a Show in side panel button, and Alt+click on a link does the same: the whole file opens in a panel beside the current page, at the linked heading or lines.
The panel draws a PlantUML file, and the diagrams a document links, as its page does, fitted to the panel's width, with the same zoom and source controls.
The side panel holds one file at a time, so opening another replaces it, and a link inside the panel opens its target in the panel.
Open as tab opens the file in a tab that stays open, Esc or the close button closes the panel, and dragging its left edge sets its width.
Graph, diagram, and document cards can be maximized with their Maximize button, and Esc restores them.
A maximized document keeps its Restore button in view while it scrolls, in its contents header when it has contents.

### Review a file in the record store

In a project whose `.prism/workflow.md` names a record store, a requirement, ADR, plan file, glossary, or roadmap view opens with a Review card above its content.
The card names the file's scope, `workspace`, the repository, or `<repository>/<component>`, and says whether a person accepted the file and whether it changed since.
A file is accepted when a person approves it, when the design of the slices whose folder holds it is accepted, when its initiative ships, or when it moves in from the checkout with a status that a person already moved on, such as `Approved`.
When the file changed since the accepted version, or no version was accepted yet, a line above the file's text says so, and **Show changes** names how many blocks changed.
It marks the changes on the rendered text: an added block has a green bar and fill, a removed block comes back where it stood with a red bar and struck text, and a changed block has an amber bar with the words it gained marked green and the words it lost struck in red.
A file that no version was accepted for shows every block as added.
While the changes show, **Source lines** shows the lines that changed instead, with the line numbers of both versions, and **Rendered** goes back to the rendered text; **Hide changes** shows the file as it is.
The changes stay shown, in the way you chose, while comments arrive and the file changes.
It then lists the comments on the file, oldest first, each with its author's Git name, the host it came from, the line it names, and its time, and marks a comment made on an earlier version of the file.
Comments that a record store sync brings from other machines appear the next time the page checks the file, and comments from this machine's tabs appear at once.
The page checks again when [the records change](#how-the-page-stays-current), and otherwise 5 seconds after its last check ended, never while one still runs, and the review app reads only the comment files that the page lists and those that changed since its last read, so a file with many comments keeps the page responsive.
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
Knowledge's **Scopes** section, below its search field, shows one chip for each scope by its label, `workspace`, the repository, or `<repository>/<component>`, with its count of artifacts, while the store holds more than one scope.
**Browse by kind** counts and lists the artifacts of every scope, and the Jump palette finds each of them.
Each store artifact's page names its scope in a label beside its heading and in its Review card, and shows its place in the store, such as `repositories/api/requirements/billing.md`.
The page names a store artifact by that place, `store:<location>`, in its tabs, links, and address, never by a checkout's path, so one link opens the same file from every checkout and from a workspace with no checkout.
A link or tab that still names a checkout's path opens the store artifact at that path.

The scope chips are the scope filter: select one or more scopes to show only their artifacts in the counts of **Browse by kind**, Knowledge's search, the library pages, and the Jump palette, select a chosen chip again to drop it, and select **All scopes** to show every scope again.
While the filter narrows, the section reads, for example, `Scopes · 2 of 4`, and a library page counts its rows as `2 of 5 requirements files` and says `Narrowed to api and web.` with a **Show all scopes** link that shows every scope again.
The filter stays in the page's address as `scopes=<label>,<label>`, so it survives a reload and a shared link, and it never changes the workspace the page shows.

A relative Markdown link in a store artifact opens the artifact it names, looked for first beside the artifact's place in the store, and then at the path the link names from the file's checkout path, as a checkout of its repository on this machine configures its folders, or as Prism's default folders do without one, in the file's own scope or else the workspace scope.
A link whose path falls outside every artifact folder names a code file of the artifact's repository, or, for a workspace artifact, of the checkout the page reads through.
It opens that file from a checkout of the repository on this machine that offers it for review, in a tab named `code:<repository>:<path>`.
A file that no registered checkout offers opens from the repository's code clone, while its code content is on, at the remote's default branch, the branch that the remote's `HEAD` named at the clone's last fetch; the tab shows that branch's label, and a checkout that offers the file always wins over the clone.
A link to a secret by its file name, such as `.env` or a private key, never opens from the clone.
A checkout never offers a symbolic link whose target is inside a `.git` folder or outside the checkout, so such a file neither lists nor opens from the checkout.
A binary file or a file over 512 KiB still shows as a link, and opening it says that the file is not shown because it is binary or over 512 KiB, rather than that it was moved or deleted.
When no checkout of that repository is registered on this machine and its code clone does not hold the file, the link keeps its text and shows **not available on this machine** beside it, and the page's heading counts such links apart.
A link that names no artifact and no file keeps its text and shows **link not found** beside it, and the page's heading counts such links.
An image, a link inside a fenced code block of backticks or tildes, and a link inside inline code are not links.
The Jump palette lists each store artifact once, names its scope in its row, and finds only the artifacts of the scopes the filter shows.

A store that holds no artifacts yet, because no Prism session moved a checkout's files into it, shows a note in Knowledge's sidebar that names its repositories and says that each keeps its artifacts in its checkouts until a Prism session there moves them into the store.

### Code content

The **Code** page under **Knowledge** shows one repository of the workspace at a time, which the repository menu at the start of its toolbar picks.
Its **Repositories** button opens a dialog that lists each repository with its code content state: **Off**, **On**, or **Unreachable**.
Choose **Turn code content on** there for a repository to have Prism keep a clone of its code on this machine, also when this machine has no checkout of it.
Prism clones the first remote that the store's registration of the repository lists, with the machine's Git configuration and credential helpers and without asking for a password on a terminal, into `code/` of its state directory, one clone per remote.
The clone is bare and blobless: it holds every branch of the remote with its commits and folders, and it fetches a file's contents only when someone opens the file, so it uses little disk.
A repository whose registration lists no remote cannot take code content.
Only a tab that can make changes turns code content on or off; see [Which tabs can make changes](#which-tabs-can-make-changes).
Which repositories have code content on survives a restart of the app.

While a page of the workspace is open, each fetch of the workspace also fetches every repository with code content on, bringing new branches and dropping branches that left the remote.
When a repository's remote cannot be reached, the Repositories dialog shows it as **Unreachable** with Git's reason, and the clone keeps what it fetched last; when the first clone fails, Prism keeps no folder and tries the clone again at the next fetch.
For a repository with code content on, the Code page shows a tree of the files and folders of every branch together, beside the file you open.
**Compare with** names one branch, at first the remote's default branch, and the tree marks each file that another branch adds, changes, or removes against it, such as **New on 1** or **Differs on 2**, and each folder with the number of branches that change something in it; hover a mark to see the branches.
A file or folder that every branch holds the same way carries no mark, and a file only another branch holds still shows in the tree.
**Branch** picks which version of the open file the viewer shows, with line numbers, the branch it is read from, and how it stands against Compare with, such as **New on this branch** or **Differs from main**.
When the branch in Branch lacks the open file, the viewer shows the version of a branch that holds it and says so.
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
**On branches** names the branches that hold that commit, up to five besides the default branch.
When the default branch does not hold it, as for a feature branch not merged yet or a ship commit that a force push took off the default branch, the card says **not on the default branch yet**, unless the commit recorded at ship is on the default branch, as after a squash merge that kept the feature branch.
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
Codex does not name the project when a session starts, so a Codex session opens the review browser at its first Prism tool call.
Starting several sessions at once opens at most one window.
Cloud, CI, print-mode, and display-less sessions open nothing.
Set your [personal setting](workflow.md#personal-settings) `reviewBrowserOnStart` to `off` to turn this off for every project, or set `PRISM_REVIEW_BROWSER_ON_START=off` to turn it off for every process that has the variable, whatever your settings say.
A `reviewBrowser` of `internal` also turns it off, because only the agent can open the internal browser, and a tab there can only read.
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
The log records each process start and stop, index builds with their phases, durations, and failures, review app requests that fail or take more than two seconds, apart from a page's event stream, which stays open while the page does, MCP tool calls that fail, and uncaught errors.
A tool call that Prism refuses with a reason you can act on, such as an invalid argument, is information named `request_refused` with that reason's code, if it has one, not a warning.
Each record store sync that commits, merges, or pushes records is information named `store_synced`, a sync that fails is a warning named `store_sync_failed` with its reason, once until the reason changes, and a sync with nothing to share leaves no line.
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
