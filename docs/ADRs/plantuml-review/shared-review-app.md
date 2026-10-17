# Share one review app across sessions and projects

Status: Proposed
Created: 2026-10-17

## Requirements

- [single-review-app.md§1](../../requirements/single-review-app.md#1)
- [single-review-app.md§2](../../requirements/single-review-app.md#2)
- [single-review-app.md§3](../../requirements/single-review-app.md#3)
- [single-review-app.md§4](../../requirements/single-review-app.md#4)
- [single-review-app.md§5](../../requirements/single-review-app.md#5)
- [single-review-app.md§6](../../requirements/single-review-app.md#6)
- [single-review-app.md§7](../../requirements/single-review-app.md#7)

## Problem

Each MCP server process starts its own review server for each project, on its own port and secret URL.
Several sessions open several browser tabs, and no page shows which project waits on the user.
The review app must become one shared process without weakening the loopback and secret-URL protections of [browser-rendered-plantuml.md](browser-rendered-plantuml.md).

## Decision

At most one review app process MUST run per operating-system user.
The review app MUST run as a detached process that no single agent session owns.
The review app MUST publish its port and credentials in one discovery file in the user's private Prism state directory, readable only by that user.
On systems with POSIX permissions, a Prism process MUST NOT trust a state directory or discovery file that another user owns or that grants group or other permissions.
A process MUST hold the review app lock before it serves as the review app.
The lock MUST count as abandoned when its owner process is gone or its owner has stopped renewing it, and an owner that finds its lock lost MUST stop serving.
Agent sessions and the `prism review` command MUST reach the review app through a control credential that signs each request and response and never travels on the wire.
A Prism process MUST NOT act on a review app response that does not prove knowledge of the control credential.
The control credential MUST NOT appear in any browser URL, and the review app MUST refuse control requests that a browser page sends.
The browser URL MUST carry a separate viewer credential.
The port and viewer credential SHOULD survive a replacement of the review app, so an open tab reconnects; they are renewed after the review app exits for idleness.
Each review app process MUST create its own control credential.
Each project MUST keep its own review context, including its tabs, viewers, and file boundary, behind a stable project segment of the URL.
Only a request with the control credential MAY register a project.
A project MUST stay live while its registering session renews its lease and MUST then appear as recent.
A session MUST register its project when its host names the project at start, and otherwise at its first tool call that names the project.
A presentation for a project MUST NOT change which project a connected browser tab shows.
The review app MUST NOT open a browser itself; the presenting process opens it in its own environment when no tab is connected.
A process that finds an older protocol version MUST replace the running review app, and a process that finds a newer one MUST use it.
A newer protocol version MUST keep every earlier control route and field with its meaning.
When the review app cannot be reached or started, an MCP server MUST serve that project's reviews from its own review server for the rest of the session.
The loopback binding, Host allowlist, and file boundary of [browser-rendered-plantuml.md](browser-rendered-plantuml.md) MUST apply to the shared review app unchanged.

## Rationale

A detached process outlives any one session, so ending the session that started the app does not break the other sessions' tab.
A discovery file in a private directory lets every process of the user find the app without a fixed port that another local process could take first.
Two credentials keep the power to register directories out of browser history, screenshots, and pasted logs.
Gate answers already reach agents through the state file under a cross-process lock, so a separate app process needs no new delivery channel.

## Alternatives

- **The first session hosts the app.** Rejected because the app and every open tab die when that session ends.
- **A fixed well-known port.** Rejected because another local user or process can bind it first and collect gate answers through a look-alike page.
- **One credential for both the browser and agent sessions.** Rejected because a leaked review URL would then let anyone register any directory for serving.
- **Switch the tab to the presenting project.** Rejected because it discards the user's place, including a half-written answer.
- **Wait until the older app is idle before replacing it.** Rejected because the newer session would have no app while it waits.

## Consequences

- One tab shows every project, and the open-gate count shows which project waits on the user.
- One viewer URL now exposes every registered project instead of one, so a leaked URL reveals more than before.
- A detached process can outlive the plugin version that started it until a newer session replaces it.
- A host that forbids detached processes or private state writes falls back to one server per session.
- Hosts that do not name the project at startup, such as Codex today, list the project only after its first Prism tool call.
- A pid alone cannot prove a lock owner alive after a reboot, so a stalled owner that stops renewing for longer than the stale period is replaced and must stop serving when it resumes.

## Mechanism

The [lifecycle diagram](shared-review-app-lifecycle.puml) shows discovery, start, registration, presentation, replacement, and fallback.
A Prism process reads the discovery file and checks the app's health with the control credential.
When no healthy app answers, it starts a detached app and waits a bounded time for the discovery file to name a healthy app.
A starting app takes the lock, reuses the previous port and viewer credential when they are still free, and writes the discovery file.
An app that cannot take the lock exits, so concurrent starts leave one app.
The app renews its lock while it runs and stops serving when a renewal finds the lock taken by another owner.
Each MCP server registers its project and renews the lease while it runs, and each renewal names the project, so a replacement app learns every live project at the next renewal.
The app also remembers registered projects across restarts, so an open tab's project URL keeps working.
The app serves each registered project's existing review routes under that project's segment.
A replacement shutdown keeps the discovery file for the successor, and session snapshots name the app instance, so a reconnected tab accepts the new instance's state.
The app exits after an idle period with no live lease and no viewer, and removes the discovery file.

## Decision Log

- n/a.
