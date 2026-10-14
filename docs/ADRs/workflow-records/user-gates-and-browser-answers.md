# Record user gates and accept answers from the review browser

Status: Proposed
Created: 2026-10-14

## Requirements

No Approved requirement governs this decision yet.
It records the direction taken with the entity-first review browser and the [managed roadmap and initiative records](managed-roadmap-and-initiative-records.md).

## Problem

Orchestration pauses at user gates, such as visual review, correctness confirmation, and decisions, but those questions existed only in the conversation.
Nothing machine-readable said that work was waiting on the user, so the review browser could not show what needed the user.
A user who reviews artifacts in the browser still had to switch to the conversation to answer.
After asking, the agent ends its turn and stays idle, so an answer given anywhere but the conversation does not reach it by itself.

## Decision

Every question that waits on the user MUST be recorded as a typed user gate in the initiative's coordination state before it is asked, and resolved after the agent acts on the answer.
A gate MUST carry its kind, the slice when one applies, the question, the artifacts to inspect, and optional choices for decisions.
Only the review browser MAY record an answer on a gate, and agent writes MUST NOT add or change an answer.
A gate MUST accept one answer, and an answer to a resolved or withdrawn gate MUST be refused.
A recorded answer MUST reach the agent with the user's next message until the agent resolves the gate.
Where the host moves a long tool call to the background before its tool timeout, the agent SHOULD wait for answers in such a call so that an answer resumes the run without a message.
The wait MUST return at once on hosts where it cannot run in the background.
The session URL token MUST be the only credential for recording an answer, and the answer endpoint MUST accept only JSON from the page's own origin.

## Rationale

A recorded gate lets the browser list what waits on the user without parsing the conversation.
A browser-only answer path keeps the user's authority separate from agent writes.
The next-message delivery works on every host that runs the plugin's prompt hook, so it is the dependable fallback.
In real runs a backgrounded tool result woke an idle session within about two seconds, which no other available mechanism did without blocking chat input or an allowlist.

## Alternatives

A Stop hook that waits for the answer kept the turn busy, held back chat input, showed the answer as a hook error, and gave up after the hook timeout.
Pushing the answer into the session through channels requires a research-preview allowlist that third-party plugins do not have.
Answering only in the conversation leaves the browser unable to act on what it shows.

## Consequences

The Attention page lists open questions with their artifacts and accepts answers, and answered questions wait visibly until the agent acts.
Anyone who can open the session URL can answer for the user, and agents print that URL.
On hosts or settings where the wait cannot background, or during the first background handoff interval, the user still sends one message after answering, and a chat answer typed during that interval waits until the handoff.
Browser answers change the coordination state revision, so an agent's next state write may need one re-read and retry.

## Mechanism

The orchestrator records gates with a typed operation that returns their identifiers, then calls the waiting tool once with every gate it just recorded.
The waiting tool polls the coordination state, sends progress notifications that keep the host's idle window open, and returns the answered gates after a short pause for answers given in the same visit.
The review browser records an answer through its own endpoint, and a prompt hook adds every answered but unresolved gate to the user's next message.
The agent acts on each answer and then resolves its gate.

## Decision Log
