# Visual review

Use the Prism review server for human artifact review when its tools are available.
Missing `Review browser` defaults to `auto`.
For `auto`, use the internal browser in desktop sessions and the system browser in CLI sessions.
For `internal`, use the internal browser.
For `external`, use the system browser.
Explicit `internal` and `external` values override `auto`.

Open one Prism artifact viewer session for all recorded ADRs and diagrams after a clean design audit and before implementation.
Open one Prism artifact viewer session for all changed artifacts and diagrams before the final correctness gate.
Use a browser-opening capability with no artifact argument so each session opens the complete artifact tree.
Treat a URL-only result or an unavailable opener as a fallback, and present the URL and source artifacts.
Inspect the rendered artifact before the related user gate.
If no review server exists, present the source artifacts.
