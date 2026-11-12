import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startReviewServer } from "../../dist/server/review/review-server.mjs";

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

function fetchReview(url, options = {}) {
  return new Promise((resolve, reject) => {
    const { body, ...requestOptions } = options;
    const request = http.request(url, requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          text: async () => body,
          json: async () => JSON.parse(body)
        });
      });
    });
    request.once("error", reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function openEventStream(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.setEncoding("utf8");
      let buffer = "";
      const events = [];
      const waiters = [];
      let closed = false;
      const rejectWaiters = (error) => {
        while (waiters.length) {
          waiters.shift().reject(error);
        }
      };
      const deliver = (event) => {
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve(event);
        } else {
          events.push(event);
        }
      };
      response.on("data", (chunk) => {
        buffer += chunk;
        let separator;
        while ((separator = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (data) {
            deliver({ event: block.match(/^event: (.+)$/m)?.[1] ?? "message", data: JSON.parse(data) });
          }
        }
      });
      response.on("error", (error) => {
        if (!closed) {
          rejectWaiters(error);
        }
      });
      response.on("end", () => {
        if (!closed) {
          rejectWaiters(new Error("The event stream ended."));
        }
      });
      resolve({
        status: response.statusCode,
        headers: response.headers,
        next() {
          if (events.length) {
            return Promise.resolve(events.shift());
          }
          return new Promise((resolveNext, rejectNext) => waiters.push({ resolve: resolveNext, reject: rejectNext }));
        },
        close() {
          closed = true;
          request.destroy();
        }
      });
    });
    request.once("error", reject);
  });
}

test("lists source artifacts and returns diagram source", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    assert.match(review.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    const index = await (await fetchReview(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.artifacts, ["docs/roadmap.md", "docs/roadmap.puml"]);
    const artifact = await (await fetchReview(`${review.baseUrl}/api/artifact?path=docs%2Froadmap.md`)).json();
    assert.equal(artifact.diagrams[0].path, "docs/roadmap.puml");
    assert.match(artifact.diagrams[0].source, /A --> B/);
  } finally {
    await review.close();
  }
});

test("refuses requests that name an untrusted host", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    const port = new URL(review.baseUrl).port;
    const rebound = await fetchReview(`${review.baseUrl}/api/index`, { headers: { Host: `attacker.example:${port}` } });
    assert.equal(rebound.status, 403);
    const named = await fetchReview(`${review.baseUrl.replace("127.0.0.1", "localhost")}/api/index`, { lookup: (hostname, options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) });
    assert.equal(named.status, 200);
  } finally {
    await review.close();
  }
});

test("rejects paths outside the project", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    const response = await fetchReview(`${review.baseUrl}/api/artifact?path=..%2Foutside.md`);
    assert.equal(response.status, 400);
  } finally {
    await review.close();
  }
});

test("requires the unguessable session path", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    const url = new URL(review.baseUrl);
    const response = await fetchReview(`${url.origin}/api/index`);
    assert.equal(response.status, 404);
  } finally {
    await review.close();
  }
});

test("serves the browser runtime without an image endpoint", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    const page = await fetchReview(review.reviewUrl("docs/roadmap.md"));
    assert.match(page.headers["content-security-policy"], /wasm-unsafe-eval/);
    const pageSource = await page.text();
    assert.match(pageSource, /viz-global\.js/);
    assert.match(pageSource, /id="palette-input"/);
    assert.match(pageSource, /id="jump"/);
    assert.match(pageSource, /aria-live="polite"/);
    assert.match(pageSource, /id="page-bar"/);
    const stylesheet = await (await fetchReview(`${review.baseUrl}/kit/tokens.css`)).text();
    assert.match(stylesheet, /prefers-reduced-motion/);
    const client = await (await fetchReview(`${review.baseUrl}/review.js`)).text();
    assert.match(client, /data-action="zoom-in"/);
    assert.match(client, /PlantUML source copied/);
    assert.match(client, /saveSession/);
    assert.match(client, /createEventRelay/, "the page follows the origin's shared event stream");
    assert.match(await (await fetchReview(`${review.baseUrl}/views/event-relay.js`)).text(), /new Source\(streamUrl\)/, "the relay serves and opens the shared stream");
    assert.doesNotMatch(client, /meta-pill live/, "the page shows a banner when refresh fails instead of a permanent Live pill");
    assert.doesNotMatch(pageSource, /Auto refresh/);
    assert.match(pageSource, /id="connection"/);
    const index = await (await fetchReview(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.workspace, { repository: path.basename(projectRoot), worktree: null, branch: null, detached: false });
    assert.match(pageSource, /rel="icon" href="\.\/favicon\.svg"/);
    const favicon = await fetchReview(`${review.baseUrl}/favicon.svg`);
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers["content-type"], /^image\/svg\+xml/);
    assert.match(pageSource, /class="brand-mark" src="\.\/prism-mark\.svg"/);
    const mark = await fetchReview(`${review.baseUrl}/prism-mark.svg`);
    assert.equal(mark.status, 200);
    assert.match(mark.headers["content-type"], /^image\/svg\+xml/);
    const c4 = await fetchReview(`${review.baseUrl}/vendor/c4.min.js`);
    assert.equal(c4.status, 200);
    const image = await fetchReview(`${review.baseUrl}/render/svg?source=docs%2Froadmap.puml`);
    assert.equal(image.status, 404);
  } finally {
    await review.close();
  }
});

