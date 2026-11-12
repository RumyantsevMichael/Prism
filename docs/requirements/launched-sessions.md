# Launched sessions

Status: Approved
Created: 2026-11-09
Approved: 2026-11-09
Amended: 2026-11-11, [§20](#20) supersedes [§11](#11), accepted by Michael in chat at 21:00 UTC: "I agree, i feel like we really over-engineered what should have just followed already invented path".

## Problem

A gate answered in the review app moves work forward only while the agent session that asked it is alive and waiting.
When that session was closed, the answer waits until the person returns to a terminal and resumes the session by hand.
The person cannot start or continue an initiative's orchestration from the review app, and Prism cannot see or stop what runs on the initiative.

## Goals

- Let the person start or continue an initiative's orchestration from the review app as a headless session of Claude Code or Codex on their own machine.
- Show what Prism launched, on which initiative, with which host, for how long, and in what state, and let the person stop it.
- Let a gate answer move a launched session forward without the person returning to a terminal.
- Let the person continue a launched session in a terminal with the host's own command.
- Require the person's confirmation outside the web page before anything starts, so that a page credential alone cannot start a session.
- Keep the host's own permission handling as the only permission system.

## Non-goals

- A chat client: Prism does not render transcripts, accept free-form prompts, run arbitrary commands, or schedule runs.
- A launch tool that agents can call; orchestrators keep using their host's own sub-agents for child sessions.
- A different host per role, such as one host implementing and another reviewing.
- Requests from the review app that start other skills, such as revising a design, retrying, or reviewing a slice.
- Resuming a session on one person's machine from a teammate's gate answer through the shared store.
- Launching in cloud sessions or on any machine other than the one that runs the review app.
- Turn, cost, or time limits on launched sessions.
- A desktop app shell.

## Design questions

- How the review app, which idles out and hands off to newer releases, keeps launched sessions supervised, listed, and stoppable across its own exit, replacement, and restart.
- Which native confirmation each supported platform offers, and what fallback outside the web page applies where none exists; probe it before design freezes the contract.
- Which Codex sandbox and approval policy matches Claude Code's automatic permission mode, and how each host reports an action it refuses in a headless session; probe both hosts.
- How a launch, a stop, and a resume pass through the review app action registry under [review-app-actions.md§16](review-app-actions.md#16).
- How a launched session's host session identifier is kept on the person's machine while shared records keep at most its digest.
- How Prism sends each host's own interrupt and ends the host process on each platform, including npm command shims on Windows.

<a id="1"></a>
## 1. Launch an initiative's orchestration

Pattern: Event-driven

Disposition: Active

Requirement: When the person launches an initiative from the review app and chooses Claude Code or Codex, Prism shall start a headless session of that host on the person's machine that runs the `orchestrate` skill for that initiative in the initiative's checkout.

Rationale: The person can start or continue a run where they watch it, and `orchestrate` resumes from the initiative's records, so starting and continuing are one launch.

Related: [§2](#2), [§3](#3), [review-app-actions.md§1](review-app-actions.md#1)

<a id="2"></a>
## 2. Show why a launch is unavailable

Pattern: State-driven

Disposition: Active

Requirement: While a host CLI cannot be found on the person's machine, Prism shall show the launch for that host as unavailable with the reason.

Rationale: The person learns which host is missing instead of meeting a failed start.

Related: [§1](#1), [review-app-actions.md§2](review-app-actions.md#2)

<a id="3"></a>
## 3. Run one launched session per initiative

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the person launches an initiative while a launched session of that initiative is running on the same machine, then Prism shall refuse the launch with the reason and start no session.

Rationale: Two orchestrators of one initiative would contend for its gates and claims and spend quota twice.

Related: [§1](#1)

<a id="4"></a>
## 4. Take only the initiative and host from the page

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall start a launched session with no instruction text, command, or host option taken from the review page beyond the initiative and the chosen host.

Rationale: A page that can only name an initiative and a host cannot be turned into a way to run arbitrary prompts or commands.

Related: [§1](#1), [review-app-actions.md§16](review-app-actions.md#16)

<a id="5"></a>
## 5. Confirm a launch outside the web page

Pattern: Event-driven

Disposition: Active

Requirement: When the person launches an initiative while no launch window is open, Prism shall ask the person to confirm in a native dialog of the operating system and start the session only after the person confirms there.

Rationale: A leaked page credential or a browser extension can act in the page but cannot answer a native dialog.

Related: [§6](#6), [§8](#8), [review-app-actions.md§5](review-app-actions.md#5)

<a id="6"></a>
## 6. Open a launch window on confirmation

Pattern: Event-driven

Disposition: Active

Requirement: When the person confirms a launch outside the web page, Prism shall start further launches on that machine for the next 30 minutes without asking again.

Rationale: One confirmation covers a working session, so the person is not asked at every launch or gate.

Related: [§5](#5), [§7](#7)

<a id="7"></a>
## 7. Keep running sessions when the window ends

Pattern: Event-driven

Disposition: Active

Requirement: When a launch window ends, Prism shall keep every running launched session running and ask for confirmation outside the web page before the next launch.

Rationale: The window limits what can start, not what the person already started.

Related: [§5](#5), [§6](#6)

<a id="8"></a>
## 8. Refuse a launch without a confirmation outside the page

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the person's machine offers no way to confirm a launch outside the web page, then Prism shall refuse the launch with the reason and start no session.

Rationale: A fallback that accepts a confirmation given only in the page would undo the protection that [§5](#5) gives.

Related: [§5](#5)

<a id="9"></a>
## 9. Offer no agent launch tool

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall start a launched session only from the person's action in the review app and from no Prism tool that an agent can call.

Rationale: Only the person decides to spend quota on a new session, and orchestrators already start child sessions through their host.

Related: [review-app-actions.md§11](review-app-actions.md#11)

<a id="10"></a>
## 10. Show every launched session

Pattern: State-driven

Disposition: Active

Requirement: While a launched session exists on the person's machine, the review app shall show its initiative, its host, its start time, how long it has run, and whether it is running, waiting for the person, blocked, finished, failed, or stopped.

Rationale: Visibility together with stop is the safeguard in place of turn, cost, or time limits.

Related: [§17](#17), [§20](#20)

<a id="11"></a>
## 11. Stop a launched session

Pattern: Event-driven

Disposition: Superseded by [§20](#20)

Requirement: When the person stops a launched session from the review app, Prism shall end the host process and every process it started, and show the session as stopped.

Rationale: A run nobody needs must not keep spending quota or changing files, and a surviving child process would keep doing both.

Related: [§10](#10), [§20](#20)

<a id="12"></a>
## 12. Resume a launched session on a gate answer

Pattern: Event-driven

Disposition: Active

Requirement: When the person answers in the review app a gate that a launched session asked and that session is no longer running, Prism shall resume that host session headless with the same host and permission handling.

Rationale: The answer moves the run forward without the person returning to a terminal, and Prism can resume the session because it chose the session's identifier when launching it.

Related: [§13](#13), [§14](#14), [§16](#16)

<a id="13"></a>
## 13. Resume only on answers given on this machine

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a gate answer for a launched session reaches the person's machine through the shared store from another machine, then Prism shall keep the session as it is and show that the answer waits for a resume on this machine.

Rationale: Starting work on one person's machine from a teammate's answer needs a standing-consent rule that does not exist yet.

Related: [§12](#12)

<a id="14"></a>
## 14. Show the terminal resume command

Pattern: State-driven

Disposition: Active

Requirement: While a launched session is not running, the review app shall show the host command that continues that session in a terminal.

Rationale: The full transcript stays in the host, so the person continues the conversation there and Prism never renders chat.

Related: [§12](#12)

<a id="15"></a>
## 15. Use the host's own permission handling

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall run each launched session under its host's automatic permission handling together with the project's own host settings, and shall grant no permission beyond them.

Rationale: The hosts already decide what an agent may do, and a second permission system in Prism would compete with them.

Related: [§16](#16)

<a id="16"></a>
## 16. Show a host block instead of hanging

Pattern: Unwanted behavior

Disposition: Active

Requirement: If the host refuses an action that a launched session needs to continue, then Prism shall show the session as blocked with the host's reason.

Rationale: A headless session has no one to answer a permission prompt, so a refusal must surface where the person looks rather than leave the run silently waiting.

Related: [§10](#10), [§15](#15)

<a id="17"></a>
## 17. Report a host that ends unexpectedly

Pattern: Unwanted behavior

Disposition: Active

Requirement: If a launched session's host process ends without the session finishing or being stopped, then Prism shall show the session as failed with the host's exit status.

Rationale: A crashed run must not look like one that is still working or that completed.

Related: [§10](#10)

<a id="18"></a>
## 18. Keep launched sessions across review app changes

Pattern: Event-driven

Disposition: Active

Requirement: When the review app is replaced by a newer release, restarts, or idles out, Prism shall keep each launched session running and show it with its state in the next review app on that machine.

Rationale: The review app changes often, and a run must not end or vanish from view because its page process did.

Related: [§10](#10), [single-review-app.md§7](single-review-app.md#7)

<a id="19"></a>
## 19. Keep host session identifiers on the machine

Pattern: Ubiquitous

Disposition: Active

Requirement: Prism shall keep a launched session's host session identifier only on the person's machine and out of every record that can reach the shared store.

Rationale: Shared records hold at most a digest of a session identifier, and a raw identifier would let anyone with store access resume someone else's session.

Related: [shared-record-store.md](shared-record-store.md)

<a id="20"></a>
## 20. Stop a launched session through the host's own interrupt

Pattern: Event-driven

Disposition: Active

Supersedes: [§11](#11)

Requirement: When the person stops a launched session from the review app, Prism shall send the host the interrupt that the host's own Stop button sends, let the host exit by itself once its turn has ended, end the host process itself only if it still runs after a grace period, and show the session as stopped.

Rationale: A run nobody needs must not keep spending quota or changing files, and the hosts already stop their own turns and the commands they run, so Prism follows their Stop buttons rather than hunting for processes; as after those buttons, a process that the agent deliberately detached may keep running.
Michael accepted this on 2026-11-11 in place of ending every process the host started: "I agree, i feel like we really over-engineered what should have just followed already invented path".

Related: [§10](#10), [§11](#11), [§15](#15)
