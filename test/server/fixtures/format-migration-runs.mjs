import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CONFORMING, formatProject } from "./artifact-formats.mjs";
import { COMPONENTS, STORE_PATHS } from "./artifact-formats-store.mjs";
import { isolatedEnv } from "./isolated-env.mjs";
import { controlledPath, processesNaming, stubBin, waitFor } from "./launched-sessions.mjs";
import { prismServer } from "./repository-checkouts.mjs";
import { defer } from "./teardown.mjs";
import { checkout, isolateGit, workspace } from "./workspace-artifacts.mjs";

// Projects for the format migration run tests: a checkout or a store workspace whose Prism server sees only stub hosts,
// so a run that Prism launches starts a stub that holds its turn while the test calls the run's tools as its session would.

export { waitFor };

/** Nonconforming sources and their migrated content, shared by the run tests. */
export const AUDIT = "docs/requirements/audit.md";
export const AUDIT_SOURCE = "# Audit log\n\nStatus: Draft\nCreated: 2026-08-01\nApproved: n/a\n\n## Context\n\nAdministrators change settings that nobody can trace.\n\n## 1\n\nRequirement: The system shall record every administrative action.\n";
export const auditContent = ({ pattern = "unknown", rationale = "unknown", problem = "Administrators change settings that nobody can trace." } = {}) => `# Audit log

Status: Draft
Created: 2026-08-01
Approved: n/a

## Problem

${problem}

## Goals

unknown

## Non-goals

unknown

## Design questions

unknown

<a id="1"></a>
## 1. Record administrative actions

Pattern: ${pattern}

Disposition: Active

Requirement: The system shall record every administrative action.

Rationale: ${rationale}

Related: n/a
`;
export const auditProposal = (run, extra = {}) => ({ run, type: "requirements", source: AUDIT, target: AUDIT, content: auditContent(), summary: "Adds the format's sections and fields around the one obligation and marks the values the file never gave as unknown.", leftovers: [], ...extra });

export const LOG_ADR = "docs/ADRs/audit/log.md";
export const LOG_ADR_SOURCE = "# Keep an audit log\n\nStatus: Accepted\nCreated: 2026-08-03\n\n## Context\n\nSettings change without a trace.\n\n## Decision\n\nEvery administrative action MUST be logged.\n\n## Consequences\n\nThe log grows with every action.\n";
export const logAdrContent = () => `# Keep an audit log

Status: Accepted
Created: 2026-08-03

## Requirements

n/a

## Problem

Settings change without a trace.

## Decision

Every administrative action MUST be logged.

## Rationale

unknown

## Alternatives

unknown

## Consequences

The log grows with every action.

## Mechanism

unknown

## Decision Log
`;

let isolated = null;

const wrapped = (prism) => async (name, args = {}) => {
  const message = await prism.call(name, args);
  const text = (message.result?.content ?? []).map((item) => item.text ?? "").join("\n") || message.error?.message || "";
  const value = message.result?.structuredContent ?? (message.error ? { code: message.error.data?.code, message: message.error.message, ...message.error.data } : null);
  return { result: message.result ?? null, error: message.error ?? null, text, value, refused: Boolean(message.error || message.result?.isError) };
};

/**
 * Stub hosts for a test: a folder with the named stubs, a run log, and plans, by default a Claude Code stub that holds its turn,
 * with the environment a Prism server needs to launch them and see no other host. Every stub and supervisor ends after the test.
 */