test("searches the text of listed artifacts only", async (context) => {
  const projectRoot = await fixture(context);
  await writeFile(path.join(projectRoot, "docs", "notes.md"), "# Notes\n\nThe total retry deadline bounds every call.\n");
  await writeFile(path.join(projectRoot, "secrets", "private.md"), "# Private\n\nThe total retry deadline is secret.\n");
  const review = await startReviewServer({ projectRoot });
  try {
    const search = async (query) => (await fetchReview(`${review.baseUrl}/api/search?q=${encodeURIComponent(query)}`)).json();
    const found = await search("RETRY deadline");
    assert.deepEqual(found.results.map((result) => result.path), ["docs/notes.md"], "an unlisted folder is never searched");
    assert.deepEqual(found.results[0].matches, [{ line: 3, text: "The total retry deadline bounds every call." }]);
    assert.deepEqual((await search("deadline nowhere")).results, [], "every term must occur in the file");
    assert.deepEqual((await search("a")).results, [], "a one-letter query matches nothing");
  } finally {
    await review.close();
  }
});

test("uses an injected browser opener when it presents a review", async (context) => {
  const openedUrls = [];
  const projectRoot = await fixture(context);
  const review = await startReviewServer({
    projectRoot,
    openBrowser(url) {
      openedUrls.push(url);
      return true;
    }
  });
  try {
    const presented = await review.open("docs/roadmap.md");
    assert.equal(presented.opened, true);
    // The opened URL is the presented URL with a one-time write grant in its fragment.
    assert.equal(openedUrls.length, 1);
    const opened = new URL(openedUrls[0]);
    assert.match(new URLSearchParams(opened.hash.slice(1)).get("write"), /^[A-Za-z0-9_-]{43}$/);
    opened.hash = "";
    assert.equal(opened.href, presented.url);
  } finally {
    await review.close();
  }
});

