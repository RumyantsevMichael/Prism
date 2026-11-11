# Visual review

Use the Prism review browser for human review of designs and artifacts when its tools are available.
The `Review browser` setting selects `internal`, `external`, or `auto`, and `auto` uses the internal browser on desktop and the system browser in CLI sessions.

- Record the user gate with its artifacts before opening the browser, so the Attention page lists it.
- Open the browser without an artifact argument so it starts on Attention.
- When the internal browser shows the review or only a URL is available, tell the user that this tab holds no [write session](../SKILL.md#common-terms) and can only read, so they answer in the conversation, which confirms no approval or correctness gate, in the system browser that `present_review` opens, or in the tab that `prism review` opens, and when only a URL is available, also present it with the source artifact paths.
- When no review browser exists, present the source artifacts.
