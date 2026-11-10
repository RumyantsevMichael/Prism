import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { demoProject, serveProject, useAppDirectory } from "./fixtures/kit-browser.mjs";

// A file under a plans folder takes the place of its initiative, whether the initiative has a record, a decision, or only a roadmap entry.

async function writeText(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test("a plans file belongs to its initiative's place, and a plans folder of no initiative to no place", { timeout: 60000 }, async (context) => {
  await useAppDirectory(context);
  const root = await demoProject(context);
  // Index activity for search is envisioned on the roadmap with no record, and Audit administrative actions has shipped.
  await writeText(root, "docs/plans/search-indexing/notes.md", "# Notes\n");
  await writeText(root, "docs/plans/audit-log/notes.md", "# Notes\n");
  await writeText(root, "docs/plans/not-an-initiative/notes.md", "# Notes\n");
  const { base } = await serveProject(context, root);
  const contextOf = async (ref) => {
    const response = await fetch(`${base}/api/context?ref=${encodeURIComponent(ref)}`);
    assert.equal(response.status, 200, ref);
    const body = await response.json();
    return { place: body.place, trail: body.trail.map((crumb) => crumb.label) };
  };
  assert.deepEqual(await contextOf("docs/plans/search-indexing/notes.md"), { place: "roadmap", trail: ["Roadmap", "Index activity for search", "notes.md"] });
  assert.deepEqual(await contextOf("docs/plans/audit-log/notes.md"), { place: "history", trail: ["History", "Audit administrative actions", "notes.md"] });
  assert.equal((await contextOf("docs/plans/retry-hardening/timeout-retries/slice.md")).place, "work");
  assert.deepEqual(await contextOf("docs/plans/not-an-initiative/notes.md"), { place: null, trail: ["Files", "docs/plans/not-an-initiative/notes.md"] });
});
