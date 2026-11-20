import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, formatServer, PATHS, write } from "./fixtures/artifact-formats.mjs";
import { storeProject, storeRead } from "./fixtures/artifact-formats-store.mjs";
import { seenArtifactTexts } from "../../dist/server/workflow/store-artifacts.mjs";

// How the citation check names and reads the artifacts that work cites.

const OLD = "docs/requirements/old.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";

const initiative = async (call, operations, id = "retries") => {
  const current = await call("get_initiative", { initiative: id });
  return call("update_initiative", { initiative: id, expectedRevision: current.value?.revision ?? null, operations });
};

const roadmap = async (call, operations) => {
  const current = await call("get_roadmap", {});
  return call("update_roadmap", { expectedRevision: current.value?.revision ?? null, operations });
};

const UNNORMALIZED = ["./docs/requirements/old.md#1", "docs//requirements/old.md#1", "docs/requirements/./old.md#1", "docs/requirements/../requirements/old.md#1", "../docs/requirements/old.md#1", "/docs/requirements/old.md#1"];

test("a requirement reference whose path is not normalized is refused as invalid by update_initiative, so no spelling of a nonconforming file escapes the citation check", async (context) => {
  const { call } = await formatServer(context, { ...CONFORMING, [OLD]: BROKEN });
  for (const reference of UNNORMALIZED) {
    const refused = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: [reference] }]);
    assert.equal(refused.value?.code, "validation_failed", `${reference}: ${refused.text}`);
    assert.match(refused.error?.message ?? refused.text, /normalized project-relative path/, reference);
    assert.equal((await call("get_initiative", { initiative: "retries" })).value.exists, false, `${reference}: nothing changed`);
  }
  const cited = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: [`${OLD}#1`] }]);
  assert.equal(cited.value?.code, "artifact_nonconforming", cited.text);
});

test("a requirement reference whose path is not normalized is refused as invalid by update_roadmap", async (context) => {
  const { call } = await formatServer(context, { ...CONFORMING, [OLD]: BROKEN });
  for (const reference of UNNORMALIZED) {
    const refused = await roadmap(call, [{ op: "add_initiative", id: "retries", title: "Retries", intent: "Bound retries.", band: "Now", requirements: [reference] }]);
    assert.equal(refused.value?.code, "validation_failed", `${reference}: ${refused.text}`);
    assert.match(refused.error?.message ?? refused.text, /normalized project-relative path/, reference);
  }
});

test("the citation check reads only the store artifacts an update cites, not every artifact the store holds", async (context) => {
  const { root, call } = await storeProject(context, { ...CONFORMING, [OLD]: BROKEN });
  await storeRead(call, OLD);
  const every = await seenArtifactTexts(root);
  assert.ok(every.artifacts.length > 2, "the store holds more artifacts than the update cites");
  const cited = await seenArtifactTexts(root, { paths: [PATHS.requirements, PATHS.glossary, "docs/requirements/missing.md"] });
  assert.deepEqual(cited.artifacts.map((artifact) => [artifact.path, artifact.scope.label]).sort(), [[PATHS.glossary, "api"], [PATHS.requirements, "api"]]);
  const whole = (file) => every.artifacts.find((artifact) => artifact.path === file);
  for (const artifact of cited.artifacts) assert.deepEqual({ ...artifact, bytes: Buffer.from(artifact.bytes) }, { ...whole(artifact.path), bytes: Buffer.from(whole(artifact.path).bytes) }, `${artifact.path} reads as the whole listing reads it`);
  const refused = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["old.md§1"] }]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  const created = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["retries.md§1"] }]);
  assert.equal(created.value?.code ?? null, null, created.text);
});

