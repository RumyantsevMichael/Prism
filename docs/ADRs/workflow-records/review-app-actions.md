# Change Prism records from the review app through one action registry and a per-tab write session

Status: Proposed
Created: 2026-11-05

## Requirements

- [review-app-actions.md§1](../../requirements/review-app-actions.md#1) to [§14](../../requirements/review-app-actions.md#14)
- [initiative-settings.md§1](../../requirements/initiative-settings.md#1) to [§9](../../requirements/initiative-settings.md#9)

## Problem

The review app wrote Prism records through one endpoint per kind of change, gate answers and the index rebuild, each with its own checks, and every further change would have added another endpoint and its own page code.
The only credential for those writes was the secret in the review URL, which agents receive from Prism's tools and which the shared app keeps in its discovery file, so an agent could answer its own gate or change what agents may do.
A change made in the page reached a running agent only when skill prose told the agent to look for it.
The review app is also moving toward a desktop shell that would reach the same behavior without HTTP.

## Decision

Every change that the review app makes to Prism records MUST be an action applied through one action registry.
An action MUST be declared once, with its target kinds, its inputs as choices, toggles, or short text, its availability rule with a reason, when it takes effect, whether it needs the person's confirmation, the record it changes, and how it changes it, so that listing, applying, and rendering need no code specific to the action.
The registry MUST NOT depend on HTTP or any other transport, and each transport MUST only translate requests, refusals, and its credential.
Applying an action MUST check, in order, the credential, the target, the action, the revision of the record it changes, availability, the input, and confirmation, and a refusal MUST change no record.
An action MUST change only Prism records and MUST NOT run commands, change project files, or run Git, except that the index rebuild starts Prism's own indexer.
Each applied action MUST be recorded in the target initiative's history, in the same locked write as the change, or in the project history when the target has no initiative, and MUST be announced to every connected tab of the project.
A setting the person changed MUST keep the person's value over any agent write, until the person changes it again.
Writes MUST require a write session that Prism issues only to a tab it opened itself: the opened URL carries a one-time, short-lived grant in its fragment, the page exchanges it for a write session token kept in that tab's session storage, and every write names that token.
A grant or a write session token MUST NOT appear in any tool result, review URL, discovery file, or other file that Prism writes, and a server MUST keep only digests of the tokens it issued.
The shared app MUST accept earlier write sessions only after a handoff in which it also reuses the viewer credential.
A tab without a write session MUST stay readable and MUST say how to get a tab that can write.
Each agent session MUST be told, in its next Prism result about the initiative, of every action applied since that session was last told, and only once; a gate wait MUST end when the person applies an action to its initiative.

## Rationale

One registry gives every change the same stale-value check, authority, and history, and a later action, such as a request to an agent or a comment on a document, joins by declaring itself.
A transport-free registry lets a desktop shell serve the same actions over its own channel and list them in a command palette.
A grant in the fragment never reaches the server's request line, the referrer, or a tool result, and session storage binds the write session to one tab, so a tab opened from a URL that an agent handed over stays read-only, which the product owner chose.
Keeping only digests means no file Prism writes can be turned into a write credential, while a handoff still keeps an open tab writable.
Telling each session of the person's changes in Prism's own results makes the notice independent of whether an agent follows skill prose.

## Alternatives

- **An HttpOnly, SameSite=Strict cookie as the write credential.** Rejected because a browser shares a cookie with every tab of the same origin, so a tab opened from an agent's URL in that browser could write, against the read-only decision.
- **Keep one endpoint per change.** Rejected because each new change would need its own route, checks, history, and page code.
- **Keep the URL secret as the only credential.** Rejected because agents receive that URL, so an agent could answer its own gate or turn push on.
- **Tell agents of changes only through skill instructions.** Rejected because an agent that skips the instruction keeps working under the old setting.

## Consequences

- Agents keep a URL that reads and presents, and only the person's own tab can answer gates or change settings.
- A tab that an agent opens in its own browser, such as an internal browser pane, is read-only, so the person answers there in the conversation or opens a writable tab through Prism.
- A process with the user's full file and process access, such as an agent that reads the private app directory or drives the person's browser, can still act as the person; the product owner accepted this limit, which only a separate desktop process could close.
- A cold restart of the shared app ends every write session, so a tab needs a new one from Prism.
- Browser changes now also change the history in the coordination state, so an agent's next state write may need one more re-read.
- Where a host gives child agents the session identity of their orchestrator, a child may receive a notice first, so the orchestrator also reads the current settings whenever it claims a scope or starts a slice.

## Mechanism

The registry holds one definition per action and offers two operations: list the actions of a target with their current values, and apply one action to a target.
The review server and the shared app expose those operations as two routes under each project's page, and a desktop shell would expose them over its own channel.
When Prism opens a browser, for a presentation, a session start, or the person's review command, it asks its server or the shared app for a grant and adds it to the fragment of the URL it opens; the tool result returns the URL without it.
The page exchanges the grant once for a token, keeps the token in its tab, sends it with each write and with its event stream, and Prism counts only tabs with a token when it decides whether to open a browser.
Each applied action appends a history entry beside the change, and the server sends it to every tab of the project as an event.
Prism keeps, per agent session in the private plugin data folder, the newest history entry it has shown that session, and adds newer entries to the session's next successful result that names the initiative.

## Decision Log
