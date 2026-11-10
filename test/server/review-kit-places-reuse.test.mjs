import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// The places screens draw their reusable pieces with the kit: no screen outside kit/ writes or styles a kit element's inner parts,
// and the kit's catalog shows each kit class those screens use.

const PUBLIC = path.join(path.dirname(new URL(import.meta.url).pathname), "../../src/server/review/public");

async function files(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await files(full));
    else if (/\.(js|css|html)$/.test(entry.name)) found.push(full);
  }
  return found;
}

test("no screen outside the kit writes or styles a kit element's inner parts", async () => {
  const outside = (await files(PUBLIC)).filter((file) => !path.relative(PUBLIC, file).startsWith("kit/"));
  const inner = ["prism-inbox-tile", "prism-breadcrumbs-item", "prism-breadcrumbs-separator"];
  for (const file of outside) {
    const text = await readFile(file, "utf8");
    for (const name of inner) assert.ok(!text.includes(name), `${path.relative(PUBLIC, file)} names ${name}`);
  }
});

test("the screens' sidebar headings, notes, flags, rows, tables, and page lines are kit pieces with catalog specimens", async () => {
  const catalog = await readFile(path.join(PUBLIC, "kit/catalog.js"), "utf8");
  const kit = await readFile(path.join(PUBLIC, "kit/kit.css"), "utf8");
  for (const name of ["prism-group-heading", "prism-group-count", "prism-foot-note", "prism-tree-flag", "is-muted", "prism-rows", "<prism-row ", "<prism-page-sub", "prism-page-subs", "<prism-lib-table", "prism-lib-group", "prism-lib-nothing", "current-only"]) {
    assert.ok(catalog.includes(name), `the catalog shows ${name}`);
  }
  assert.ok(!/<prism-badge[^>]*>Blocked</.test(catalog), "the catalog draws Blocked as the Work sidebar does");
  for (const name of [".prism-group-heading", ".prism-foot-note", "prism-row {", "prism-page-sub {", "prism-lib-table {", "prism-breadcrumbs[current-only"]) assert.ok(kit.includes(name), `kit.css styles ${name}`);
  const styles = (await Promise.all((await readdir(path.join(PUBLIC, "styles"))).map((name) => readFile(path.join(PUBLIC, "styles", name), "utf8")))).join("\n");
  for (const name of [".nav-section", ".nav-foot", ".attention-row", ".knowledge-row", ".knowledge-lead", ".superseded-line", ".attention-filter"]) assert.ok(!styles.includes(name), `styles/ no longer draws ${name}`);
});
