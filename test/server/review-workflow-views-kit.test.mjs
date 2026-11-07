import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Requirements: docs/requirements/review-app-ui-kit.md §1, §2, §12.
// The workflow views and their shared helpers compose kit elements and take every value from the design values.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PUBLIC = "src/server/review/public";
const FILES = [
  "views/attention.js",
  "views/roadmap.js",
  "views/initiative.js",
  "views/slice.js",
  "views/claims.js",
  "views/components.js",
  "views/run-totals.js",
  "views/code-location.js",
  "views/library.js",
  "views/util.js",
  "styles/workflow-views.css"
];

test("the workflow views neither hold raw design values nor style or write controls around the kit", async () => {
  const { checkKitUsage } = await import(path.join(ROOT, "scripts/review-kit/kit-guard.mjs"));
  const findings = await checkKitUsage({ root: ROOT, files: FILES.map((file) => `${PUBLIC}/${file}`) });
  assert.deepEqual(findings.map((finding) => `${finding.file}:${finding.line}: ${finding.rule} ${finding.value}`), []);
});

test("the area stylesheet styles/workflow-views.css is served and loaded by the review page after the kit", async (context) => {
  const { mkdir, mkdtemp, realpath, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  if (!process.env.PLUGIN_DATA) process.env.PLUGIN_DATA = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-area-data-")));
  const { startReviewServer } = await import(path.join(ROOT, "dist/server/review/review-server.mjs"));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-area-")));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  context.after(async () => {
    await review.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = review.baseUrl.replace(/\/$/, "");
  const sheet = await fetch(`${base}/styles/workflow-views.css`);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers.get("content-type"), "text/css; charset=utf-8");
  const head = (await (await fetch(`${base}/`)).text()).split("</head>")[0];
  const kit = head.indexOf('href="./kit/kit.css"');
  const area = head.indexOf('href="./styles/workflow-views.css"');
  assert.ok(kit >= 0 && area > kit, "the page loads styles/workflow-views.css after kit/kit.css");
});