test("an agent's group name gathers its presented tabs into one named group that the page can collapse, rearrange, and leave", async (context) => {
  const projectRoot = await fixture(context);
  await writeFile(path.join(projectRoot, "docs", "notes.md"), "# Notes\n");
  await writeFile(path.join(projectRoot, "docs", "plan.md"), "# Plan\n");
  const review = await startReviewServer({ projectRoot, openBrowser: async () => true });
  const put = async (body) => fetchReview(`${review.baseUrl}/api/session`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    await review.open(["docs/notes.md"]);
    await review.open(["docs/roadmap.md", "docs/roadmap.puml"], { group: "  Retry   requests " });
    let session = review.getSession();
    assert.deepEqual(session.groups, [{ name: "Retry requests", tabs: ["docs/roadmap.md", "docs/roadmap.puml"], collapsed: false }]);
    // A tab presented later under the same name joins the group, and the group's tabs stay side by side.
    const reordered = await put({ openTabs: ["docs/roadmap.md", "docs/notes.md", "docs/roadmap.puml"], groups: [{ ...session.groups[0], collapsed: true }] });
    session = await reordered.json();
    assert.deepEqual(session.openTabs, ["docs/roadmap.md", "docs/roadmap.puml", "docs/notes.md"]);
    assert.equal(session.groups[0].collapsed, true);
    await review.open(["docs/plan.md"], { group: "Retry requests" });
    session = review.getSession();
    assert.deepEqual(session.openTabs, ["docs/roadmap.md", "docs/roadmap.puml", "docs/plan.md", "docs/notes.md"]);
    assert.deepEqual(session.groups, [{ name: "Retry requests", tabs: ["docs/roadmap.md", "docs/roadmap.puml", "docs/plan.md"], collapsed: false }], "a presentation shows its group expanded");
    // A tab presented under another name moves into that group.
    await review.open(["docs/plan.md"], { group: "Indexing" });
    assert.deepEqual(review.getSession().groups.map((group) => [group.name, group.tabs]), [["Retry requests", ["docs/roadmap.md", "docs/roadmap.puml"]], ["Indexing", ["docs/plan.md"]]]);
    // A tab that leaves a group keeps its place; closing a group's last tab removes the group.
    session = await (await put({ openTabs: ["docs/roadmap.md", "docs/roadmap.puml", "docs/notes.md"], groups: [{ name: "Retry requests", tabs: ["docs/roadmap.md"] }] })).json();
    assert.deepEqual(session.groups, [{ name: "Retry requests", tabs: ["docs/roadmap.md"], collapsed: false }]);
    assert.deepEqual(session.openTabs, ["docs/roadmap.md", "docs/roadmap.puml", "docs/notes.md"]);
    // A grouped tab is never the preview, so the next ordinary open does not replace it.
    session = await (await put({ openTabs: ["docs/roadmap.md", "docs/roadmap.puml", "docs/notes.md"], previewTab: "docs/roadmap.md" })).json();
    assert.equal(session.previewTab, null);
    for (const groups of [[{ name: "", tabs: ["docs/roadmap.md"] }], [{ name: "x".repeat(61), tabs: ["docs/roadmap.md"] }], [{ name: "A", tabs: ["docs/roadmap.md"] }, { name: "A", tabs: ["docs/notes.md"] }], [{ name: "A", tabs: ["docs/roadmap.md"] }, { name: "B", tabs: ["docs/roadmap.md"] }], [{ name: "A", tabs: ["docs/plan.md"] }], [{ name: "A", tabs: [] }], [{ name: "A", tabs: ["docs/roadmap.md"], collapsed: "yes" }], "A"]) {
      assert.equal((await put({ openTabs: ["docs/roadmap.md", "docs/roadmap.puml", "docs/notes.md"], groups })).status, 400, JSON.stringify(groups));
    }
    await assert.rejects(review.open(["docs/notes.md"], { group: " " }), /tab group name/);
  } finally {
    await review.close();
  }
});

test("stores agent-selected tabs and exposes them to the viewer", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    await review.setOpenTabs(["docs/roadmap.md", "docs/roadmap.puml"]);
    assert.deepEqual(review.getOpenTabs(), ["docs/roadmap.md", "docs/roadmap.puml"]);
    const session = await fetchReview(`${review.baseUrl}/api/session`);
    assert.deepEqual(await session.json(), { openTabs: ["docs/roadmap.md", "docs/roadmap.puml"], activeTab: "docs/roadmap.md", previewTab: null, agentTabs: ["docs/roadmap.md", "docs/roadmap.puml"], groups: [], activeSource: "agent", revision: 1 });
    const updated = await fetchReview(`${review.baseUrl}/api/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openTabs: ["docs/roadmap.puml"] })
    });
    assert.deepEqual(await updated.json(), { openTabs: ["docs/roadmap.puml"], activeTab: "docs/roadmap.puml", previewTab: null, agentTabs: ["docs/roadmap.puml"], groups: [], activeSource: "page", revision: 2 });
    assert.deepEqual(review.getOpenTabs(), ["docs/roadmap.puml"]);
    const invalidActive = await fetchReview(`${review.baseUrl}/api/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openTabs: ["docs/roadmap.puml"], activeTab: "docs/roadmap.md" })
    });
    assert.equal(invalidActive.status, 400);
    await assert.rejects(review.setOpenTabs(["secrets/private.md"]), /not available for review/);
  } finally {
    await review.close();
  }
});

