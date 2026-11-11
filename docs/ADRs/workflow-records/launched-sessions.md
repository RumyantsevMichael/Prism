# Launch headless host sessions from the review app under a detached supervisor and a native confirmation

Status: Proposed
Created: 2026-11-10

## Requirements

- [launched-sessions.md§1](../../requirements/launched-sessions.md#1) to [§20](../../requirements/launched-sessions.md#20), where [§20](../../requirements/launched-sessions.md#20) supersedes [§11](../../requirements/launched-sessions.md#11)
- [review-app-actions.md§15](../../requirements/review-app-actions.md#15)

## Problem

A gate answered in the review app moves work forward only while the agent session that asked it is still alive.
The person cannot start, watch, stop, or continue an initiative's orchestration from the page, and Prism cannot see what runs.
The review app is a page process that idles out, is replaced by newer releases, and restarts, so it cannot own a run that lasts hours.
The page's write session is a browser-side credential, which a leaked tab or a browser extension can use, so it must not alone be enough to start a process.
The [review app actions decision](review-app-actions.md) made every action change only Prism records, and the approved requirement now allows exactly the launch, stop, and resume of a host session as the exception.

## Decision

A launched session MUST be started only by the person's action in the review app, and no tool, hook, or command that an agent can call MAY start, resume, or stop one.
A launch MUST take only an initiative identifier, checked against the identifier rule, and a host from a fixed list from the page, and every argument, prompt, variable, and folder of the host process MUST otherwise be fixed by Prism.
A launch, and a resume that the person asks for, MUST be confirmed in a native dialog of the operating system whose default answer refuses, unless the person confirmed one within the last 30 minutes on that machine.
Where the machine offers no native dialog, every launch MUST be refused with the reason, and no confirmation given in the page MAY replace it.
A resume that a gate answer given on this machine causes MUST NOT ask again, because it continues a session the person already confirmed, with the same host and the same fixed arguments.
Launch, stop, and resume MUST pass through the action registry and be recorded in the initiative's history like every other action, and these three actions and the index rebuild MUST be the only actions that start or end processes.
Each launched session MUST run under its own supervisor process, detached from the review app, that starts each run of the host, holds the host's input, reads its event stream, keeps the session's record in a private folder of the review app folder on that machine, and records each run's end with the host's exit status.
A session's state MUST be derived from that record, the supervisor's liveness, and the initiative's coordination state, so any later review app on the machine shows the same state.
A host MUST run under its own automatic permission handling with the project's own host settings, and Prism MUST NOT grant, ask for, or answer any permission itself.
A refusal that the host reports MUST be shown with the host's own reason, and a run MUST NOT wait for a permission answer that nobody can give.
At most one launched session of an initiative MAY run on a machine at a time, counting checkouts that share one record store as one.
Each host MUST run in a headless form that takes the host's own interrupt while it runs: Claude Code with its streamed JSON input, whose input the supervisor keeps open, and Codex through its app server, whose thread and turn the supervisor starts.
A stop MUST send the host the interrupt that the host's own Stop button sends, and once the host has answered it the supervisor MUST close the host's input, so the host ends its turn and exits by itself.
Only when the host still runs after a grace period counted from the stop request MAY the supervisor forcibly end the host process, and it MUST NOT signal, contain, or list any other process.
The host session identifier MUST stay in the launched session's private folder, and only the page of that machine MAY show it, in the command that continues the session in a terminal.
Which gate a launched session asked MUST be recorded on that machine only, so shared gate records keep their shape for every release.
A gate answer MUST resume a session only when it was given on the same machine; an answer that arrives through the record store MUST leave the session as it is and show that it waits.

## Rationale

A detached supervisor per session outlives every change of the review app, and it is the only process that can learn the host's exit status, which the person needs to tell a crash from a finished run.
Deriving the state from files and liveness rather than from the page process lets a newer review app show sessions that an older one started.
A native dialog is answered outside the browser, so neither a stolen page credential nor a browser extension can approve a launch, and a 30-minute window keeps the person from being asked at every gate.
Fixed arguments and a checked identifier keep the page from becoming a way to run prompts or commands.
Each host's own automatic mode already decides what an agent may do; a second permission system in Prism would compete with it and would need its own interface.
Choosing the host session identifier, or reading it from the host's first event, lets Prism resume the session without a terminal and lets the person continue it in one.
Marking a gate on the machine that launched its session needs no new field in the shared gate record, which every release of Prism on every machine of a workspace validates strictly.

## Alternatives

- **The review app runs the host as its child.** Rejected because the review app idles out and is replaced by newer releases, which would end or orphan every run, and an orphan's exit status is lost.
- **A confirmation in the page.** Rejected because a page credential that a browser extension or a leaked tab holds could then approve its own launch.
- **Confirm every launch and every gate-answer resume.** Rejected because a person working through gates would be asked at each one; the window limits what can start without making the person a dialog clicker.
- **A Prism permission prompt tool for headless sessions.** Rejected because it is a permission system of Prism's own, and a prompt nobody answers would hang the run.
- **Record the launched session on the gate in the shared record.** Rejected because older releases on other machines reject a gate with an unknown field, and the shared record would name a machine-local session.
- **Use each host's own background-session commands.** Rejected because they differ between hosts, and Prism could neither choose the session identifier nor read the exit status for both.
- **An agent tool to launch sessions.** Rejected because only the person decides to spend quota on a new session, and orchestrators already start children through their host.
- **End every process the host started, through platform containment and process scans.** Rejected by the product owner on 2026-11-11: a Linux child subreaper, a Windows job object, process-tree walks, and environment scans each needed platform-specific code, fallbacks, and exclusions for the review app and other supervisors, and still missed work started through services, while the hosts already stop their own turns and commands; Prism follows the path that their Stop buttons already take.
- **Signal the host process with a polite termination signal first.** Rejected because the interrupt is the host's own stop, which ends the turn and its commands and keeps the session resumable, while a termination signal is a host crash path; the forced end remains only for a host that does not answer.

## Consequences

- The person starts, watches, stops, and continues runs from the page, and a gate answer moves a closed run forward.
- A run nobody watches keeps spending quota until it ends or the person stops it, since there are no turn, cost, or time limits; visibility and stop are the safeguard.
- A machine without a graphical display, such as a server reached over SSH, cannot launch.
- Any process of the same operating-system user can still answer the native dialog, write the launch window, or run the host itself; the dialog closes only the browser-side path, as the review app actions decision already accepts for same-user processes.
- A supervisor killed from outside leaves its host unsupervised; the page then shows the session failed and says that its host may still run.
- A process that the host or its agent deliberately detached may keep running after a stop, as it does after the hosts' own Stop buttons.
- A gate answer that the running host already received may still cause one resume when the run ends while the gate stays open, which spends a short turn.
- An answer from a teammate's machine waits until the person resumes the session here.
- Codex resumes do not keep the launch's permission policy by themselves, so every Codex run passes the policy again.

## Mechanism

The [lifecycle diagram](launched-sessions-lifecycle.puml) shows a launch, its runs, a stop, and a resume after a gate answer.
The review app lists a launch action per host on each initiative and a stop and a resume action on each launched session, through the action registry.
Applying a launch checks the action as every action is checked, asks the native dialog unless the window is open, creates the session's private folder, and starts its supervisor, which starts the host in the initiative's checkout with fixed arguments and the session's id in the host's environment.
The supervisor reads the host's events for the host session identifier, refusals, and errors, renews a heartbeat, and records the run's end.
Prism's server in the launched session reads the session's id from its environment and marks each gate it asks in the session's folder.
Applying a gate answer on this machine records the answer in the folder of the session that marked the gate and resumes the session when no run of it runs; a supervisor whose run ends while an answer it received stays open resumes once.
Claude Code gets its prompt as a streamed JSON message on its input, which the supervisor keeps open while a turn or a background task of the host runs and closes when the host's work is over, so the host exits by itself.
Codex runs as its app server, to which the supervisor sends the thread start or resume with the fixed permission policy and one turn with the prompt, closing the input once that turn completes; the supervisor answers every request the host sends it with an error, so it grants nothing.
A stop is a request in the session's folder for the running run, which its supervisor carries out with the host's own interrupt: Claude Code's interrupt control request on its input, or Codex's turn interrupt for the running turn.
Once the host has answered, the supervisor closes the host's input, the host ends its turn and exits, and the supervisor records that the run stopped.
A host that still runs after the grace period is forcibly ended, that process alone.
The page reads every session of its record store and derives each state from the folder, the supervisor's liveness, and the coordination state.

## Decision Log
