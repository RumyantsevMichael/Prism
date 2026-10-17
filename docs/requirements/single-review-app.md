# Single review app

Status: Approved
Created: 2026-10-17
Approved: 2026-10-17

## Problem

Every agent session starts its own review server for each project, on its own port and secret URL.
Several sessions open several browser tabs, `prism review` starts yet another server, and the user has no single place that shows which project is waiting on them.

## Goals

- Run one review app per operating-system user, shared by every agent session and project that uses Prism.
- Show every project where an agent uses Prism in one project switcher, with the number of open user gates for each project.
- Keep a review working when the shared app cannot start.

## Non-goals

- Serve the review app to another machine or another operating-system user.
- Change how gate answers are stored or delivered to agents.
- Switch the browser to another project without the user's action.

## Design questions

- n/a.

<a id="1"></a>
## 1. Share one review app

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall run as at most one process per operating-system user, shared by every agent session and `prism review` command of that user.

Rationale: One app gives the user one browser tab and one place to answer every project.

Related: [single-review-app.md§2](#2), [single-review-app.md§6](#6)

<a id="2"></a>
## 2. Register projects at session start

Pattern: Event-driven

Disposition: Active

Requirement: When a Prism MCP server learns its project, from its host at start or otherwise from its first tool call that names the project, the review app shall list that project in its project switcher while that server runs.

Rationale: The user sees every project where agents use Prism before any agent presents a review.
A host such as Codex names no project at start, so its sessions are listed from their first Prism tool call.

Related: [single-review-app.md§3](#3)

<a id="3"></a>
## 3. Switch project context

Pattern: Ubiquitous

Disposition: Active

Requirement: The review app shall provide a project switcher that lists live and recently used projects with the number of open user gates in each, and opens the selected project's review context.

Rationale: The open-gate count shows which project waits on the user without visiting each project.

Related: [single-review-app.md§4](#4)

<a id="4"></a>
## 4. Notify about another project's review

Pattern: Event-driven

Disposition: Active

Requirement: When an agent presents a review for a project other than the one a connected browser tab shows, the review app shall notify that tab with a link to the presenting project and shall not change the tab's project.

Rationale: Switching silently would discard the user's place, including a half-written gate answer.

Related: [single-review-app.md§3](#3)

<a id="5"></a>
## 5. Keep the control credential out of the browser

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a request to register a project or present a review lacks the control credential that only the user's Prism processes can read, then the review app shall reject it.

Rationale: The browser URL credential then cannot make the app serve a directory that no Prism session registered.

Related: [single-review-app.md§1](#1)

<a id="6"></a>
## 6. Fall back to a session server

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the shared review app cannot be reached or started, then the Prism MCP server shall serve its reviews from its own review server as before.

Rationale: Sandboxed hosts and read-only state directories keep a working review instead of an error.

Related: [single-review-app.md§1](#1)

<a id="7"></a>
## 7. Replace an older review app

Pattern: Event-driven

Disposition: Active

Requirement: When a Prism process finds a running review app with an older protocol version, the review app shall be replaced by the newer version on the same port.

Rationale: A plugin update must not leave an older app serving views that cannot read newer records, and an open tab reconnects on the same port.

Related: [single-review-app.md§1](#1)
