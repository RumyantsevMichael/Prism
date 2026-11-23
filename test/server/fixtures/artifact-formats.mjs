import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcp } from "./shipped-work.mjs";
import { defer } from "./teardown.mjs";

// Projects for the artifact formats, conformance, and migration acceptance tests, driven through Prism's MCP server and review server.

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const AUTHOR = { name: "Ada Reviewer", email: "ada@example.invalid" };
export const WORKFLOW = "# Workflow config\n\n## Paths\n- Requirements: docs/requirements/\n- ADRs: docs/ADRs/\n- Plans: docs/plans/\n- Feature files: docs/Features/\n- Roadmap: docs/roadmap.md\n- Glossary: docs/Glossary.md\n\n## Stack\n- Test command: node -e \"process.exit(0)\"\n";

/** The format references, by format type, as the contract places them. */
export const REFERENCES = Object.freeze({
  requirements: "skills/write-requirements/references/requirement-format.md",
  adr: "skills/write-adr/references/adr-format.md",
  glossary: "skills/workflow/references/glossary-format.md",
  feature: "skills/write-feature/references/feature-format.md"
});
export const TYPES = Object.freeze(["requirements", "adr", "glossary", "feature"]);

/** A conforming requirement file: one Active and one Withdrawn section. */
export const REQUIREMENT = `# Request retries

Status: Approved
Created: 2026-09-02
Approved: 2026-09-04

## Problem

Clients give up on the first dropped connection.

## Goals

- Recover from short network drops.

## Non-goals

- Retrying requests that the server refused.

## Design questions

- n/a

<a id="1"></a>
## 1. Stop at the total deadline

Pattern: Event-driven

Disposition: Active

Requirement: When a request exceeds its total retry deadline, the client shall stop retrying.

Rationale: A request that retries forever holds a connection that other requests need.

Related: [retries.md§2](#2)

<a id="2"></a>
## 2. Retry dropped connections

Pattern: Event-driven

Disposition: Withdrawn 2026-10-01: connection drops are retried by the transport.

Requirement: When a connection drops, the client shall retry at most three times.

Rationale: Most drops last less than a second.

Related: n/a
`;

/** A conforming Accepted ADR that cites the requirement file above. */
export const ADR = `# Bound retries by a total deadline

Status: Accepted
Created: 2026-09-20

## Requirements

- [retries.md§1](../../requirements/retries.md#1)

## Problem

Retries without a bound can hold a connection forever.

## Decision

Every retry sequence MUST stop when its total deadline elapses.

## Rationale

A total deadline bounds the time a request holds a connection.

## Alternatives

A fixed number of attempts was rejected because attempts vary in length.

## Consequences

A slow attempt leaves fewer attempts for the rest of the sequence.

## Mechanism

The client starts a deadline timer with the first attempt.

## Decision Log

n/a
`;

/** A conforming glossary: one term from the requirement and one from the ADR, with an alias and a distinction. */
export const GLOSSARY = `# Glossary

Terms used across the payments client.

<a id="retry-deadline"></a>
## Retry deadline

The total time a request may spend across all of its retry attempts.
A deadline counts from the first attempt.

Source: [retries.md§1](requirements/retries.md#1)
Aliases: total deadline
Not to be confused with: [Attempt timeout](#attempt-timeout): an attempt timeout bounds one attempt, not the sequence.

<a id="attempt-timeout"></a>
## Attempt timeout

The time one attempt may take before the client counts it as failed.

Source: [Bound retries by a total deadline](ADRs/retries/total-retry-deadline.md)
`;

/** A conforming feature file. */
export const FEATURE = `Feature: Request retries

  Rule: Retries stop at the total deadline
    # Requirement: [Stop at the total deadline](../requirements/retries.md#1)
    # ADR: [Bound retries by a total deadline](../ADRs/retries/total-retry-deadline.md)

    Example: A request past its deadline is not retried
      Given a request whose total deadline has elapsed
      When its attempt fails
      Then the client reports the failure
      And the client sends no further attempt
`;

export const PATHS = Object.freeze({
  requirements: "docs/requirements/retries.md",
  adr: "docs/ADRs/retries/total-retry-deadline.md",
  glossary: "docs/Glossary.md",
  feature: "docs/Features/F-retries.feature"
});

/** A conforming set of the four artifacts at their usual paths. */
export const CONFORMING = Object.freeze({ [PATHS.requirements]: REQUIREMENT, [PATHS.adr]: ADR, [PATHS.glossary]: GLOSSARY, [PATHS.feature]: FEATURE });

export async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

export const read = (root, file) => readFile(path.join(root, file), "utf8");

export function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" });
}

/** Commits every file of the project with the given author date, so a migration can read dates from the source's history. */
export function commitAll(root, message = "Add artifacts", date = "2026-03-14T10:00:00Z") {
  git(root, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
}

/** A Git checkout on main with a local identity, the workflow config, and the given files; files defaults to the conforming set. */
export async function formatProject(context, files = CONFORMING) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-formats-")));
  defer(context, () => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", AUTHOR.name);
  git(root, "config", "user.email", AUTHOR.email);
  git(root, "config", "commit.gpgsign", "false");
  await write(root, ".prism/workflow.md", WORKFLOW);
  for (const [file, text] of Object.entries(files)) await write(root, file, text);
  commitAll(root);
  return root;
}

/** A format project with one MCP server: { root, call }. */
export async function formatServer(context, files = CONFORMING) {
  const root = await formatProject(context, files);
  return { root, call: await mcp(context, root) };
}

/** check_artifacts' entry for one path, or undefined. */
export async function checked(call, paths) {
  const result = await call("check_artifacts", paths ? { paths } : {});
  if (result.error || result.result?.isError) throw new Error(`check_artifacts failed: ${result.text || result.error?.message}`);
  return result.value;
}

export const entryOf = (value, file) => value.artifacts.find((artifact) => artifact.path === file);
export const rulesOf = (entry) => [...new Set((entry?.findings ?? []).map((finding) => finding.rule))].sort();

/** The text of a reference file, or null when it does not exist yet. */
export async function reference(type) {
  try {
    return await readFile(path.join(ROOT, REFERENCES[type]), "utf8");
  } catch {
    return null;
  }
}

/** A reference's example: the only fenced block under its Example heading, and its example path; the section ends at the first `## ` line outside a fence, since a complete example holds `## ` headings of its own. */
export function exampleOf(source) {
  const lines = (source.split(/^## Example\s*$/m)[1] ?? "").split("\n");
  const blocks = [];
  let open = null;
  for (const [index, line] of lines.entries()) {
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) {
      if (marker && marker[0] === open.marker[0] && marker.length >= open.marker.length && line.trim() === marker) { blocks.push(lines.slice(open.from + 1, index).join("\n") + "\n"); open = null; }
    } else if (marker) open = { marker, from: index };
    else if (/^## /.test(line)) break;
  }
  return { text: blocks.length === 1 && !open ? blocks[0] : null, path: /^Example path: `?([^`\s]+)`?\s*$/m.exec(source)?.[1] ?? null, fences: blocks.length * 2 + (open ? 1 : 0) };
}

/** The rule ids that a reference lists as `- \`<id>\`: <rule>` lines. */
export function listedRules(source) {
  return [...source.matchAll(/^- `([a-z]+\.[a-z0-9-]+)`: \S/gm)].map((match) => match[1]).sort();
}
