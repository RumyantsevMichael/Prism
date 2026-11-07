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
Records can live in one store that several people, machines, and repositories share and that syncs through Git, while each checkout keeps its own index, so a change made on one machine meets agents' writes made on another within one sync window.

## Decision

Every change that the review app makes to Prism records MUST be an action applied through one action registry.
An action MUST be declared once, with its target kinds, its inputs as choices, toggles, or short text, its availability rule with a reason, when it takes effect, whether it needs the person's confirmation, the record it changes, and how it changes it, so that listing, applying, and rendering need no code specific to the action.
The registry MUST NOT depend on HTTP or any other transport, and each transport MUST only translate requests, refusals, and its credential.
Applying an action MUST check, in order, the credential, the target, the action, the revision of the record it changes, availability, the input, and confirmation, and a refusal MUST change no record.
An action MUST change only Prism records and MUST NOT run commands, change project files, or run Git, except that the index rebuild starts Prism's own indexer.
Each applied action MUST be recorded in the target initiative's history in the same locked write as the change, and an index rebuild MUST be recorded in the history of the checkout whose index it rebuilds, which stays on that machine and never enters a shared store.
Each history entry MUST carry an id that is unique across machines and the author that the applying checkout's Git configuration names with that checkout's label, recorded as a claim and never shown as verified, and a history MUST be ordered by time and then id, never by a counter.
An applied action MUST be announced to every connected tab of each checkout that shares the changed records, and an index action only to the tabs of its own checkout.
An index target MUST name a component of the checkout whose page lists it, as `<repository>/<component>`.
A coordination state changed on two machines MUST merge by its structure: settings with their person marks per setting, where the person's later change wins, pending gates and active work per id, where the earlier answer to one gate wins, history and closed gates as the union of both sides by id, and every other field by the three-way unit rule, so that only a genuine clash leaves a saved conflict.
A setting the person changed MUST keep the person's value over any agent write, until the person changes it again.
Writes MUST require a write session that Prism issues only to a tab it opened itself: the opened URL carries a one-time, short-lived grant in its fragment, the page exchanges it for a write session token kept in that tab's session storage, and every write names that token.
A grant or a write session token MUST NOT appear in any tool result, review URL, discovery file, or other file that Prism writes, and a server MUST keep only digests of the tokens it issued.
The shared app MUST accept earlier write sessions only after a handoff in which it also reuses the viewer credential.
A tab without a write session MUST stay readable and MUST say how to get a tab that can write.
Each agent session MUST be told, in its next Prism result about the initiative, of every history entry whose id it has not been shown, with the entry's author, and only once, whichever machine applied it; a gate wait MUST end when such an entry reaches its initiative.

## Rationale

One registry gives every change the same stale-value check, authority, and history, and a later action, such as a request to an agent or a comment on a document, joins by declaring itself.
A transport-free registry lets a desktop shell serve the same actions over its own channel and list them in a command palette.
A grant in the fragment never reaches the server's request line, the referrer, or a tool result, and session storage binds the write session to one tab, so a tab opened from a URL that an agent handed over stays read-only, which the product owner chose.
Keeping only digests means no file Prism writes can be turned into a write credential, while a handoff still keeps an open tab writable.
Telling each session of the person's changes in Prism's own results makes the notice independent of whether an agent follows skill prose.
A counter or position collides when two machines append to one history, and a newest-entry cursor skips an entry that a sync brings with an older time, so entries carry random ids, histories order by time and then id, and sessions remember the ids they were shown.
Git's line merge conflicts whenever two machines append to one history, so without a structural merge every concurrent person and agent change of one initiative would leave one side as a saved conflict.
An index is built from one checkout's files on one machine, so its rebuilds mean nothing to another checkout and stay beside the machine's own checkout list rather than in the shared store.
A Git identity is what Prism can name without accounts, and it is a claim because anyone who can write the store can write any author.

## Alternatives

- **An HttpOnly, SameSite=Strict cookie as the write credential.** Rejected because a browser shares a cookie with every tab of the same origin, so a tab opened from an agent's URL in that browser could write, against the read-only decision.
- **Keep one endpoint per change.** Rejected because each new change would need its own route, checks, history, and page code.
- **Keep the URL secret as the only credential.** Rejected because agents receive that URL, so an agent could answer its own gate or turn push on.
- **Tell agents of changes only through skill instructions.** Rejected because an agent that skips the instruction keeps working under the old setting.
- **A per-history sequence number for ordering and notices.** Rejected because two machines assign the same number to different entries, and a merge would have to renumber entries that sessions already saw.
- **Keep index rebuilds in a project history in the shared store.** Rejected because one store holds several repositories and checkouts, each with its own index, and another machine's rebuild would show as this checkout's.
- **Resolve every concurrent state change by keeping the upstream version.** Rejected because the person's change or the agent's write would be lost on every overlap within the sync window, and a saved conflict needs someone to notice it.

## Consequences

- Agents keep a URL that reads and presents, and only the person's own tab can answer gates or change settings.
- A tab that an agent opens in its own browser, such as an internal browser pane, is read-only, so the person answers there in the conversation or opens a writable tab through Prism.
- A process with the user's full file and process access, such as an agent that reads the private app directory or drives the person's browser, can still act as the person; the product owner accepted this limit, which only a separate desktop process could close.
- A cold restart of the shared app ends every write session, so a tab needs a new one from Prism.
- Browser changes now also change the history in the coordination state, so an agent's next state write may need one more re-read.
- Where a host gives child agents the session identity of their orchestrator, a child may receive a notice first, so the orchestrator also reads the current settings whenever it claims a scope or starts a slice.
- A change made on another machine reaches agents and tabs only after the store syncs, and tabs see it when Attention next loads, not as an event.
- History order follows each machine's clock, so a machine with a wrong clock places its entries out of real-time order, while notices and waits, which follow ids, still show every entry once.
- A history entry's author can be wrong or forged by anyone who can write the store, so it informs people and is never used to decide authority.

## Mechanism

The registry holds one definition per action and offers two operations: list the actions of a target with their current values, and apply one action to a target.
The review server and the shared app expose those operations as two routes under each project's page, and a desktop shell would expose them over its own channel.
When Prism opens a browser, for a presentation, a session start, or the person's review command, it asks its server or the shared app for a grant and adds it to the fragment of the URL it opens; the tool result returns the URL without it.
The page exchanges the grant once for a token, keeps the token in its tab, sends it with each write and with its event stream, and Prism counts only tabs with a token when it decides whether to open a browser.
In the shared app the grant comes with the `present` answer that tells the presenting process to open a browser, one store of write sessions serves every checkout's page, and the app saves the digests of its newest 100 tokens in a file of its private directory, which only a successor that reuses the viewer credential reads.
Each applied action inserts a history entry beside the change, and the server or app sends it as an event to every tab of each checkout's page whose records resolve to the same store, or only the applying checkout's tabs for an index rebuild.
An index rebuild's entry goes to a file of the checkout in Prism's application folder, beside the machine's checkout list.
An index rebuild prepares only its own component's index, and reuses that index without a build while it is up to date.
Store sync merges a coordination state that changed on both sides through the record merge registry, as it merges the roadmap and initiative records.
Prism keeps, per agent session and initiative in the private plugin data folder, the ids of the history entries it has shown that session, and adds every other entry to the session's next successful result that names the initiative.

## Decision Log
