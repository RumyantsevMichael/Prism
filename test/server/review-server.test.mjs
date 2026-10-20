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
    assert.match(pageSource, /id="tabs"/);
    const stylesheet = await (await fetchReview(`${review.baseUrl}/review.css`)).text();
    assert.match(stylesheet, /prefers-reduced-motion/);
    const client = await (await fetchReview(`${review.baseUrl}/review.js`)).text();
    assert.match(client, /data-action="zoom-in"/);
    assert.match(client, /PlantUML source copied/);
    assert.match(client, /saveSession/);
    assert.match(client, /EventSource/);
    assert.doesNotMatch(client, /meta-pill live/, "the page shows a banner when refresh fails instead of a permanent Live pill");
    assert.doesNotMatch(pageSource, /Auto refresh/);
    assert.match(pageSource, /id="connection"/);
    const index = await (await fetchReview(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.workspace, { repository: path.basename(projectRoot), worktree: null, branch: null });
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
    assert.deepEqual(openedUrls, [presented.url]);
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
    assert.deepEqual(await session.json(), { openTabs: ["docs/roadmap.md", "docs/roadmap.puml"], activeTab: "docs/roadmap.md", previewTab: null, agentTabs: ["docs/roadmap.md", "docs/roadmap.puml"], revision: 1 });
    const updated = await fetchReview(`${review.baseUrl}/api/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openTabs: ["docs/roadmap.puml"] })
    });
    assert.deepEqual(await updated.json(), { openTabs: ["docs/roadmap.puml"], activeTab: "docs/roadmap.puml", previewTab: null, agentTabs: ["docs/roadmap.puml"], revision: 2 });
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
    assert.deepEqual((await first.next()).data, { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], revision: 0 });
    assert.deepEqual((await second.next()).data, { openTabs: [], activeTab: null, previewTab: null, agentTabs: [], revision: 0 });

    await review.setOpenTabs(["docs/roadmap.md", "docs/roadmap.puml"]);
    const update = { openTabs: ["docs/roadmap.md", "docs/roadmap.puml"], activeTab: "docs/roadmap.md", previewTab: null, agentTabs: ["docs/roadmap.md", "docs/roadmap.puml"], revision: 1 };
    assert.deepEqual((await first.next()).data, update);
    assert.deepEqual((await second.next()).data, update);
  } finally {
    await review.close();
    for (const stream of streams) {
      stream.close();
    }
  }
});
