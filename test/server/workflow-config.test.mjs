import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PATHS, initiativeDirectory, parseWorkflowConfig, readWorkflowConfig, roadmapPaths } from "../../dist/server/workflow/workflow-config.mjs";

test("reads configured paths by label and keeps defaults for the rest", () => {
  const config = parseWorkflowConfig([
    "# Workflow config",
    "## Paths",
    "- Requirements: specs/requirements/",
    "- Plans (coordination scratch): work/plans/",
    "- Roadmap: product/roadmap.md",
    "- Product strategy: n/a",
    "## Stack",
    "- Languages: JavaScript"
  ].join("\n"));
  assert.equal(config.paths.requirements, "specs/requirements");
  assert.equal(config.paths.plans, "work/plans");
  assert.equal(config.paths.roadmap, "product/roadmap.md");
  assert.equal(config.paths.productStrategy, null);
  assert.equal(config.paths.glossary, DEFAULT_PATHS.glossary);
  assert.deepEqual(config.configured, ["plans", "productStrategy", "requirements", "roadmap"]);
  assert.equal(config.sections.Stack.Languages, "JavaScript");
  assert.deepEqual(config.diagnostics, []);
  assert.deepEqual(roadmapPaths(config), { record: "product/roadmap.json", projection: "product/roadmap.md" });
  assert.equal(initiativeDirectory(config, "checkout"), "work/plans/checkout");
});

test("reports unknown, duplicate, absolute, and escaping paths", () => {
  const config = parseWorkflowConfig([
    "## Paths",
    "- Glossary: /etc/glossary.md",
    "- ADRs: ../decisions",
    "- Requirements: a/",
    "- Requirements: b/",
    "- Mystery: x/",
    "```markdown",
    "## Paths",
    "- Roadmap: ignored.md",
    "```"
  ].join("\n"));
  assert.deepEqual(config.diagnostics.map((item) => item.code), ["path_absolute", "path_outside_project", "path_duplicate", "path_unknown"]);
  assert.equal(config.paths.glossary, null);
  assert.equal(config.paths.adrs, null);
  assert.equal(config.paths.requirements, "a");
  assert.equal(config.paths.roadmap, DEFAULT_PATHS.roadmap);
});

test("a disabled roadmap or plans path disables the record locations", () => {
  const config = parseWorkflowConfig("## Paths\n- Roadmap: n/a\n- Plans: n/a\n");
  assert.equal(roadmapPaths(config), null);
  assert.equal(initiativeDirectory(config, "x"), null);
});

test("a project without workflow config uses defaults and says so", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const missing = await readWorkflowConfig(root);
  assert.equal(missing.exists, false);
  assert.equal(missing.diagnostics[0].code, "config_missing");
  assert.deepEqual(missing.paths, { ...DEFAULT_PATHS });
  await mkdir(path.join(root, ".prism"));
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Glossary: docs/terms.md\n");
  const present = await readWorkflowConfig(root);
  assert.equal(present.exists, true);
  assert.equal(present.paths.glossary, "docs/terms.md");
});
