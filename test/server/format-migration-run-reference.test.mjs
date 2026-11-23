import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { LOG_ADR, LOG_ADR_SOURCE, listedTools, readRun, runCheckout, runFor, waitFor } from "./fixtures/format-migration-runs.mjs";

// A format migration run's session reads the target format's reference from get_migration_run, as the Prism that checks its proposals holds it,
// so it reads no file at all: wherever its host keeps the plugin, the reference is the one Prism checks against.
// Every host here is a stub on a PATH that holds no real Claude Code or Codex.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const UNANCHORED = REQUIREMENT.replace('<a id="2"></a>\n', "");
const REFERENCES = { requirements: "skills/write-requirements/references/requirement-format.md", adr: "skills/write-adr/references/adr-format.md" };
const RUN_TOOLS = ["get_migration_run", "get_artifact", "propose_migration", "finish_migration_run", "fail_migration_run"];

const expected = async (type) => {
  const content = await readFile(path.join(ROOT, REFERENCES[type]), "utf8");
  return { type, version: Number(/^Format version: (\d+)$/m.exec(content)[1]), reference: { path: REFERENCES[type], content } };
};

test("clause 1: get_migration_run returns the set type's format with the exact text of its current reference", { skip: posixOnly }, async (context) => {
  const { call } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED, [LOG_ADR]: LOG_ADR_SOURCE }, { hosts: [] });
  const requirements = await readRun(call, await runFor(call, PATHS.requirements));
  assert.deepEqual(requirements.format, await expected("requirements"));
  const adr = await readRun(call, await runFor(call, LOG_ADR));
  assert.deepEqual(adr.format, await expected("adr"));
});

test("clause 1: get_migration_run's description names the format reference it returns", { skip: posixOnly }, async (context) => {
  const { root } = await runCheckout(context, CONFORMING, { hosts: [] });
  const description = (await listedTools(context, root)).get_migration_run.description;
  assert.match(description, /format \{ type, version, reference: \{ path, content \} \}/);
});

test("clause 2: a run's Claude Code session has no built-in tool and no added folder, and allows only the run's Prism tools", { skip: posixOnly }, async (context) => {
  const { call, hosts } = await runCheckout(context, { ...CONFORMING, [PATHS.requirements]: UNANCHORED });
  await runFor(call, PATHS.requirements);
  const started = await waitFor(() => hosts.runs("claude")[0] ?? null, { what: "the Claude Code stub to start" });
  const at = started.argv.indexOf("--tools");
  assert.ok(at >= 0, JSON.stringify(started.argv));
  assert.equal(started.argv[at + 1], "", "no built-in tool, so no file is read");
  assert.equal(started.argv.includes("--add-dir"), false, "no folder is added");
  assert.equal(started.argv[started.argv.indexOf("--allowedTools") + 1], RUN_TOOLS.map((tool) => `mcp__prism-run__${tool}`).join(","));
  assert.equal(started.argv[started.argv.indexOf("--permission-mode") + 1], "dontAsk");
});

test("clause 3: migrate-artifact takes the format reference from get_migration_run and reads no file beside it", async () => {
  const text = (await readFile(path.join(ROOT, "skills/migrate-artifact/SKILL.md"), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
  const lines = text.split("\n");
  assert.ok(lines.some((line) => /`get_migration_run`/.test(line) && /reference/i.test(line) && /format/i.test(line)), "the reference comes from get_migration_run");
  assert.doesNotMatch(text, /beside this skill/i, "no reference is read beside the skill");
  assert.ok(lines.some((line) => /\bno file\b|\bnot? read (a|any) file\b|never read/i.test(line)), "the session reads no file");
});
