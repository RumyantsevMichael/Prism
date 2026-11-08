// Probe: a write session held in a tab's sessionStorage, obtained from a one-time grant in the URL fragment,
// survives a reload of that tab, is absent from a second tab opened on the same URL, and never reaches the server or history through the fragment.
// Run: node docs/plans/initiative-settings-actions/probes/tab-write-session.mjs (needs Playwright and Chrome).
import { createServer } from "node:http";
import { createRequire } from "node:module";
const require = createRequire("/opt/node-tools/node_modules/noop.js");
const { chromium } = require("playwright");

const seen = [];
const page = `<!doctype html><script>
const grant = new URLSearchParams(location.hash.slice(1)).get("write");
if (grant) { sessionStorage.setItem("w", "token-for-" + grant); history.replaceState(null, "", location.pathname); }
window.applyResult = fetch("./api/apply", { method: "POST", headers: { "Content-Type": "application/json", ...(sessionStorage.getItem("w") ? { "X-Prism-Write": sessionStorage.getItem("w") } : {}) }, body: "{}" }).then((r) => r.text());
</script>`;
const server = createServer((request, response) => {
  seen.push({ url: request.url, write: request.headers["x-prism-write"] ?? null });
  response.writeHead(200, { "Content-Type": "text/html", "Referrer-Policy": "no-referrer" });
  response.end(request.url.endsWith("/api/apply") ? "ok" : page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/session/abc/p/1/`;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome" });
const context = await browser.newContext();
const first = await context.newPage();
await first.goto(`${base}#write=G1`);
await first.evaluate(() => window.applyResult);
const afterGrantUrl = first.url();
await first.reload();
await first.evaluate(() => window.applyResult);
const second = await context.newPage();
await second.goto(base);
await second.evaluate(() => window.applyResult);
const history = await first.evaluate(() => history.length);
await browser.close();
server.close();
console.log(JSON.stringify({ afterGrantUrl, historyLength: history, requests: seen }, null, 1));