test("a slice.md link cites only the files check_artifacts lists as artifacts, not a README, a diagram, or a file too deep below its folder", async (context) => {
  const notes = "# Notes\n\nSome notes.\n";
  const unlisted = ["docs/requirements/README.md", "docs/ADRs/retries/flow.puml", "docs/Features/README.md", "docs/requirements/a/b/c/d/e/deep.md"];
  const { root, call } = await formatServer(context, { ...CONFORMING, [OLD]: BROKEN, ...Object.fromEntries(unlisted.map((file) => [file, notes])) });
  assert.equal((await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: ["retries.md§1"] }])).value?.code ?? null, null);
  assert.equal((await initiative(call, [{ op: "claim", slug: "retries" }])).value?.code ?? null, null);
  await write(root, "test/retries.test.mjs", "import test from \"node:test\";\ntest(\"x\", () => {});\n");
  const listed = (await call("check_artifacts", {})).value.artifacts.map((artifact) => artifact.path);
  for (const file of unlisted) assert.ok(!listed.includes(file), `check_artifacts does not list ${file}`);
  const propose = async (links) => {
    await write(root, "docs/plans/retries/slice.md", `# Retries\n\n## Contract\n\n1. Retries stop, see ${links.map((file) => `[notes](../../${file.slice("docs/".length)})`).join(", ")}.\n\n## Changes\n\n- change \`src/retry.mjs\`: stop (§1)\n`);
    return initiative(call, [{ op: "propose_design", slug: "retries", operations: [{ op: "accept_design", slug: "retries", frozenTests: ["test/retries.test.mjs"], review: "none" }] }]);
  };
  const refused = await propose([...unlisted, OLD]);
  assert.equal(refused.value?.code, "artifact_nonconforming", refused.text);
  assert.deepEqual(refused.value.artifacts.map((artifact) => artifact.path), [OLD]);
  const accepted = await propose(unlisted);
  assert.equal(accepted.value?.code ?? null, null, accepted.text);
});

test("update_roadmap update_initiative cites only the references the entry does not already hold", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, "docs/requirements/other.md": CONFORMING[PATHS.requirements] });
  const added = await roadmap(call, [{ op: "add_initiative", id: "retries", title: "Retries", intent: "Bound retries.", band: "Now", requirements: ["retries.md§1"] }]);
  assert.equal(added.value?.code ?? null, null, added.text);
  await write(root, PATHS.requirements, BROKEN);
  await write(root, OLD, BROKEN);
  const kept = await roadmap(call, [{ op: "update_initiative", id: "retries", requirements: ["retries.md§1", "other.md§1"] }]);
  assert.equal(kept.value?.code ?? null, null, kept.text);
  const dropped = await roadmap(call, [{ op: "update_initiative", id: "retries", requirements: ["other.md§1"] }]);
  assert.equal(dropped.value?.code ?? null, null, dropped.text);
  const readded = await roadmap(call, [{ op: "update_initiative", id: "retries", requirements: ["other.md§1", "retries.md§1"] }]);
  assert.equal(readded.value?.code, "artifact_nonconforming", readded.text);
  const gained = await roadmap(call, [{ op: "update_initiative", id: "retries", requirements: ["other.md§1", "old.md§1"] }]);
  assert.equal(gained.value?.code, "artifact_nonconforming", gained.text);
  assert.deepEqual(gained.value.artifacts.map((artifact) => artifact.path), [OLD]);
});

test("a roadmap entry keeps a reference recorded before reference paths had to be normalized when an update carries it over", async (context) => {
  const { root, call } = await formatServer(context, { ...CONFORMING, "docs/requirements/other.md": CONFORMING[PATHS.requirements] });
  assert.equal((await roadmap(call, [{ op: "add_initiative", id: "retries", title: "Retries", intent: "Bound retries.", band: "Now", requirements: ["retries.md§1"] }])).value?.code ?? null, null);
  const legacy = `./${PATHS.requirements}#1`;
  const file = path.join(root, (await call("get_roadmap", {})).value.recordPath);
  const record = JSON.parse(await readFile(file, "utf8"));
  record.initiatives.find((entry) => entry.id === "retries").requirements = [legacy];
  await writeFile(file, JSON.stringify(record, null, 2));
  const carried = await roadmap(call, [{ op: "update_initiative", id: "retries", requirements: [legacy, "other.md§1"] }]);
  assert.equal(carried.value?.code ?? null, null, carried.text);
  const entry = (await call("get_roadmap", {})).value.record.initiatives.find((item) => item.id === "retries");
  assert.deepEqual(entry.requirements, [legacy, "docs/requirements/other.md#1"]);
  const fresh = await roadmap(call, [{ op: "update_initiative", id: "retries", requirements: [legacy, `./docs/requirements/other.md#1`] }]);
  assert.equal(fresh.value?.code, "validation_failed", fresh.text);
});
