# Review app actions

Status: Approved
Created: 2026-11-05
Approved: 2026-11-05

## Problem

The person reviews an initiative in the review app but can change almost nothing there: the page records gate answers and starts an index rebuild, each through its own write, and every other change waits for a message to an agent.
Each new kind of change would need its own page code and its own write path, with its own checks for stale values, history, and authority.
Agents are handed the review URL, and the shared app keeps its viewer credential in its application folder, so an agent can write as the person today, for example by answering its own gate.
A change the person makes in the page also reaches a running agent only when skill prose tells it to look.

## Goals

- Let the person change Prism records from the review app through actions that the page renders without code specific to each action.
- Keep one write path for every change the review app makes, with the same stale-value check, history, and authority rule.
- Keep agents from writing as the person through the review URL they are given.
- Let running agents learn of the person's changes from Prism's own tool results.
- Let later actions, such as requests to agents and comments on documents, join without changing the mechanism.
- Keep the mechanism usable by a desktop shell that reaches it without HTTP and lists actions in a command palette.

## Non-goals

- Actions that run commands, change project files, or run Git.
- Separating the person from an agent that runs as the same operating-system user with full access to that user's files.
- Any particular action beyond gate answers and the index rebuild, which other requirement files define.
- Serving the review app to another machine or another operating-system user.

## Design questions

- How the page obtains the write credential without any tool result or the URL given to agents revealing it, and how an open tab keeps or regains it after the review app is replaced or restarts.
- How the action registry stays independent of HTTP so that a desktop shell can serve it over another channel.
- How each agent session is identified for the once-per-session change notice.
- A tab opened from a URL that an agent handed over stays read-only and shows that changes need the page opened by Prism itself; Michael chose this on 2026-11-05, so the write credential never passes through an agent.

<a id="1"></a>
## 1. Offer the actions that apply to what the page shows

Pattern: Event-driven

Disposition: Active

Requirement: When the review app shows an initiative, a slice, a gate, or the index, Prism shall list every action that applies to that target with its current value, its inputs as choices, toggles, or short text, and when it takes effect.

Rationale: The page then renders any action from what Prism returns, so a new action needs no page code of its own.

Related: [§2](#2), [initiative-settings.md§1](initiative-settings.md#1)

<a id="2"></a>
## 2. Show why an action is unavailable

Pattern: State-driven

Disposition: Active

Requirement: While an action does not apply to its target's current records, Prism shall show the action as unavailable with the reason.

Rationale: The person learns why a setting cannot change instead of finding a missing control.

Related: [§1](#1), [§3](#3)

<a id="3"></a>
## 3. Refuse an unavailable action

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the person applies an action that does not apply to its target's current records, then Prism shall refuse it with the reason and change no record.

Rationale: Availability shown in a page can be out of date, so the rule must hold when the action arrives.

Related: [§2](#2)

<a id="4"></a>
## 4. Refuse an invalid input

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the person applies an action with an input that the action does not accept, then Prism shall refuse it, name the accepted values, and change no record.

Rationale: A generic page cannot know every action's rules, so Prism checks the input itself.

Related: [§1](#1)

<a id="5"></a>
## 5. Confirm a risky action

Pattern: Event-driven

Disposition: Active

Requirement: When the person applies an action that is marked as risky, Prism shall ask the person to confirm it in the page and apply it only after the person confirms.

Rationale: A change such as turning push on lets agents act beyond the person's machine, so one click must not make it.

Related: [initiative-settings.md§9](initiative-settings.md#9)

<a id="6"></a>
## 6. Refuse a change against a stale value

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the record that an action changes was written after the page showed it, then Prism shall refuse the action, change no record, and show the record's current value.

Rationale: An agent may write between the person's look and click, and the person must decide against what is true now.

Related: [§1](#1)

<a id="7"></a>
## 7. Record each applied action

Pattern: Event-driven

Disposition: Active

Requirement: When Prism applies an action, Prism shall record in the history of the target's initiative, or of the project when the target has no initiative, the action, its target, the time, that it came from the review app, and the value before and after.

Rationale: Agents and people can then see who changed what, and when, after the page closes.

Related: [§8](#8)

<a id="8"></a>
## 8. Show applied actions as they happen

Pattern: Event-driven

Disposition: Active

Requirement: When Prism applies an action, Prism shall show it in the review app's attention feed of every connected tab that shows the action's project.

Rationale: A change made in one tab, or by another person, is visible where the person already looks.

Related: [§7](#7)

<a id="9"></a>
## 9. Make every review app change an action

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall accept a change to Prism records from the review app only as an action, including gate answers and the index rebuild.

Rationale: One write path gives every change the same authority, stale-value check, and history.

Related: [§6](#6), [§7](#7), [§10](#10)

<a id="10"></a>
## 10. Change only Prism records

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall apply an action only by changing Prism records, and shall run no command, change no project file, and run no Git operation for it, except that the index rebuild runs Prism's own repository indexer.

Rationale: A page credential that can only change records cannot be turned into a way to run code.

Related: [§9](#9)

<a id="11"></a>
## 11. Require the page's write credential

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a request to apply an action lacks the write credential that Prism gives only to the review page, then Prism shall refuse it and change no record.

Rationale: A URL that an agent is given or reads must not let it answer its own gate or turn push on.

Related: [§12](#12), [single-review-app.md§5](single-review-app.md#5), [single-review-app.md§6](single-review-app.md#6)

<a id="12"></a>
## 12. Keep the write credential from agents

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall not reveal the write credential in any tool result, review URL, or file that Prism writes.

Rationale: Agents get a URL that reads and presents, and only the person's page can write.
An agent with full access to the user's files and processes remains out of reach, which the product owner accepted.

Related: [§11](#11)

<a id="13"></a>
## 13. Tell each agent session about the person's changes

Pattern: Event-driven

Disposition: Active

Requirement: When an agent session receives a Prism tool result about an initiative to which the person applied actions since that session last read the initiative, Prism shall include those changes in that result once per session.

Rationale: Running agents learn of the person's changes from Prism itself rather than from skill prose they may skip.

Related: [§7](#7), [§14](#14)

<a id="14"></a>
## 14. End a gate wait on the person's change

Pattern: Complex

Disposition: Active

Requirement: While `wait_for_user_gate` waits on an initiative, when the person applies an action to that initiative, Prism shall end the wait and return the change.

Rationale: An orchestrator waiting on a gate must not keep working under a setting the person just changed.

Related: [§13](#13)