export async function stubHosts(context, { hosts = ["claude"], plans = { claude: [{ hold: "forever" }], codex: [{ hold: "forever" }] } } = {}) {
  let ending = null;
  context.after(() => ending?.());
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-run-hosts-")));
  defer(context, () => rm(scratch, { recursive: true, force: true }));
  const app = path.join(scratch, "app");
  await mkdir(app, { recursive: true });
  const bin = hosts.length ? await stubBin(context, hosts) : path.join(scratch, "empty-bin");
  if (!hosts.length) await mkdir(bin, { recursive: true });
  const log = path.join(scratch, "stub-runs.jsonl");
  const plansFile = path.join(scratch, "stub-plans.json");
  await writeFile(plansFile, JSON.stringify(plans));
  const base = isolatedEnv();
  const env = { PATH: controlledPath(bin, base.PATH), PRISM_STUB_LOG: log, PRISM_STUB_PLANS: plansFile, PRISM_LAUNCH_STOP_GRACE_MS: "1500" };
  const entries = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const runs = (host = null) => entries().filter((entry) => entry.kind === "run" && (!host || entry.host === host));
  const inputs = (pid) => entries().filter((entry) => entry.kind === "input" && entry.pid === pid).map((entry) => entry.message);
  ending = () => {
    const ended = process.platform === "win32" ? [] : [...processesNaming(app), ...processesNaming(bin)];
    for (const run of runs()) ended.push(run.pid, ...(run.children ?? []).map((child) => child.pid));
    for (const pid of ended) if (pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch {}
  };
  return { app, bin, env, runs, inputs };
}

/** One more Prism server for a project that sees the given stub hosts, as another session on the same machine would: its call wrapper. */
export async function serve(context, root, hosts) {
  return wrapped(await prismServer(context, root, { appFolder: hosts.app, env: hosts.env }));
}

/** A checkout project with the given files committed and one Prism server that sees the stub hosts: { root, call, hosts }. */
export async function runCheckout(context, files = CONFORMING, options = {}) {
  const hosts = await stubHosts(context, options);
  const root = await formatProject(context, files);
  const prism = await prismServer(context, root, { appFolder: hosts.app, env: hosts.env });
  return { root, call: wrapped(prism), hosts };
}

/**
 * A store workspace, a Git repository when gitStore is true, with the checkout `api` whose files the first tool call moves into the repository scope `api`,
 * and one Prism server that sees the stub hosts: { place, root, call, hosts }.
 */
export async function runStore(context, files = CONFORMING, { store, gitStore = false, ...options } = {}) {
  isolated ??= isolateGit();
  await isolated;
  const hosts = await stubHosts(context, options);
  const place = await workspace(context);
  // A store that is a Git repository, with sync off, where an applied run's commit can be read.
  if (gitStore) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: place.store, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: place.store, stdio: "pipe" });
  }
  const root = await checkout(place, "api", { paths: [...STORE_PATHS], components: [...COMPONENTS], files, ...(store === undefined ? {} : { store }) });
  const prism = await prismServer(context, root, { appFolder: hosts.app, env: hosts.env });
  return { place, root, call: wrapped(prism), hosts };
}

/** check_artifacts' entry for a path, or undefined. */
export async function entryFor(call, file) {
  const checked = await call("check_artifacts", {});
  if (checked.refused) throw new Error(`check_artifacts failed: ${checked.text}`);
  return checked.value.artifacts.find((artifact) => artifact.path === file);
}

/** The run that Prism started for a path, once check_artifacts names it: its id. */
export async function runFor(call, file) {
  const migration = await waitFor(async () => (await entryFor(call, file))?.migration ?? null, { what: `a migration run of ${file}` });
  return migration.run;
}

/** The run's record from get_migration_run. */
export async function readRun(call, run) {
  const read = await call("get_migration_run", { run });
  if (read.refused) throw new Error(`get_migration_run failed: ${read.text}`);
  return read.value.run;
}
/** The tools that a Prism server for the project lists, by name, each with its description and input schema; extra adds variables to its environment. */
/** The tools that a Prism server for the project lists, by name, each with its description and input schema. */
export async function listedTools(context, root, extra = {}) {
  const env = isolatedEnv({ PRISM_REVIEW_APP: "off", PRISM_NATIVE_ASSET_MANIFEST: fileURLToPath(new URL("./native-manifest-unavailable.json", import.meta.url)), CLAUDE_PROJECT_DIR: root, ...extra });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../../dist/server/mcp.mjs", import.meta.url))], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  context.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const answers = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) answers.set(message.id, message);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "format-migration-test", version: "1" } } });
  await waitFor(() => answers.get(1) ?? null, { what: "initialize" });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const listed = await waitFor(() => answers.get(2) ?? null, { what: "tools/list" });
  child.stdin.end();
  return Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]));
}
