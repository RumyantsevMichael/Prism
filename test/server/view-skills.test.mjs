import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Requirements: docs/requirements/design-views.md §1 to §6.
// Contract: docs/plans/design-views/slice.md clause 20.
// The skills that write views hold one example per kind, and Prism accepts each example as a view of its kind.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-skills-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { getInitiative, initiativeAcknowledgement, updateInitiative } = await import("../../dist/server/workflow/initiative.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

const SKILLS = fileURLToPath(new URL("../../skills/", import.meta.url));
const DIAGRAM_KINDS = ["sequence", "activity", "state", "component", "data-model", "deployment"];
const INITIATIVE = "examples";
const PLANS = `docs/plans/${INITIATIVE}`;
const CONTRACT = "# Examples\n\n## Contract\n1. The example holds.\n2. The second example holds.\n3. The third example holds.\n";

const read = (file) => readFile(path.join(SKILLS, file), "utf8");
const fenced = (text, language) => [...text.matchAll(new RegExp("^```" + language + "[ \\t]*\\r?\\n([\\s\\S]*?)^```", "gm"))].map((match) => match[1]);
const frontmatter = (text) => Object.fromEntries([.../^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1].matchAll(/^(\w[\w-]*):\s*(.*)$/gm) ?? []].map((match) => [match[1], match[2].replace(/^"(.*)"$/, "$1")]));
// The Markdown links of a skill file, resolved against the folder that holds it.
const links = (text, file) => [...text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((match) => path.posix.join(path.posix.dirname(file), match[1]));

async function write(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

async function project(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-view-skills-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  await write(root, ".prism/workflow.md", "## Paths\n- Plans: docs/plans\n");
  await write(root, "test/example.test.mjs", "// the example holds\n");
  await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: null, operations: [{ op: "create", slug: INITIATIVE, title: "Examples", requirements: ["req.md#R1"] }] });
  return root;
}

// Propose a one-slice design whose folder holds the given views, each [file, kind, source], and return the listed views.
async function proposeViews(root, views, design = null) {
  for (const [file, , source] of views) await write(root, `${PLANS}/${file}`, source);
  await write(root, `${PLANS}/slice.md`, design ?? `${CONTRACT}\n## Views\n${views.map(([file, kind]) => `- \`${file}\` ${kind} (§1): What does the ${kind} example show?`).join("\n")}\n`);
  const current = await getInitiative({ projectRoot: root, initiative: INITIATIVE });
  const request = [{ op: "propose_design", slug: INITIATIVE, operations: [{ op: "accept_design", slug: INITIATIVE, frozenTests: ["test/example.test.mjs"], review: "none" }] }];
  return initiativeAcknowledgement(await updateInitiative({ projectRoot: root, initiative: INITIATIVE, expectedRevision: current.revision, operations: request }), request).views ?? [];
}

// The example of each kind: the PlantUML block of each write-diagram reference, the Salt block of write-mockup, and the JSON block that write-contracts gives for an API view.
async function examples() {
  const result = {};
  const diagram = await read("write-diagram/SKILL.md");
  const referenced = links(diagram, "write-diagram/SKILL.md");
  for (const kind of DIAGRAM_KINDS) {
    const file = `write-diagram/references/${kind}.md`;
    assert.ok(referenced.includes(file), `write-diagram links ${file}`);
    const [source] = fenced(await read(file), "plantuml");
    assert.ok(source, `${file} holds a plantuml example`);
    result[kind] = source;
  }
  const [salt] = fenced(await read("write-mockup/SKILL.md"), "plantuml");
  assert.ok(salt, "write-mockup holds a plantuml Salt example");
  result.wireframe = salt;
  const contracts = await read("write-contracts/SKILL.md");
  const candidates = [contracts, ...await Promise.all(links(contracts, "write-contracts/SKILL.md").map((file) => read(file).catch(() => "")))];
  result.api = candidates.flatMap((text) => fenced(text, "json"))[0];
  assert.ok(result.api, "write-contracts or a reference it links holds a json API example");
  result.code = result.component;
  return result;
}

test("clause 20: write-diagram and write-mockup are skills whose description says what they do and when to use them", async () => {
  for (const name of ["write-diagram", "write-mockup"]) {
    const meta = frontmatter(await read(`${name}/SKILL.md`));
    assert.equal(meta.name, name);
    assert.ok((meta.description ?? "").length > 40, `${name} has a description`);
    assert.match(meta.description, /\bUse\b|\bwhen\b/i, `${name}'s description says when to use it`);
  }
});

test("clause 20: Prism accepts every kind's example as a view of that kind", async (context) => {
  const sources = await examples();
  const failures = [];
  for (const [kind, source] of Object.entries(sources)) {
    const root = await project(context);
    const file = kind === "api" ? "example.json" : "example.puml";
    try {
      const listed = await proposeViews(root, [[file, kind, source]]);
      if (listed.find((view) => view.path === `${PLANS}/${file}`)?.kind !== kind) failures.push(`${kind}: listed as ${JSON.stringify(listed)}`);
    } catch (error) { failures.push(`${kind}: ${error.code} ${error.message}`); }
  }
  assert.deepEqual(failures, []);
});

test("clause 20: the design skill's contract example declares views that Prism accepts", async (context) => {
  const design = await read("design/SKILL.md");
  const example = fenced(design.slice(design.indexOf("### Contract example")), "markdown")[0];
  assert.match(example, /^## Views$/m, "the contract example has a Views section");
  const sources = await examples();
  const declared = [...example.matchAll(/^- `([^`]+)` ([a-z-]+) \(/gm)].map((match) => [match[1], match[2], sources[match[2]]]);
  assert.ok(declared.length >= 1, "the example declares at least one view");
  for (const [file, kind, source] of declared) assert.ok(source, `${file} declares ${kind}, which has an example`);
  const listed = await proposeViews(await project(context), declared, example);
  assert.deepEqual(listed.map((view) => view.path).sort(), declared.map(([file]) => `${PLANS}/${file}`).sort());
});
