#!/usr/bin/env node
// Finds fixed sleeps in the tests that a check follows, which pass on a fast machine and fail on a slow runner.
// A test waits for the state it checks with settled() from test/server/fixtures/wait.mjs, or for an event such as a locator or a response,
// and uses pause(ms, reason) only where nothing can be awaited, such as a check that something does not happen.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["test"];
// The wait helpers themselves sleep between readings.
const EXEMPT = new Set(["test/server/fixtures/wait.mjs"]);

// A fixed sleep: Playwright's waitForTimeout, a Promise around setTimeout, or a local delay or sleep helper given a number.
const SLEEP = /\bwaitForTimeout\(|new Promise\(\(?\w*\)? => setTimeout\(\w+, [^)]+\)\)|\bawait (?:delay|sleep)\(\d/;
// A sleep inside a loop polls for a state, which ends as soon as the state arrives.
const LOOP = /\b(?:for|while)\s*\(/;
const CHECK = /^\s*(?:assert\b|assert\.|t\.assert\b)/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

export function findings(source, file) {
  const lines = source.split("\n");
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (COMMENT.test(line)) continue;
    if (/\bwaitForTimeout\(/.test(line)) {
      found.push({ file, line: index + 1, reason: "waitForTimeout is a fixed sleep: wait for the state with settled() or a locator, or use pause(ms, reason)" });
      continue;
    }
    if (!SLEEP.test(line) || LOOP.test(line)) continue;
    let next = index + 1;
    while (next < lines.length && (lines[next].trim() === "" || COMMENT.test(lines[next]))) next += 1;
    if (next < lines.length && CHECK.test(lines[next])) {
      found.push({ file, line: index + 1, reason: "a fixed sleep before a check: wait for the state with settled(), or use pause(ms, reason) where nothing can be awaited" });
    }
  }
  return found;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(full);
    return entry.name.endsWith(".mjs") ? [full] : [];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = SCANNED.flatMap((directory) => files(path.join(ROOT, directory)))
    .map((full) => path.relative(ROOT, full).split(path.sep).join("/"))
    .filter((file) => !EXEMPT.has(file))
    .flatMap((file) => findings(readFileSync(path.join(ROOT, file), "utf8"), file));
  for (const item of found) console.error(`${item.file}:${item.line}: ${item.reason}`);
  if (found.length > 0) {
    console.error(`${found.length} fixed sleep${found.length === 1 ? "" : "s"} found; see "Waiting in tests" in CONTRIBUTING.md.`);
    process.exit(1);
  }
  console.log("No fixed sleep is followed by a check.");
}
