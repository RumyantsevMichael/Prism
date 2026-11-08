# Visual review

Use the Prism review browser for human review of designs and artifacts when its tools are available.
The `Review browser` setting selects `internal`, `external`, or `auto`, and `auto` uses the internal browser on desktop and the system browser in CLI sessions.
A tab opened from a review URL, as in the internal browser, holds no [write session](../SKILL.md#common-terms) and can only read.

- Record the user gate with its artifacts before opening the browser, so the Attention page lists it.
- Open the browser without an artifact argument so it starts on Attention.
- When the review opens in the internal browser or only a URL is available, tell the user that this tab can only read, and that they can answer in the conversation, in the system browser that `present_review` opens, or in the tab that `prism review` opens.
- When only a URL is available, present the URL and the source artifact paths.
- When no review browser exists, present the source artifacts.
