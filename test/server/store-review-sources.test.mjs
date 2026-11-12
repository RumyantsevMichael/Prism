import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { browserRequest, checkout, isolateGit, reviewBrowser, text, workspace } from "./fixtures/workspace-artifacts.mjs";

// With a record store, a tracked checkout file at an artifact path is not the artifact, so the review browser shows it neither as a document nor as a source file.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const paths = ["- Requirements: docs/requirements", "- Glossary: docs/Glossary.md"];
const files = { "docs/requirements/billing.md": "# Checkout billing\n", "docs/Glossary.md": "# Checkout glossary\n", "src/app.js": "export const app = 1;\n" };

test("a store's review browser lists no checkout copy of an artifact among its source files", async (context) => {
  const place = await workspace(context);
  // The workspace scope holds other bytes at both paths, so the move of the checkout's artifacts keeps the checkout's copies, which are never the artifacts.
  await mkdir(path.join(place.store, "artifacts", "requirements"), { recursive: true });
  await writeFile(path.join(place.store, "artifacts", "requirements", "billing.md"), "# Store billing\n");
  await writeFile(path.join(place.store, "artifacts", "glossary.md"), "# Store glossary\n");
  const api = await checkout(place, "api", { paths, files });
  const review = await reviewBrowser(context, api);
  const index = await browserRequest(review, "/api/index");
  assert.equal(index.status, 200);
  assert.equal(index.body.sources.includes("src/app.js"), true, "code stays a source file");
  for (const file of ["docs/requirements/billing.md", "docs/Glossary.md"]) {
    assert.equal(await text(path.join(api, file)), files[file], `${file} stays in the checkout`);
    assert.equal(index.body.sources.includes(file), false, `${file} is no source file`);
    assert.equal(index.body.artifacts.includes(file), true, `${file} is the store's artifact`);
    const served = await browserRequest(review, `/api/artifact?path=${encodeURIComponent(file)}`);
    assert.equal(served.status, 200);
    assert.doesNotMatch(JSON.stringify(served.body), /Checkout/, `${file} is not served from the checkout`);
    assert.match(JSON.stringify(served.body), /Store/, `${file} is served from the store`);
  }
});

test("with the store unavailable, the review browser's glossary shows no checkout copy and code still serves", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { store: "../missing-store", paths, files });
  const review = await reviewBrowser(context, api);
  const glossary = await browserRequest(review, "/api/entity?ref=glossary");
  assert.doesNotMatch(JSON.stringify(glossary.body), /Checkout glossary/);
  assert.equal((await browserRequest(review, "/api/artifact?path=docs%2FGlossary.md")).status, 503);
  const code = await browserRequest(review, "/api/artifact?path=src%2Fapp.js");
  assert.equal(code.status, 200, "a file outside the artifact paths still serves from the checkout");
});