// A browser holds one stream for all its review tabs: the stream names itself first, and each tab joins it for its own page.
test("a shared viewer stream carries the session of each page a tab joined it for, and counts each joined tab", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  const post = (route, body, headers = { "Content-Type": "application/json" }) => fetch(`${review.baseUrl}/api/events/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  let shared;
  try {
    shared = await openEventStream(`${review.baseUrl}/api/events/shared`);
    assert.equal(shared.status, 200);
    const hub = await shared.next();
    assert.equal(hub.event, "hub");
    assert.match(hub.data.stream, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(review.viewerCount(), 0, "an open stream that no tab joined counts no tab");

    const page = `${new URL(review.baseUrl).pathname}/`;
    const joined = await post("join", { stream: hub.data.stream, tab: "first-tab-0001" });
    assert.equal(joined.status, 200);
    assert.deepEqual(await joined.json(), { project: page });
    assert.deepEqual(await shared.next(), { event: "session", data: { project: page, data: { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], groups: [], activeSource: null, revision: 0 } } });
    assert.equal((await post("join", { stream: hub.data.stream, tab: "second-tab-002" })).status, 200);
    await shared.next();
    assert.equal(review.viewerCount(), 2);

    await review.setOpenTabs(["docs/roadmap.md"]);
    const update = await shared.next();
    assert.equal(update.event, "session");
    assert.deepEqual(update.data.data.openTabs, ["docs/roadmap.md"], "one change reaches the stream once, however many of its tabs show the page");
    assert.equal(update.data.project, page);

    assert.equal((await post("leave", { stream: hub.data.stream, tab: "second-tab-002" })).status, 200);
    assert.equal(review.viewerCount(), 1);
    assert.equal((await post("join", { stream: "no-such-stream", tab: "third-tab-0003" })).status, 404, "a tab cannot join a stream that is gone");
    assert.equal((await post("join", { stream: hub.data.stream, tab: "x" })).status, 404, "a malformed tab id is refused");
    assert.equal((await post("join", { stream: hub.data.stream, tab: "fourth-tab-004" }, { "Content-Type": "text/plain" })).status, 403, "a join must come from the review page as JSON");

    shared.close();
    for (let tries = 0; tries < 50 && review.viewerCount() > 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(review.viewerCount(), 0, "the tabs of a closed stream no longer count");
  } finally {
    shared?.close();
    await review.close();
  }
});

test("broadcasts session changes to every connected viewer page", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  const streams = [];
  try {
    const first = await openEventStream(`${review.baseUrl}/api/events`);
    const second = await openEventStream(`${review.baseUrl}/api/events`);
    streams.push(first, second);
    assert.equal(first.status, 200);
    assert.match(first.headers["content-type"], /text\/event-stream/);
    assert.deepEqual((await first.next()).data, { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], groups: [], activeSource: null, revision: 0 });
    assert.deepEqual((await second.next()).data, { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], groups: [], activeSource: null, revision: 0 });

    await review.setOpenTabs(["docs/roadmap.md", "docs/roadmap.puml"]);
    const update = { openTabs: ["docs/roadmap.md", "docs/roadmap.puml"], activeTab: "docs/roadmap.md", previewTab: null, agentTabs: ["docs/roadmap.md", "docs/roadmap.puml"], groups: [], activeSource: "agent", revision: 1 };
    assert.deepEqual((await first.next()).data, update);
    assert.deepEqual((await second.next()).data, update);
  } finally {
    await review.close();
    for (const stream of streams) {
      stream.close();
    }
  }
});

test("a file written after the project was listed is served at once, and the index lists it", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot });
  try {
    assert.deepEqual((await (await fetchReview(`${review.baseUrl}/api/index`)).json()).artifacts, ["docs/roadmap.md", "docs/roadmap.puml"]);
    await writeFile(path.join(projectRoot, "docs", "later.md"), "# Later\n");
    assert.equal((await fetchReview(`${review.baseUrl}/api/artifact?path=docs%2Flater.md`)).status, 200, "a requested file the kept listing lacks lists the project again");
    assert.ok((await (await fetchReview(`${review.baseUrl}/api/index`)).json()).artifacts.includes("docs/later.md"));
    assert.equal((await fetchReview(`${review.baseUrl}/api/artifact?path=docs%2Fmissing.md`)).status, 404);
  } finally {
    await review.close();
  }
});
