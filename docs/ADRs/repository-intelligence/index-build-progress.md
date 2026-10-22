# Show native index builds in the review browser

Status: Proposed
Created: 2026-10-21

## Requirements

No Approved requirement covers this decision.
The owner asked for build progress in the review browser on 2026-10-21 and chose a read-only display, a cheap staleness hint, and a stepped indicator with a percentage per step.

## Problem

The native semantic index is built lazily by whichever agent session first searches the project, inside that session's MCP server process.
A first build downloads the runtime and model, and a large repository can take minutes to embed, while the agent only sees a `preparing` answer.
The review app is a separate detached process shared by every session and project, so it cannot see a build's in-memory state.
The index pointer is written only when a build finishes, and nothing compares a finished index with the working tree until the next search.

## Decision

A process that builds a project's native index MUST publish the build's current step to a private file beside that project's index storage.
Each process MUST write only its own progress file, so concurrent sessions never overwrite each other's progress.
Progress writes MUST be best effort and MUST NOT fail or delay a build.
A building process MUST refresh its progress file at least every five seconds, also through steps that report no counts.
A reader MUST treat a progress file as a running build only while its process exists and the file was refreshed within the last minute, and otherwise as an interrupted build.
When several running builds report progress for one project, a reader MUST show the same build on every read: a build that holds the project lock before one that waits for it, then the earliest started.
A successful build MUST remove its progress file, and a failed build MUST leave it with the failure's diagnostics until a newer index or build replaces it.
A process that starts a build MUST remove progress files whose processes no longer exist.
The review browser MUST only display index state and MUST NOT start, retry, or cancel a build.
The review browser MUST show progress as an ordered list of steps, and MUST show a percentage only for a step whose counts the build reported.
The review browser MUST NOT combine steps into one overall percentage, because the steps have unrelated totals and durations.
A session MUST report its index storage directory when it registers or presents a project, in the same way it reports its evidence store, because each host keeps its plugin data in another place.
The review app MUST read index state from every storage directory that sessions reported for a project, and from its own default storage.
A finished build of the working tree MUST record a Git fingerprint that is taken before the build's snapshot, so a concurrent edit can only make the index look stale, never fresh.
A search that reuses an index for unchanged content MUST move the recorded fingerprint forward.
The staleness hint MUST NOT run Git commands that take optional locks in the user's repository, and the review app SHOULD reuse one hint for at least thirty seconds.
An index of a retained baseline MUST NOT record a fingerprint, and the review browser MUST show no staleness hint for it or for a folder outside Git.
A build that fails because files changed during it SHOULD read as a pending rebuild, not as an error.

## Rationale

A file beside the index survives a review app restart and works however many sessions share a project, which an in-memory push to the app would not.
Per-process files avoid a cross-process lock on a path that a build already holds its own lock around.
A heartbeat with a process check separates a slow step from a session that ended, which the last progress value alone cannot.
A read-only display keeps the shared review app free of the runtime, its downloads, and the index lock, which the owner chose to defer.
The Git fingerprint costs a few small Git commands, while the real snapshot fingerprint hashes every eligible file, which is too heavy for a page that polls.

## Alternatives

- **One overall percentage.** Rejected because weighting downloads, parsing, and embedding against each other would invent a number.
- **Push progress over the control channel.** Rejected because progress would vanish on an app restart and need its own expiry for sessions that end.
- **Compute the real snapshot fingerprint for the staleness hint.** Rejected because it reads and hashes up to the source byte limit on every check.
- **A build button in the review browser.** Deferred by the owner, because the app would need the runtime or a way to ask a session to build.
- **Report progress through the MCP status tool only.** Rejected because the human does not see tool results and the app cannot call another process's tools.

## Consequences

- The human sees which step a build is on, with real counts for downloads, file copying, parsing, and embedding.
- Unpacking the runtime, checking cached assets, extracting text units, planning fragments, and writing the index report no counts, so those steps show motion without a percentage.
- Text extraction and fragment planning run inside the parsing step's report, so parsing can show 100% for a few seconds before embedding starts.
- Embedding counts only fragments without a reusable embedding, so a rebuild after a small edit shows a small total.
- The staleness hint can be wrong both ways: a commit that leaves indexed content unchanged looks stale until the next search, and an edit that keeps a file's size and modification time looks fresh.
- Status entries beyond a fixed bound change the hint but are not checked for further edits.
- The progress file of a process that hangs without exiting reads as interrupted after a minute, even if the process later resumes.
- A process identifier that the system reuses within a minute can keep an interrupted build looking like a running one until its heartbeat expires.
- Builds that ran before this change have no recorded build time or fingerprint, so the browser shows the pointer's modification time and no staleness hint until the next build.
- A session that waits for another session's build no longer replaces that build's step in the chip, which used to jump between the waiting step and the running one.
- The review browser polls index state every two seconds while a build runs and every ten seconds otherwise.

## Mechanism

1. A session registers each project with the review app and names its evidence store and its index storage directory.
2. When a search starts a build, the building process writes its progress file beside the project's index and refreshes it on each new step, at most twice a second within a step, and on a five-second heartbeat.
3. Download steps report bytes, file copying reports files, parsing reports the parser's own sub-steps, and embedding reports fragments that need new embeddings.
4. On success the process records the build time in the index pointer, records the Git fingerprint beside it, and removes its progress file.
5. On failure the process marks its progress file failed and keeps the diagnostics in it.
6. The review app reads the pointer, the fingerprint, and the progress files of every reported storage directory, and derives one state: none, unavailable, preparing, failed, interrupted, or ready with an optional staleness hint.
7. The top bar shows that state as a chip, and the chip opens a panel with the steps, the index facts, and the diagnostics; the project switcher marks other projects whose build runs or failed.

## Decision Log
