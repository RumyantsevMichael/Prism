import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CONFORMING, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, otherCheckout, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";
import { browserRequest, reviewBrowser } from "./fixtures/workspace-artifacts.mjs";

// Attention's format findings in a project whose requirements are store artifacts in several scopes.

const OLD = "docs/requirements/old.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";
// The workspace scope's copy of OLD in the store's files.
const WORKSPACE_OLD = "artifacts/requirements/old.md";

// A nonconforming store file arrives as another machine's sync would bring it, since every write of a requirement through Prism is checked against its format.
async function storeFile(place, location, text) {
  await mkdir(path.dirname(path.join(place.store, location)), { recursive: true });
  await writeFile(path.join(place.store, location), text);
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function served(context) {
  const { place, root, call } = await storeProject(context, { ...CONFORMING, [OLD]: BROKEN });
  // api's first tool call moves its checkout artifacts into scope api before the workspace holds the same path, which would keep them in the checkout.
  await storeRead(call, PATHS.requirements);
  // The workspace scope holds another nonconforming copy at the same path, which a checkout that does not see api's scope reads.
  const web = await otherCheckout(context, place);
  await storeFile(place, WORKSPACE_OLD, `${BROKEN}\nThe server logs.\n`);
  const review = await reviewBrowser(context, root);
  const attention = async () => (await browserRequest(review, "/api/entity?ref=attention")).body.data;
  return { place, root, call, web, attention };
}

test("clauses 17, 55: Attention lists each nonconforming store artifact by path and scope, one entry per scope that holds it", async (context) => {
  const { attention } = await served(context);
  const [requirements] = (await attention()).formats;
  assert.equal(requirements.count, 2);
  assert.deepEqual(requirements.artifacts.map((artifact) => [artifact.path, labelOf(artifact)]), [[OLD, "api"], [OLD, "workspace"]]);
  assert.ok(requirements.artifacts.every((artifact) => artifact.findings.some((finding) => finding.rule === "requirements.header")));
});

test("clause 55: Attention follows a store copy that changes and drops it once it conforms", async (context) => {
  const { place, web, attention } = await served(context);
  const current = await storeRead(web.call, OLD);
  const changed = { version: await storeFile(place, WORKSPACE_OLD, `${current.content}A later line.\n`) };
  assert.equal((await attention()).formats[0].count, 2, "a changed copy still counts");
  await storeWrite(web.call, OLD, REQUIREMENT, { expectedVersion: changed.version });
  const fixed = (await attention()).formats[0];
  assert.deepEqual(fixed.artifacts.map((artifact) => [artifact.path, labelOf(artifact)]), [[OLD, "api"]], "a conforming copy is no longer counted");
});
