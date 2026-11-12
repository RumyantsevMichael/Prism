import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ARTIFACT_FORMATS, inspectArtifact } from "../../src/server/workflow/artifact-formats.mjs";

// Each format reference states the version, rule ids, and defaults of its format in code, and its example conforms to it.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// The reference's example: the only fenced block under its Example heading, read fence by fence so that headings inside the example stay in it.
function example(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^## Example\s*$/.test(line));
  const fences = [];
  let open = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const marker = /^(`{3,}|~{3,})/.exec(lines[index]);
    if (open === null && /^## /.test(lines[index])) break;
    if (!marker) continue;
    if (open === null) open = { marker: marker[1], from: index + 1 };
    else if (lines[index].trim() === open.marker) { fences.push(lines.slice(open.from, index).join("\n") + "\n"); open = null; }
  }
  return fences;
}

for (const format of ARTIFACT_FORMATS) {
  test(`the ${format.type} reference matches its format and its example conforms`, async () => {
    const source = await readFile(path.join(ROOT, format.reference), "utf8");
    assert.match(source, new RegExp(`^Format version: ${format.version}$`, "m"));
    assert.deepEqual([...source.matchAll(/^- `([a-z]+\.[a-z0-9-]+)`: \S/gm)].map((match) => match[1]), [...format.rules]);
    assert.deepEqual(Object.fromEntries([...source.matchAll(/^- Default `([^`]+)`: `([^`]*)`$/gm)].map((match) => [match[1], match[2]])), { ...format.defaults });
    const blocks = example(source);
    assert.equal(blocks.length, 1, "one fenced example");
    const result = inspectArtifact(format.type, blocks[0]);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.unknowns, []);
  });
}

test("the four examples, written at their example paths, conform with no unknown value", async (context) => {
  const { mkdtemp, mkdir, rm, writeFile, realpath } = await import("node:fs/promises");
  const os = await import("node:os");
  const { checkArtifacts } = await import("../../src/server/workflow/artifact-check.mjs");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-format-examples-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const format of ARTIFACT_FORMATS) {
    const source = await readFile(path.join(ROOT, format.reference), "utf8");
    const file = /^Example path: `([^`]+)`$/m.exec(source)[1];
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), example(source)[0]);
    files.push(file);
  }
  const value = await checkArtifacts({ projectRoot: root });
  assert.deepEqual(value.artifacts.map((entry) => entry.path).sort(), [...files].sort());
  for (const entry of value.artifacts) {
    assert.deepEqual(entry.findings, [], entry.path);
    assert.deepEqual(entry.unknowns, [], entry.path);
  }
});
