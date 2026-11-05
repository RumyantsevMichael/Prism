import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeRuntime, manifestPath, project } from "./fixtures/component-indexes.mjs";

// How get_conservation_evidence pages a search receipt that records components, beyond the acceptance tests of the component-indexes contract.
process.env.PLUGIN_DATA ||= mkdtempSync(path.join(os.tmpdir(), "prism-component-search-receipt-data-"));
process.env.PRISM_NATIVE_ASSET_MANIFEST ||= manifestPath;
const { searchRepositoryConcepts } = await import("../../dist/server/repository-intelligence/semantic-native-provider.mjs");
const { callConservationTool } = await import("../../dist/server/conservation/conservation-tools.mjs");

test("a search receipt's components stay in its metadata and are not named or paged as a section", async (t) => {
  const fixture = await project(t);
  const { runtime } = await fakeRuntime(fixture.storage);
  const found = await searchRepositoryConcepts({ projectRoot: fixture.root, query: "retry the request" }, { runtime, waitMs: 2000 });
  const evidence = (section) => callConservationTool("get_conservation_evidence", { projectRoot: fixture.root, evidenceId: found.receiptId, section });
  await assert.rejects(evidence("observations"), (error) => {
    assert.match(error.message, /has no section observations\. Its sections are /);
    assert.doesNotMatch(error.message.split("Its sections are ")[1], /components/);
    return true;
  });
  // The tool's input refuses components as a section, so the refusal above must not offer it.
  await assert.rejects(evidence("components"), /arguments\.section: must be one of/);
  const page = await evidence("candidates");
  assert.deepEqual(page.components, found.components);
  assert.deepEqual(page.entries.map((candidate) => candidate.name), found.results.map((result) => result.name));
});
