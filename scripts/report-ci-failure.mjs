#!/usr/bin/env node
// Reports a failed Validate run on main as a comment on the open issue labelled ci-main-failure, opening that issue when none is open.
// The comment names each failed job, the tests that failed in it, and the error lines around them, so a failure is recorded where people and agents find it.
// Usage: node scripts/report-ci-failure.mjs <run id> [--dry-run]  (needs the gh CLI and GH_TOKEN; GITHUB_REPOSITORY names the repository)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LABEL = "ci-main-failure";
const MAX_TESTS = 10;
const MAX_DETAIL = 8;

// The runner prefixes every log line with a timestamp, which the report leaves out.
const strip = (line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, "").replace(/\u001b\[[\d;]*m/g, "").trimEnd();

// Each failed test is a TAP "not ok" line with the error block under it, without the per-file summary lines.
// A job that failed without a failed test, such as a smoke test or a setup step, shows its "not ok -" and error lines instead.
export function failureLines(log) {
  const lines = log.split(/\r?\n/).map(strip);
  const failures = [];
  for (let index = 0; index < lines.length && failures.length < MAX_TESTS; index += 1) {
    const line = lines[index];
    if (!/^\s*not ok \d+ - /.test(line) || / - test[\\/]/.test(line)) continue;
    const detail = [];
    for (let next = index + 1; next < lines.length && !/^\s*\.\.\.$/.test(lines[next]); next += 1) {
      const key = /^\s*(duration_ms|type|failureType|code|name|stack|location|expected|actual|operator):/.test(lines[next]);
      if (key && detail.length) break;
      if (key || !lines[next].trim()) continue;
      if (/^\s*error:/.test(lines[next]) || detail.length) detail.push(lines[next].trim().replace(/^error: (\|-)?\s*/, ""));
      if (detail.length >= MAX_DETAIL) break;
    }
    failures.push([line.trim(), ...detail.filter(Boolean).map((text) => `  ${text}`)].join("\n"));
  }
  if (failures.length) return [...new Set(failures)];
  return [...new Set(lines.filter((line) => /^not ok - |net::ERR_[A-Z_]+|\bError: /.test(line)).map((line) => line.trim()))].slice(0, MAX_DETAIL);
}

export function failureReport({ run, jobs }) {
  const failedJobs = jobs.filter((job) => job.conclusion === "failure");
  const reported = failedJobs.map((job) => ({ job, lines: job.log === undefined ? [] : failureLines(job.log) }));
  const sections = reported.filter(({ lines }) => lines.length).map(({ job, lines }) => `### [${job.name}](${job.html_url})\n\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
  const silent = reported.filter(({ lines }) => !lines.length).map(({ job }) => `[${job.name}](${job.html_url})`);
  return [
    `Validate failed on main at ${run.head_sha.slice(0, 7)} (${run.head_commit?.message?.split("\n")[0] ?? "no message"}), run [${run.run_number}](${run.html_url}), attempt ${run.run_attempt}.`,
    ...sections,
    ...(silent.length ? [`Also failed, with no failed test or error line in the log: ${silent.join(", ")}.`] : [])
  ].join("\n\n");
}

// GitHub's API answers an occasional 502, so each call gets three tries.
function gh(args, input) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      if (attempt === 3) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 2000);
    }
  }
}

// A job log holds terminal colour codes, which newer gh releases refuse to print, so the log is fetched directly and the codes are dropped.
async function jobLog(repository, id) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/jobs/${id}/logs`, {
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" }
    });
    if (response.ok) return (await response.text()).replace(/\x1b\[[0-9;]*m/g, "");
    if (attempt === 3) throw new Error(`The log of job ${id} answered ${response.status}.`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

async function main() {
  const [id, ...flags] = process.argv.slice(2);
  if (!/^\d+$/.test(id ?? "")) throw new Error("Give the run id of a failed Validate run.");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY must name the repository.");
  const api = (path) => JSON.parse(gh(["api", `repos/${repository}/${path}`]));
  const run = api(`actions/runs/${id}`);
  const jobs = api(`actions/runs/${id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs;
  for (const job of jobs) {
    if (job.conclusion === "failure") job.log = await jobLog(repository, job.id);
  }
  const report = failureReport({ run, jobs });
  if (flags.includes("--dry-run")) {
    process.stdout.write(`${report}\n`);
    return;
  }
  const open = JSON.parse(gh(["issue", "list", "--repo", repository, "--label", LABEL, "--state", "open", "--json", "number", "--limit", "1"]));
  if (open.length) {
    gh(["issue", "comment", String(open[0].number), "--repo", repository, "--body-file", "-"], report);
  } else {
    gh(["label", "create", LABEL, "--repo", repository, "--force", "--color", "B60205", "--description", "Validate failed on main"]);
    gh(["issue", "create", "--repo", repository, "--label", LABEL, "--title", "Validate fails on main", "--body-file", "-"], `Each failed Validate run on main adds a comment here. Close this issue when main is stable; the next failure opens a new one.\n\n${report}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
