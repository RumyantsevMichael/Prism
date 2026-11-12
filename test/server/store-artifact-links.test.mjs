import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { markdownLinks, resolveLinks } from "../../src/server/review/artifact-links.mjs";
import { linkTargets, renderText } from "../../src/server/review/public/views/markdown.js";
import { artifactKinds, parseWorkflowConfig } from "../../src/server/workflow/workflow-config.mjs";
import { git, isolateGit, networkStore, place, server, startApp, storeCheckout, workspaceId, writeArtifact } from "./fixtures/workspace-view.mjs";
import { launch, settle, skip } from "./fixtures/kit-browser.mjs";

// A workspace page's store artifacts: one comment target per artifact, the server's links agreeing with the page's renderer, and a palette that lists each store artifact once by scope.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

async function workspace(context) {
  const where = await place(context);
  const store = await networkStore(where);
  const apiRoot = await storeCheckout(context, where, "api", store.url, { components: ["- billing: packages/billing"] });
  const webRoot = await storeCheckout(context, where, "web", store.url);
  const api = await server(context, where, apiRoot);
  const web = await server(context, where, webRoot);
  await writeArtifact(api, "docs/requirements/billing.md", "# Billing\n", { scope: "repository" });
  await writeArtifact(api, "docs/requirements/totals.md", "# Totals\n", { scope: "component", component: "billing" });
  await writeArtifact(api, "docs/requirements/shared.md", "# Shared\n", { scope: "repository" });
  await writeArtifact(web, "docs/requirements/shared.md", "# Shared\n", { scope: "repository" });
  const prism = await startApp(context, where);
  await prism.register(apiRoot);
  return { prism, id: workspaceId(store.identity) };
}

test("an artifact target names a store artifact only under the label of the scope that holds it", async (context) => {
  const { prism, id } = await workspace(context);
  git(process.cwd(), "config", "--global", "user.name", "Ada Reviewer");
  git(process.cwd(), "config", "--global", "user.email", "ada@example.invalid");
  context.after(() => { git(process.cwd(), "config", "--global", "--unset", "user.name"); git(process.cwd(), "config", "--global", "--unset", "user.email"); });
  await prism.grant();
  const actions = (target) => prism.get(`/w/${id}/api/actions?target=${encodeURIComponent(target)}`);
  for (const alias of ["artifact:workspace:repositories/api/requirements/billing.md", "artifact:api:components/billing/requirements/totals.md", "artifact:web:requirements/billing.md"]) {
    const listed = await actions(alias);
    assert.equal(listed.status, 404, `${alias}: ${listed.body}`);
    assert.equal(listed.json.code, "unknown_target", alias);
    const applied = await prism.post(`/w/${id}/api/actions/apply`, { action: "artifact.comment", target: alias, input: { line: "1", text: "Under another label" }, revision: "0" });
    assert.notEqual(applied.status, 200, `${alias} takes no comment: ${applied.body}`);
  }
  const target = "artifact:api:requirements/billing.md";
  const listed = await actions(target);
  assert.equal(listed.status, 200, listed.body);
  const action = listed.json.actions.find((item) => item.id === "artifact.comment");
  const applied = await prism.post(`/w/${id}/api/actions/apply`, { action: "artifact.comment", target, input: { line: "1", text: "Looks right" }, revision: action.revision });
  assert.equal(applied.status, 200, applied.body);
  const component = await actions("artifact:api/billing:requirements/totals.md");
  assert.equal(component.status, 200, component.body);
});

const MIXED = [
  "# Mixed",
  "",
  "A [plain](plain.md) link, an image ![diagram](diagram.png), and `[inline](code.md)` code.",
  "",
  "~~~text",
  "[in tilde fence](fenced.md)",
  "```",
  "[still fenced](fenced-too.md)",
  "~~~",
  "",
  "```",
  "[in backtick fence](ticked.md)",
  "~~~",
  "```",
  "",
  "- a list [item](item.md)",
  "| a | b |",
  "| - | - |",
  "| [cell](cell.md) | x |",
  "> a [quote](quote.md)"
].join("\n");

test("the server lists exactly the links the page's renderer renders, never an image or a fenced link", () => {
  assert.deepEqual(markdownLinks(MIXED).map((link) => link.href), ["plain.md", "item.md", "cell.md", "quote.md"]);
  const links = resolveLinks({ content: MIXED, location: "requirements/mixed.md", kinds: artifactKinds(parseWorkflowConfig("")), has: (location) => location === "requirements/plain.md" });
  const html = renderText("store:requirements/mixed.md", MIXED, { links: linkTargets(links), isKnown: () => false });
  assert.doesNotMatch(html, /doc-link-missing/, "no link falls back to the checkout's resolver");
  assert.equal((html.match(/data-link="unresolved"/g) ?? []).length, links.filter((link) => link.resolved === false).length);
  assert.equal((html.match(/data-doc-link=/g) ?? []).length, links.filter((link) => link.resolved === true).length);
  assert.doesNotMatch(html, /fenced\.md"|ticked\.md"|diagram\.png"/, "fenced links and images render as no link");
  assert.match(html, /an image diagram,/, "an image shows its alt text");
});

test("the palette lists each store artifact once, follows the scope filter, and names each row's scope", { skip }, async (context) => {
  const { prism, id } = await workspace(context);
  const browser = await launch(context);
  const rows = async (scopes) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${prism.viewer}/w/${id}/review${scopes ? `?scopes=${scopes}` : ""}`);
    await settle(page);
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.waitFor();
    await page.keyboard.type("shared");
    await palette.getByRole("option").first().waitFor();
    await settle(page);
    const found = [];
    // A full-text match is its own group, Text in documents; every other row names something the palette jumps to.
    for (const option of await palette.locator('[role="group"]:not([aria-label="Text in documents"])').getByRole("option").all()) {
      const text = await option.innerText();
      if (!/shared/i.test(text)) continue;
      found.push(await option.locator("[data-scope-label]").allTextContents());
    }
    await page.close();
    return found.map((labels) => labels.join(",")).sort();
  };
  assert.deepEqual(await rows(null), ["api", "web"], "each scope's shared.md is one row that names its scope");
  assert.deepEqual(await rows("web"), ["web"], "the scope filter narrows every palette entry");
});
