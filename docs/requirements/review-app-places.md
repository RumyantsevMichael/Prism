# Review app places

Status: Approved
Created: 2026-11-09
Approved: 2026-11-09

## Problem

The review app's sidebar mixes the initiatives being worked on with the library of requirements, decisions, and the glossary, in the order Prism stores them rather than around what the person came to do.
In a large project the sidebar grows to hundreds of rows, and a list of every requirement and decision helps nobody find the few that matter to the work in hand.
The people who use the app wear different hats: an engineer looks for work in flight, what waits on them, and the records behind a contract; a tech lead looks at design gates, contracts, and how decisions fit together; a product owner looks at requirements and roadmap priority.
Michael decided on 9 November 2026 that roles stay hats, not accounts, that the engineer and tech lead come first, and that navigation becomes a few places switched by an icon rail at the far left, as in an IDE, with the sidebar showing only the current place.
He approved the mockup `proposal-5-places.html` with its screens of Work, Attention, and Knowledge the same day, with no border on the rail.
The review app UI kit kept navigation unchanged as one of its non-goals, so this capability changes navigation on purpose and on its own.

## Goals

- Let the person switch between Attention, Work, Roadmap, Knowledge, and History from an icon rail, with the sidebar showing only the current place.
- Keep the sidebar short in a large project by showing designed, unshipped work in Work, shipped work in History, and entry points instead of flat lists in Knowledge.
- Let the person narrow Attention by kind of item and by piece of work.
- Lead from the work the person has open to the requirements, decisions, glossary terms, and diagrams behind it.
- Keep every feature and every page the review app offers today.
- Make the screens match the approved mockup, checked by comparing rendered screens with it.

## Non-goals

- Role-based interfaces, accounts, or a choice of role.
- Knowledge by area, which needs records to carry an area or component.
- Records that apply to the code a slice changes, which needs computed connections between code and records.
- Records waiting for approval and proposed record changes on Attention, which need workspace artifacts in the shared store.
- Asks routed to the person and an Intake place, which need an intake of stakeholder asks.
- Sessions that need input and a list of running sessions, which need Prism to track agent sessions.
- A Mine filter and pinned work, which need the review app to know which person is viewing.
- A dashboard across workspaces for executives and release managers.
- Changes to the Roadmap page's board, list, and graph.

## Design questions

- Which history tells when a record last changed: the repository's Git history, the shared store's history, or both, and whether a change not yet committed counts.
- In which order Work lists the up to four other unfinished slices of the open initiative.
- Whether the Knowledge search reuses the Jump palette's search restricted to records, or has its own results list.
- Michael decided on 9 November 2026 that the design adds the approved mockup to the repository under `docs/plans/review-app-places/mockup/`, with the parts that are later work and the `/` hints of its filter fields removed, that he approves that copy at the design gate, and that the mockup comparison runs against it.
- The Accepted decision `docs/ADRs/review-ui-kit/own-ui-kit.md` says navigation has one sidebar that becomes a drawer and no strip of open tabs; the open-document tabs already returned, and the places add a rail, so design revises that clause through a superseding decision.

<a id="1"></a>
## 1. Switch places from a rail

Pattern: State-driven

Disposition: Active

Requirement: While the window is wider than 1100 pixels, the review app shall show at the left edge of every page a rail with one entry each for Attention, Work, Roadmap, Knowledge, and History, mark the current place, and name each entry on hover and on keyboard focus.

Rationale: Michael chose an IDE-like rail of places so the person switches what they look at instead of scrolling one long sidebar.

