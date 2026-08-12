import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startReviewServer } from "../review-server.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-review-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "secrets"), { recursive: true });
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, "docs", "roadmap.md"), "# Roadmap\n\n[Diagram](roadmap.puml)\n");
  await writeFile(path.join(root, "docs", "roadmap.puml"), "@startuml\nA --> B\n@enduml\n");
  await writeFile(path.join(root, "secrets", "private.md"), "# Private\n");
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Roadmap: docs/roadmap.md\n\n## Stack\n- Languages: secrets\n");
  return root;
}

test("lists source artifacts and returns diagram source", async (context) => {
  const review = await startReviewServer({ projectRoot: await fixture(context) });
  try {
    const index = await (await fetch(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.artifacts, ["docs/roadmap.md", "docs/roadmap.puml"]);
    const artifact = await (await fetch(`${review.baseUrl}/api/artifact?path=docs%2Froadmap.md`)).json();
    assert.equal(artifact.diagrams[0].path, "docs/roadmap.puml");
    assert.match(artifact.diagrams[0].source, /A --> B/);
  } finally {
    await review.close();
  }
});

test("rejects paths outside the project", async (context) => {
  const review = await startReviewServer({ projectRoot: await fixture(context) });
  try {
    const response = await fetch(`${review.baseUrl}/api/artifact?path=..%2Foutside.md`);
    assert.equal(response.status, 400);
  } finally {
    await review.close();
  }
});

test("requires the unguessable session path", async (context) => {
  const review = await startReviewServer({ projectRoot: await fixture(context) });
  try {
    const url = new URL(review.baseUrl);
    const response = await fetch(`${url.origin}/api/index`);
    assert.equal(response.status, 404);
  } finally {
    await review.close();
  }
});

test("serves the browser runtime without an image endpoint", async (context) => {
  const review = await startReviewServer({ projectRoot: await fixture(context) });
  try {
    const page = await fetch(review.reviewUrl("docs/roadmap.md"));
    assert.match(page.headers.get("content-security-policy"), /wasm-unsafe-eval/);
    const pageSource = await page.text();
    assert.match(pageSource, /viz-global\.js/);
    assert.match(pageSource, /id="artifact-filter"/);
    assert.match(pageSource, /aria-live="polite"/);
    const stylesheet = await (await fetch(`${review.baseUrl}/review.css`)).text();
    assert.match(stylesheet, /prefers-reduced-motion/);
    const client = await (await fetch(`${review.baseUrl}/review.js`)).text();
    assert.match(client, /data-action="zoom-in"/);
    assert.match(client, /PlantUML source copied/);
    const c4 = await fetch(`${review.baseUrl}/vendor/c4.min.js`);
    assert.equal(c4.status, 200);
    const image = await fetch(`${review.baseUrl}/render/svg?source=docs%2Froadmap.puml`);
    assert.equal(image.status, 404);
  } finally {
    await review.close();
  }
});
