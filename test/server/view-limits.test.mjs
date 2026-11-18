import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/design-views.md §1, §6.
// Contract: docs/plans/design-views/slice.md clauses 11 and 13.
// Each kind counts what a person reads in it, and a view beyond its kind's readability limit is refused.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-limits-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const INITIATIVE = "reports";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Signed reports\n\n## Contract\n1. Downloads write the report.\n";
const range = (count) => Array.from({ length: count }, (_, index) => index + 1);
const uml = (lines) => `@startuml\n${lines.join("\n")}\n@enduml\n`;

const sequence = (participants, messages) => uml([...range(participants).map((n) => `participant P${n}`), ...range(messages).map((n) => `P1 -> P2: call ${n}`)]);
const activity = (actions) => uml(["start", ...range(actions).map((n) => `:step ${n};`), "stop"]);
const states = (count, transitions) => uml(["[*] --> S1", ...range(count).map((n) => `state S${n}`), ...range(transitions).map((n) => `S${((n - 1) % count) + 1} --> S${(n % count) + 1} : t${n}`)]);
const components = (count, relations) => uml([...range(count).map((n) => `component C${n}`), ...range(relations).map((n) => `C${((n - 1) % count) + 1} --> C${((n + Math.floor((n - 1) / count)) % count) + 1}`)]);
const wireframe = (cells) => `@startsalt\n{\n${range(Math.ceil(cells / 4)).map((row) => range(4).filter((column) => (row - 1) * 4 + column <= cells).map((column) => `"f${(row - 1) * 4 + column}"`).join(" | ")).join("\n")}\n}\n@endsalt\n`;

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-limits-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Plans: docs/plans\n");
  await write(root, "test/download.test.mjs", "// downloads write the report\n");
  await write(root, `${PLANS}/slice.md`, CONTRACT);
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Signed reports", requirements: ["req.md#R1"] }] });
  return root;
}

async function proposeView(root, kind, source) {
  await write(root, `${PLANS}/view.puml`, source);
  await write(root, `${PLANS}/slice.md`, `${CONTRACT}\n## Views\n- \`view.puml\` ${kind} (§1): What does this view answer?\n`);
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  const request = [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/download.test.mjs"], review: "none" }] }];
  return initiativeAcknowledgement(await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: request }), request);
}

const OVER = [
  ["sequence", sequence(11, 2), "11 participants, more than 10"],
  ["sequence", sequence(2, 31), "31 messages, more than 30"],
  ["activity", activity(31), "31 actions and decisions, more than 30"],
  ["state", states(21, 21), "21 states, more than 20"],
  ["state", states(5, 40), "41 transitions, more than 40"],
  ["component", components(31, 1), "31 elements, more than 30"],
  ["component", components(10, 51), "51 relations, more than 50"],
  ["code", uml(range(31).map((n) => `class C${n}`)), "31 elements, more than 30"],
  ["data-model", uml(range(31).map((n) => `entity E${n} {\n  id : string\n}`)), "31 elements, more than 30"],
  ["deployment", uml(["node host {", ...range(31).map((n) => `  artifact A${n}`), "}"]), "elements, more than 30"]
];

test("clause 11: a view beyond its kind's readability limit is refused, naming the view, what it counts, and the limit", async (context) => {
  const root = await project(context);
  const failures = [];
  for (const [kind, source, expected] of OVER) {
    try {
      await proposeView(root, kind, source);
      failures.push(`${kind} ${expected}: accepted`);
    } catch (error) {
      if (error.code !== "view_problems" || !error.message.includes(`${PLANS}/view.puml shows`) || !error.message.includes(expected) || !error.message.includes(`for ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} view`)) failures.push(`${kind} ${expected}: ${error.code} ${error.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

const COUNTED = [
  ["sequence", sequence(3, 4), 3, 4],
  ["activity", uml(["start", ":read the id;", "if (known?) then (yes)", "  :write bytes;", "else (no)", "  :exit 2;", "endif", "stop"]), 4, 0],
  ["state", uml(["[*] --> Requested", "Requested --> Written : found", "Requested --> Refused : unknown", "Written --> [*]", "Refused --> [*]"]), 3, 5],
  ["component", components(4, 3), 4, 3]
];

test("clause 11: an accepted view lists the elements and relations its kind counts", async (context) => {
  const root = await project(context);
  const failures = [];
  for (const [kind, source, elements, relations] of COUNTED) {
    const view = (await proposeView(root, kind, source)).views.find((item) => item.path === `${PLANS}/view.puml`);
    if (view.kind !== kind || view.elements !== elements || view.relations !== relations) failures.push(`${kind}: ${JSON.stringify(view)}, expected ${elements} and ${relations}`);
  }
  assert.deepEqual(failures, []);
});

test("clause 13: a wireframe counts its widgets and is refused beyond 60", async (context) => {
  const root = await project(context);
  const small = (await proposeView(root, "wireframe", wireframe(4))).views.find((item) => item.path === `${PLANS}/view.puml`);
  assert.deepEqual([small.kind, small.elements, small.relations], ["wireframe", 4, 0]);
  await assert.rejects(proposeView(root, "wireframe", wireframe(61)), (error) => error.code === "view_problems" && error.message.includes("61 widgets, more than 60 for a wireframe view"));
});