Related: [review-app-places.md§2](#2)

<a id="2"></a>
## 2. Show only the current place in the sidebar

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses a place on the rail, the review app shall show that place's own navigation in the sidebar and no entry of another place.

Rationale: A sidebar that holds one place stays short however large the project grows.

Related: [review-app-places.md§1](#1)

<a id="3"></a>
## 3. Keep the place when the page changes

Pattern: Event-driven

Disposition: Active

Requirement: When the person selects a tab or follows a link to a page that belongs to another place, the review app shall keep the sidebar on the place the person chose and mark the page in the sidebar only when that place lists it.

Rationale: The sidebar changes only when the person asks for it, as in an IDE, so following a question's link from Attention does not take Attention away.

Related: [review-app-places.md§2](#2), [review-app-places.md§9](#9)

<a id="4"></a>
## 4. Remember the current place

Pattern: Event-driven

Disposition: Active

Requirement: When the page reloads or the person opens the review app again in the same browser, the review app shall show the place that browser showed last, and Attention when it showed none before.

Rationale: The person returns to the place they work in, and Attention is where the app opens today.

Related: [review-app-places.md§1](#1)

<a id="5"></a>
## 5. Carry the Attention count on the rail

Pattern: State-driven

Disposition: Active

Requirement: While the rail is shown, the review app shall show on its Attention entry the number of recorded questions that wait for the person, the same number the tab title shows, and show no Attention bell in the top bar.

Rationale: The rail already holds Attention, so a second bell in the top bar repeats it, and Michael's approved mockup removes the bell.

Related: [review-app-places.md§1](#1), [review-app-places.md§24](#24)

<a id="6"></a>
## 6. Collapse the sidebar to the rail

Pattern: Event-driven

Disposition: Active

Requirement: When the person presses `[` or chooses the sidebar button while the window is wider than 1100 pixels, the review app shall hide the sidebar and keep the rail, or show the sidebar again if it was hidden, and keep that choice when the page reloads.

Rationale: The collapse with `[` and the sidebar button exists today and must survive the change to places.

Related: [review-app-places.md§7](#7)

<a id="7"></a>
## 7. Open a place from the collapsed rail

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses a place on the rail while the sidebar is hidden, the review app shall show the sidebar with that place.

Rationale: Choosing a place is a request to see it, so a hidden sidebar must not swallow the choice.

Related: [review-app-places.md§6](#6)

<a id="8"></a>
## 8. Keep navigation entries as links

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall make every sidebar entry that leads to a page or a filtered list a link to its own address, so that a middle click or a Shift click opens it in a new browser tab or window, a Ctrl click or Cmd click opens it in a tab that stays open, a double click keeps the tab it opened, and the browser's context menu can copy its address.

Rationale: These link behaviors exist on every sidebar row today, and Michael counts their loss as a lost feature.

Related: [review-app-places.md§23](#23)

<a id="9"></a>
## 9. Name the place in the page bar

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall start the page bar's trail of every page that belongs to a place with that place's name as a link that shows the place in the sidebar.

Rationale: The trail tells the person where a page lives once the sidebar no longer follows the page, and gives one click back to that place.

Related: [review-app-places.md§3](#3)

<a id="10"></a>
## 10. Filter Attention by kind

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall list in the Attention sidebar an entry for everything that waits on the person and one entry for each kind of item Attention shows, such as questions, review findings, failed verifications, blocked work, work ready to ship, and record or setting problems, each with its count of items.

Rationale: A person who answers questions first, or checks findings first, needs to reach that kind without reading the whole list.

Related: [review-app-places.md§11](#11), [review-app-places.md§14](#14)

<a id="11"></a>
## 11. Show only the chosen kind or work

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses a kind or a piece of work in the Attention sidebar, the review app shall show on the Attention page only the items of that kind or that piece of work, name the filter and its count above them, and offer a way back to everything.

Rationale: A filter is only useful if the page says what it shows and how to undo it.

Related: [review-app-places.md§10](#10), [review-app-places.md§12](#12)

<a id="12"></a>
## 12. Filter Attention by piece of work

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall list in the Attention sidebar each initiative that has items on Attention, by title with its count of items, the three with the most items first, and gather the others in one row that names how many more initiatives there are and shows them when chosen.

Rationale: An engineer or tech lead works on a few initiatives at once and wants what waits on one of them.

Related: [review-app-places.md§11](#11)

<a id="13"></a>
## 13. Show recently answered questions

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses the answered entry in the Attention sidebar, the review app shall list the questions answered or closed in the last 7 days that Prism still keeps, newest first, each with its answer or the reason it was closed.

Rationale: The person checks what they decided this week, and Attention keeps only the 20 newest closed questions today.

Related: [review-app-places.md§10](#10)

<a id="14"></a>
## 14. Show failed verifications on Attention

Pattern: State-driven

Disposition: Active

Requirement: While the latest verification run of an unfinished slice has failed, the review app shall list that slice on Attention as a failed verification with the run's reason and time, until a later run of the slice passes.

Rationale: Prism records every verification run, but today a failed run shows only on its slice page, so nobody sees it unless they open that page.

Related: [review-app-places.md§10](#10)

<a id="15"></a>
## 15. List only designed, unshipped work in Work

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall list in the Work sidebar every initiative that has an initiative record and has not shipped or been superseded, grouped under In progress, Blocked, Designed but not started, and Not on the roadmap, each group with its count, and no shipped, superseded, or envisioned initiative.

Rationale: Work is where the engineer and tech lead find work in flight; shipped work belongs to History, and envisioned work without a design stays on the Roadmap.

Related: [review-app-places.md§16](#16), [review-app-places.md§21](#21)

<a id="16"></a>
## 16. Treat stalled work as blocked

Pattern: State-driven

Disposition: Active

Requirement: While an initiative has at least one blocked slice and no slice that is in progress or claimed, the review app shall list it under Blocked in the Work sidebar instead of under In progress.

Rationale: An initiative whose only movement is a blocked slice needs someone to unblock it, while one that still moves elsewhere is in progress with a blocked slice marked in its tree.

Related: [review-app-places.md§15](#15)

<a id="17"></a>
## 17. Keep each work row's facts

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show on each initiative row of the Work sidebar its state, its title, and its shipped leaf slices out of all, and on each slice row the color of its phase, its holder, and a mark when it is blocked, with the full title, status, phase, and claim on hover and on keyboard focus.

Rationale: The sidebar shows these facts today, and Michael's approved mockup keeps them.

Related: [review-app-ui-kit.md§14](review-app-ui-kit.md#14)

<a id="18"></a>
## 18. Show a short slice list for the open initiative

Pattern: State-driven

Disposition: Active

Requirement: While an initiative listed in Work is expanded, the review app shall show below it at most five of its unfinished slices, starting with the slice open in the selected tab when it belongs to that initiative, followed by one row that names how many more unfinished slices and how many done slices it has and opens the initiative's slice list.

Rationale: A large initiative's full slice tree is as long as today's sidebar, while the current slice and a few next ones are what the person acts on.

Related: [review-app-places.md§15](#15)

<a id="19"></a>
## 19. Filter the Work sidebar

Pattern: Event-driven

Disposition: Active

Requirement: When the person types in the Work sidebar's filter field, the review app shall show only the initiatives and slices whose title contains the typed text, with each matching slice under its initiative.

Rationale: The engineer often knows a word of the work's title and wants it without scanning the groups.

Related: [review-app-places.md§15](#15)

<a id="20"></a>
## 20. Open the Roadmap from its place

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses Roadmap on the rail, the review app shall open the Roadmap page with its board, list, and graph as they are today.

Rationale: Michael chose to keep the Roadmap board as it is, and the product owner's priority work happens there.

Related: [review-app-places.md§1](#1), [review-app-places.md§37](#37)

<a id="21"></a>
## 21. List shipped work in History

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall list in the History sidebar every shipped or superseded initiative by title with the date it shipped or was superseded, the most recent first, mark each superseded one as superseded, and lead from each to its initiative page.

Rationale: Shipped and superseded work leaves Work, so History keeps it one click away for whoever needs to trace what was built or replaced, as Michael decided on 9 November 2026.

Related: [review-app-places.md§15](#15)

<a id="22"></a>
## 22. Offer entry points in Knowledge

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show in the Knowledge sidebar a search field, the entry points Touched by my work and Changed this week, and the lists Requirements, Decisions, Glossary, and Diagrams, each list with its count, and no entry for each single record.

Rationale: Michael found that a list of every decision and requirement helps nobody, while a search and a few ways in lead to the records that matter.

Related: [review-app-places.md§23](#23), [review-app-places.md§25](#25), [review-app-places.md§29](#29), [review-app-places.md§31](#31)

<a id="23"></a>
## 23. Keep every page reachable

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall let the person reach, without the Jump palette, every page it serves today, including Attention, the Roadmap, every initiative and slice page, every requirement and decision document, the Requirements and Decisions lists, the Glossary, every diagram, and the component catalog, from the rail, a place's sidebar, or a page those lead to.

Rationale: The 0.20.0 release dropped features, and Michael requires that a navigation change loses no page.

Related: [review-app-places.md§8](#8)

<a id="24"></a>
## 24. Keep the shell's other features

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall keep working as it does today the open-document tabs with the preview tab, Keep, close, middle-click close, agent-presented tabs, and tabs restored after a reload, the page bar's Back and Forward, the Jump palette opened with Ctrl K, Cmd K, or `/`, Appearance opened with Ctrl+,, Who's working, and the status bar.

Rationale: The places change only the sidebar, so every other part of the shell must behave exactly as before, and Michael decided on 9 November 2026 that `/` keeps opening the Jump palette rather than focusing a place's filter.

Related: [review-app-places.md§23](#23)

<a id="25"></a>
## 25. Search records from Knowledge

Pattern: Event-driven

Disposition: Active

Requirement: When the person types in the Knowledge search field, the review app shall list the requirements, decisions, glossary terms, and diagrams whose title or text matches, grouped by kind and named by title, and open the chosen one.

Rationale: Search comes first in Knowledge because the person usually knows a word of what they look for.

Related: [review-app-places.md§22](#22)

<a id="26"></a>
## 26. Show the records a slice's contract cites

Pattern: State-driven

Disposition: Active

Requirement: While a slice is open in the selected tab, or was the last slice the person selected, the review app shall list on the Touched by my work page, under the reason that the contract cites them, the requirement sections the slice cites, the decisions, requirements, and diagrams its design links to, and the glossary terms its contract clauses name, each with the clauses or sections that cite it.

Rationale: An engineer tracing a contract clause to its requirement or decision needs those records in one place, and the slice's record and design already name them.

Related: [review-app-places.md§27](#27), [review-app-places.md§28](#28)

<a id="27"></a>
## 27. Show the records a slice changes

Pattern: State-driven

Disposition: Active

Requirement: While a slice is open in the selected tab, or was the last slice the person selected, the review app shall list on the Touched by my work page, under the reason that this work changes them, the requirements, decisions, glossary, and diagrams that the slice's design plans to change or that its verified result changed.

Rationale: A tech lead checks which records a piece of work rewrites before accepting it, and the design's Changes and the verified change map already name those files.

Related: [review-app-places.md§26](#26)

<a id="28"></a>
## 28. Name each touched record by title, kind, and status

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show each record on the Touched by my work page with its title, kind, status, and why it is listed, as a link to the record, and name above the list the initiative and slice it covers.

Rationale: The person must see which work the page speaks for and why each record is there, without a file path.

Related: [review-app-ui-kit.md§15](review-app-ui-kit.md#15)

<a id="29"></a>
## 29. Explain an empty Touched by my work page

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the person has no slice open and has selected none since the page loaded, then the review app shall say on the Touched by my work page that it lists the records behind an open slice, and list the slices in progress as links to open one.

Rationale: An empty page with no way forward is a dead end, while the slices in progress are the likely work to look at.

Related: [review-app-places.md§26](#26)

<a id="30"></a>
## 30. List records changed this week

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses Changed this week, the review app shall list the requirements, decisions, glossary, and diagrams whose content changed in the last 7 days, newest change first, each by title and kind with the time of its last change and its author when the history records one.

Rationale: A tech lead asks what changed since they last looked, and the record files carry a history of changes.

Related: [review-app-places.md§31](#31)

<a id="31"></a>
## 31. Say when change history is unavailable

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the history that tells when a record changed cannot be read, then the review app shall say on the Changed this week page which records it could not date and why, and list none of them as changed.

Rationale: A guess from file times would show records as changed that were only checked out, so the page states the gap instead.

Related: [review-app-places.md§30](#30)

<a id="32"></a>
## 32. List diagrams by name

Pattern: Event-driven

Disposition: Active

Requirement: When the person chooses Diagrams in Knowledge, the review app shall list every PlantUML diagram among Prism's records by its name, with the initiative and slice or the decision it belongs to, each opening the diagram.

Rationale: Diagrams live in slice and decision folders today and are reached only through their owner, so Browse by kind needs a list of them.

Related: [review-app-places.md§22](#22)

<a id="33"></a>
## 33. Show no entry for later work

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show in the rail and the sidebars only entries that lead to a working page or filter, and no entry, count, or label for a place, filter, or entry point that Prism does not provide.

Rationale: Michael wants later work designed as its own work, not shown as a stub or a disabled control.

Related: [review-app-places.md§34](#34)

<a id="34"></a>
## 34. Match the approved mockup

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a rendered screen of Work, Attention, or Knowledge at a window width of 1440 pixels in the light or dark theme differs from the approved mockup in layout, order, wording, or controls, apart from the parts that are later work, then Prism's mockup comparison shall fail and name the screen, the theme, and the difference.

Rationale: The UI kit shipped screens that did not match their mockup, so Michael treats the mockup as a check that compares rendered screens side by side, not as a visual reference.

Related: [review-app-places.md§33](#33)

<a id="35"></a>
## 35. Keep Prism's internal words out of the places

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show in the rail, the sidebars, and the new pages of the places no internal word of Prism's records, such as "concept", and no name of Prism's state files.

Rationale: The person reviews work, not Prism's storage, and these words mean nothing to them.

Related: [review-app-ui-kit.md§15](review-app-ui-kit.md#15)

<a id="36"></a>
## 36. Open the places from the navigation drawer

Pattern: State-driven

Disposition: Active

Requirement: While the window is 1100 pixels wide or narrower, the review app shall show the places' rail and the current place's sidebar together in the navigation drawer that the Navigation button opens, close the drawer when the person chooses a page, and keep the Attention bell with its count in the top bar.

Rationale: Phones and tablets use the drawer today, and Michael decided on 9 November 2026 that the bell keeps its count there because the rail is hidden while the drawer is closed.

Related: [review-app-places.md§1](#1), [review-app-places.md§5](#5)

<a id="37"></a>
## 37. Show the Roadmap's views in its sidebar

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall show in the Roadmap sidebar the choices Board, List, and Graph, which switch the Roadmap page's view, and one link to each of the Now, Next, Later, and Parked lanes, and no entry for a single initiative.

Rationale: Michael decided on 9 November 2026 that the Roadmap place's sidebar offers the page's views and lanes, while the board itself shows the initiatives.

Related: [review-app-places.md§20](#20)
