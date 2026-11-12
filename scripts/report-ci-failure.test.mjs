import assert from "node:assert/strict";
import test from "node:test";
import { failureLines, failureReport } from "./report-ci-failure.mjs";

const log = [
  "2026-11-12T19:00:00.0000000Z ok 1 - passes",
  "2026-11-12T19:00:01.0000000Z # \\# request failed: /api/index net::ERR_CONNECTION_REFUSED",
  "2026-11-12T19:00:02.0000000Z not ok 2 - the side panel opens",
  "2026-11-12T19:00:02.0000000Z   ---",
  "2026-11-12T19:00:02.0000000Z   duration_ms: 12.5",
  "2026-11-12T19:00:02.0000000Z   error: |-",
  "2026-11-12T19:00:02.0000000Z     request failed: /kit/kit.css net::ERR_NO_BUFFER_SPACE",
  "2026-11-12T19:00:02.0000000Z   code: 'ERR_ASSERTION'",
  "2026-11-12T19:00:02.0000000Z   stack: |-",
  "2026-11-12T19:00:02.0000000Z     at TestContext (file:///test/server/a.test.mjs:4:5)",
  "2026-11-12T19:00:02.0000000Z   ...",
  "2026-11-12T19:00:03.0000000Z not ok 3 - test\\server\\a.test.mjs",
  "2026-11-12T19:00:04.0000000Z ##[error]Process completed with exit code 1."
].join("\r\n");

test("a failed test shows with its error and without its stack, the file summary, or a passing test's log line", () => {
  assert.deepEqual(failureLines(log), ["not ok 2 - the side panel opens\n  request failed: /kit/kit.css net::ERR_NO_BUFFER_SPACE"]);
});

test("a job without a failed test shows its failure and error lines", () => {
  assert.deepEqual(failureLines("2026-11-12T19:00:00.0Z not ok - codex-turn: capacity is UNSUPPORTED\n2026-11-12T19:00:01.0Z ##[error]Process completed with exit code 1."), ["not ok - codex-turn: capacity is UNSUPPORTED"]);
});

test("the report names the commit and run, gives each failed job its lines, and lists the jobs that show none", () => {
  const report = failureReport({
    run: { head_sha: "0123456789abcdef", head_commit: { message: "fix: a change\n\nbody" }, run_number: 7, html_url: "https://example.invalid/run/7", run_attempt: 2 },
    jobs: [
      { name: "server tests (windows-2025, 1/4)", html_url: "https://example.invalid/job/1", conclusion: "failure", log },
      { name: "checks", html_url: "https://example.invalid/job/2", conclusion: "success" },
      { name: "windows", html_url: "https://example.invalid/job/3", conclusion: "failure", log: "##[error]Process completed with exit code 1." }
    ]
  });
  assert.match(report, /^Validate failed on main at 0123456 \(fix: a change\), run \[7\]\(https:\/\/example\.invalid\/run\/7\), attempt 2\./);
  assert.match(report, /### \[server tests \(windows-2025, 1\/4\)\]\(https:\/\/example\.invalid\/job\/1\)\n\n```\nnot ok 2 - the side panel opens\n  request failed: \/kit\/kit\.css net::ERR_NO_BUFFER_SPACE\n```/);
  assert.doesNotMatch(report, /checks/);
  assert.match(report, /Also failed, with no failed test or error line in the log: \[windows\]\(https:\/\/example\.invalid\/job\/3\)\.$/);
});
