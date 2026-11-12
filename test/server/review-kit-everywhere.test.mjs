import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Requirements: docs/requirements/review-app-ui-kit.md §1, §2, §12.
// Contract: docs/plans/review-app-ui-kit/slice.md clauses 8 and 82.
// Feature: docs/Features/F-review-app-ui-kit.feature.
// Once every screen is on the kit, no browser file of the review app holds a raw design value or styles or writes a control around the kit.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = "src/server/review/public";
const run = promisify(execFile);

async function files(directory) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) out.push(...await files(relative));
    else if (/\.(css|js|html)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

test("clauses 8, 82: no browser file of the review app has a guard finding", async () => {
  const { checkKitUsage } = await import(pathToFileURL(path.join(ROOT, "scripts/review-kit/kit-guard.mjs")).href);
  const findings = await checkKitUsage({ root: ROOT, files: await files(PUBLIC) });
  assert.deepEqual(findings.map((finding) => `${finding.file}:${finding.line}: ${finding.rule} ${finding.value}`), []);
  const command = await run(process.execPath, [path.join(ROOT, "scripts/review-kit/kit-guard.mjs"), ROOT]);
  assert.equal(command.stdout.trim(), "", "the guard command finds nothing");
});

test("clause 82: the old stylesheet is gone and the page loads only the kit and area stylesheets", async (context) => {
  for (const copy of [PUBLIC, "dist/server/review/public"]) {
    await assert.rejects(access(path.join(ROOT, copy, "review.css")), `${copy}/review.css is removed`);
  }
  const html = await readFile(path.join(ROOT, PUBLIC, "review.html"), "utf8");
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(sheets.slice(0, 2), ["kit/tokens.css", "kit/kit.css"]);
  for (const sheet of sheets.slice(2)) assert.match(sheet, /^styles\/[a-z-]+\.css$/);
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-everywhere-data-")));
  const { startReviewServer } = await import(pathToFileURL(path.join(ROOT, "dist/server/review/review-server.mjs")).href);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-everywhere-")));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  context.after(async () => {
    await review.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await fetch(`${review.baseUrl.replace(/\/$/, "")}/review.css`)).status, 404);
});
