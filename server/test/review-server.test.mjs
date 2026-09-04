import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startReviewServer } from "../review-server.mjs";

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
    const request = https.request(url, { ...requestOptions, rejectUnauthorized: false }, (response) => {
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

test("lists source artifacts and returns diagram source", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    assert.match(review.baseUrl, /^https:\/\/127\.0\.0\.1:/);
    const authority = new X509Certificate(await readFile(review.certificatePath));
    const certificate = new X509Certificate(await readFile(review.serverCertificatePath));
    assert.match(authority.subject, /CN=Prism Local Development CA/);
    assert.equal(authority.ca, true);
    assert.match(certificate.subjectAltName, /DNS:localhost/);
    assert.match(certificate.subjectAltName, /IP Address:127\.0\.0\.1/);
    assert.equal(certificate.checkIssued(authority), true);
    assert.equal(certificate.verify(authority.publicKey), true);
    const index = await (await fetchReview(`${review.baseUrl}/api/index`)).json();
    assert.deepEqual(index.artifacts, ["docs/roadmap.md", "docs/roadmap.puml"]);
    const artifact = await (await fetchReview(`${review.baseUrl}/api/artifact?path=docs%2Froadmap.md`)).json();
    assert.equal(artifact.diagrams[0].path, "docs/roadmap.puml");
    assert.match(artifact.diagrams[0].source, /A --> B/);
  } finally {
    await review.close();
  }
});

test("rejects paths outside the project", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    const response = await fetchReview(`${review.baseUrl}/api/artifact?path=..%2Foutside.md`);
    assert.equal(response.status, 400);
  } finally {
    await review.close();
  }
});

test("requires the unguessable session path", async (context) => {
  const projectRoot = await fixture(context);
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
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
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    const page = await fetchReview(review.reviewUrl("docs/roadmap.md"));
    assert.match(page.headers["content-security-policy"], /wasm-unsafe-eval/);
    const pageSource = await page.text();
    assert.match(pageSource, /viz-global\.js/);
    assert.match(pageSource, /id="artifact-filter"/);
    assert.match(pageSource, /aria-live="polite"/);
    assert.match(pageSource, /id="tabs"/);
    const stylesheet = await (await fetchReview(`${review.baseUrl}/review.css`)).text();
    assert.match(stylesheet, /prefers-reduced-motion/);
    const client = await (await fetchReview(`${review.baseUrl}/review.js`)).text();
    assert.match(client, /data-action="zoom-in"/);
    assert.match(client, /PlantUML source copied/);
    assert.match(client, /saveTabs/);
    const c4 = await fetchReview(`${review.baseUrl}/vendor/c4.min.js`);
    assert.equal(c4.status, 200);
    const image = await fetchReview(`${review.baseUrl}/render/svg?source=docs%2Froadmap.puml`);
    assert.equal(image.status, 404);
  } finally {
    await review.close();
  }
});

test("uses an injected browser opener when it presents a review", async (context) => {
  const openedUrls = [];
  const projectRoot = await fixture(context);
  const review = await startReviewServer({
    projectRoot,
    certificateDirectory: projectRoot,
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
  const review = await startReviewServer({ projectRoot, certificateDirectory: projectRoot });
  try {
    await review.setOpenTabs(["docs/roadmap.md", "docs/roadmap.puml"]);
    assert.deepEqual(review.getOpenTabs(), ["docs/roadmap.md", "docs/roadmap.puml"]);
    const session = await fetchReview(`${review.baseUrl}/api/session`);
    assert.deepEqual(await session.json(), { openTabs: ["docs/roadmap.md", "docs/roadmap.puml"] });
    const updated = await fetchReview(`${review.baseUrl}/api/session`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openTabs: ["docs/roadmap.puml"] })
    });
    assert.deepEqual(await updated.json(), { openTabs: ["docs/roadmap.puml"] });
    assert.deepEqual(review.getOpenTabs(), ["docs/roadmap.puml"]);
    await assert.rejects(review.setOpenTabs(["secrets/private.md"]), /not available for review/);
  } finally {
    await review.close();
  }
});
