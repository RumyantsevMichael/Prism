import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Requirements: docs/requirements/review-app-ui-kit.md §1, §6.
// The kit's files are fetched from a running review server the way the page fetches them.

const privateData = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-assets-data-")));
process.env.PLUGIN_DATA = privateData;
delete process.env.CLAUDE_PLUGIN_DATA;
const { startReviewServer } = await import("../../dist/server/review/review-server.mjs");
test.after(() => rm(privateData, { recursive: true, force: true }));

async function serve(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-kit-assets-")));
  await mkdir(path.join(root, ".prism"), { recursive: true });
  await writeFile(path.join(root, ".prism", "workflow.md"), "## Paths\n- Plans: docs/plans/\n");
  const review = await startReviewServer({ projectRoot: root, openBrowser: async () => false });
  context.after(async () => {
    await review.close();
    await rm(root, { recursive: true, force: true });
  });
  return review.baseUrl.replace(/\/$/, "");
}

// The raw path keeps encoded separators and dot segments, which a URL object would change before the request.
function get(url) {
  const target = /^http:\/\/([^/:]+):(\d+)(\/.*)$/.exec(url);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: target[1], port: Number(target[2]), path: target[3], method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("the kit's stylesheets, scripts, and catalog page are served with their types and the page's security headers", async (context) => {
  const base = await serve(context);
  const page = await get(`${base}/`);
  for (const [file, type] of [["kit/tokens.css", "text/css; charset=utf-8"], ["kit/kit.css", "text/css; charset=utf-8"], ["kit/boot.js", "text/javascript; charset=utf-8"], ["kit/kit.js", "text/javascript; charset=utf-8"]]) {
    const response = await get(`${base}/${file}`);
    assert.equal(response.status, 200, `${file} is served`);
    assert.equal(response.headers["content-type"], type, `${file} is typed ${type}`);
    assert.equal(response.headers["content-security-policy"], page.headers["content-security-policy"], `${file} carries the page's policy`);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.body.toString("utf8"), await readFile(new URL(`../../dist/server/review/public/${file}`, import.meta.url), "utf8"));
  }
});

test("the fonts and their licenses are served from the kit", async (context) => {
  const base = await serve(context);
  const tokens = (await get(`${base}/kit/tokens.css`)).body.toString("utf8");
  const fonts = [...new Set([...tokens.matchAll(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/g)].map((match) => match[1]))];
  assert.ok(fonts.length >= 2, "tokens.css names the font files");
  for (const font of fonts) {
    const response = await get(new URL(font, `${base}/kit/`).href);
    assert.equal(response.status, 200, `${font} is served`);
    assert.equal(response.headers["content-type"], "font/woff2");
    assert.equal(response.body.subarray(0, 4).toString("latin1"), "wOF2");
  }
  for (const license of ["OFL-Inter.txt", "OFL-JetBrains-Mono.txt"]) {
    const response = await get(`${base}/kit/fonts/${license}`);
    assert.equal(response.status, 200, `${license} is served`);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.match(response.body.toString("utf8"), /SIL OPEN FONT LICENSE/i);
  }
});

test("the catalog page is served at kit/catalog", async (context) => {
  const base = await serve(context);
  const response = await get(`${base}/kit/catalog`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.match(response.body.toString("utf8"), /<!doctype html>/i);
});

test("a kit or styles path that is missing, leaves its folder, or has another extension answers 404", async (context) => {
  const base = await serve(context);
  for (const route of ["kit/missing.css", "kit/..%2Freview.js", "kit/%2e%2e%2Fkit.css", "kit/fonts/..%2F..%2Freview.js", "kit/tokens.css.map", "kit/tokens", "styles/missing.css", "styles/..%2Freview.css", "styles/shell.js", "kit/..%2F..%2F..%2F..%2Fetc%2Fpasswd", "kit/%00tokens.css"]) {
    assert.equal((await get(`${base}/${route}`)).status, 404, `${route} answers 404`);
  }
});

test("the review page loads the boot script, the design values, the kit, and the area stylesheets in order before its own script", async (context) => {
  const base = await serve(context);
  const html = (await get(`${base}/`)).body.toString("utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const boot = head.search(/<script src="\.\/kit\/boot\.js"><\/script>/);
  assert.ok(boot >= 0, "the head loads kit/boot.js as a classic script");
  const sheets = [...head.matchAll(/<link rel="stylesheet" href="\.\/([^"]+)">/g)].map((match) => ({ href: match[1], at: match.index }));
  assert.deepEqual(sheets.slice(0, 2).map((sheet) => sheet.href), ["kit/tokens.css", "kit/kit.css"], "tokens.css and kit.css are the first stylesheets");
  assert.ok(boot < sheets[0].at, "the boot script comes before the stylesheets");
  for (const sheet of sheets.slice(2)) assert.match(sheet.href, /^(?:styles\/[a-z-]+\.css|review\.css)$/, `${sheet.href} is an area stylesheet`);
  const kit = html.search(/<script type="module" src="\.\/kit\/kit\.js"><\/script>/);
  const review = html.search(/<script type="module" src="\.\/review\.js"><\/script>/);
  assert.ok(kit >= 0, "the page loads kit/kit.js as a module");
  assert.ok(review > kit, "kit/kit.js loads before review.js");
  assert.doesNotMatch(head, /name="theme-color" content="#/, "the page sets its theme color from the design values rather than a literal");
});
