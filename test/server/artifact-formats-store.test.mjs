import assert from "node:assert/strict";
import test from "node:test";
import { CONFORMING, GLOSSARY, PATHS, REQUIREMENT } from "./fixtures/artifact-formats.mjs";
import { labelOf, otherCheckout, storeProject, storeRead, storeWrite } from "./fixtures/artifact-formats-store.mjs";

// check_artifacts in a project whose requirements, ADRs, and glossaries are store artifacts in several scopes, while its feature files stay in the checkout.

const BROKEN = "# Old notes\n\nThe client retries.\n";
const draft = REQUIREMENT.replace("Status: Approved", "Status: Draft").replace("Approved: 2026-09-04", "Approved: n/a");

async function checked(call, args = {}) {
  const result = await call("check_artifacts", args);
  if (result.error || result.result?.isError) throw new Error(`check_artifacts failed: ${result.text}`);
  return result.value;
}

const keyOf = (entry) => [entry.type, entry.path, labelOf(entry)];

test("clauses 48, 49: a store project's check reads its moved requirements, ADRs, and glossary from the store and its feature files from the checkout, each named by path and scope", async (context) => {
  const { call } = await storeProject(context, { ...CONFORMING, "docs/requirements/old.md": BROKEN });
  const value = await checked(call);
  assert.deepEqual(value.artifacts.map(keyOf), [
    ["requirements", "docs/requirements/old.md", "api"],
    ["requirements", PATHS.requirements, "api"],
    ["adr", PATHS.adr, "api"],
    ["glossary", PATHS.glossary, "api"],
    ["feature", PATHS.feature, null]
  ]);
  const stored = value.artifacts.find((entry) => entry.path === PATHS.requirements);
  assert.deepEqual(stored.scope, (await storeRead(call, PATHS.requirements)).scope, "the scope is the one get_artifact returns");
  assert.equal(value.artifacts.find((entry) => entry.path === "docs/requirements/old.md").conforms, false);
  assert.ok(value.artifacts.filter((entry) => entry.path !== "docs/requirements/old.md").every((entry) => entry.conforms), JSON.stringify(value.artifacts));
});

test("clause 49: an artifact written to the store after the move is checked, and every scope the checkout sees is listed, ordered by type, path, and scope label", async (context) => {
  const { place, call } = await storeProject(context);
  await storeWrite(call, "docs/requirements/billing/invoices.md", BROKEN, { scope: "component", component: "billing" });
  const web = await otherCheckout(context, place);
  await storeWrite(web.call, "docs/requirements/shared.md", REQUIREMENT, { scope: "workspace" });
  // A new file with no folder below the kind folder is created in the workspace unless a scope is named, so web names its own.
  await storeWrite(web.call, "docs/requirements/web-only.md", REQUIREMENT, { scope: "repository" });
  const value = await checked(call, { type: "requirements" });
  assert.deepEqual(value.artifacts.map(keyOf), [
    ["requirements", "docs/requirements/billing/invoices.md", "api/billing"],
    ["requirements", PATHS.requirements, "api"],
    ["requirements", "docs/requirements/shared.md", "workspace"]
  ], "web's own requirement is in a scope that api does not see");
  assert.deepEqual((await checked(web.call, { type: "requirements" })).artifacts.map(keyOf), [
    ["requirements", "docs/requirements/shared.md", "workspace"],
    ["requirements", "docs/requirements/web-only.md", "web"]
  ]);
});

test("clause 50: a given path that two scopes hold is refused as ambiguous until its scope is named, and a scope that holds no file there is missing", async (context) => {
  const { place, call } = await storeProject(context);
  // api's first tool call moves its files into scope api before the workspace holds the same paths, which would keep them in the checkout.
  await storeRead(call, PATHS.glossary);
  const web = await otherCheckout(context, place);
  await storeWrite(web.call, PATHS.glossary, GLOSSARY.replace("Terms used across the payments client.", "Terms used across the workspace."), { scope: "workspace" });
  const ambiguous = await call("check_artifacts", { paths: [PATHS.glossary] });
  assert.equal(ambiguous.value?.code, "artifact_ambiguous", ambiguous.text);
  assert.deepEqual([...ambiguous.value.scopes].sort(), ["api", "workspace"]);
  assert.match(ambiguous.text, /docs\/Glossary\.md/);
  const named = await checked(call, { paths: [{ path: PATHS.glossary, scope: "workspace" }, { path: PATHS.glossary, scope: "repository" }] });
  assert.deepEqual(named.artifacts.map(keyOf), [["glossary", PATHS.glossary, "api"], ["glossary", PATHS.glossary, "workspace"]]);
  const missing = await call("check_artifacts", { paths: [{ path: PATHS.requirements, scope: "workspace" }] });
  assert.equal(missing.value?.code, "artifact_missing", missing.text);
  const feature = await call("check_artifacts", { paths: [{ path: PATHS.feature, scope: "workspace" }] });
  assert.equal(feature.value?.code, "scope_invalid", feature.text);
});

test("clause 51: an unavailable store refuses the check with the store's refusal and never reads the checkout's copies", async (context) => {
  const { call } = await storeProject(context, CONFORMING, { store: "../missing-store" });
  const refused = await call("check_artifacts", {});
  assert.equal(refused.value?.code, "store_unavailable", refused.text);
  assert.match(refused.text, /\.\.\/missing-store/);
});

test("clause 52: a glossary source counts by its recorded status, not by its Status: line", async (context) => {
  const { call } = await storeProject(context);
  // Written Approved through update_artifact, the new requirement is recorded Draft until a person approves it at a gate.
  await storeWrite(call, "docs/requirements/written.md", REQUIREMENT);
  assert.equal((await storeRead(call, "docs/requirements/written.md")).status, "Draft");
  const current = await storeRead(call, PATHS.glossary);
  await storeWrite(call, PATHS.glossary, current.content.replace("Source: [retries.md§1](requirements/retries.md#1)", "Source: [written.md§1](requirements/written.md#1)"), { expectedVersion: current.version });
  const [entry] = (await checked(call, { paths: [PATHS.glossary] })).artifacts;
  assert.ok(entry.findings.some((finding) => finding.rule === "glossary.source-decided" && /Draft/.test(finding.message)), JSON.stringify(entry.findings));
  const requirement = (await checked(call, { paths: ["docs/requirements/written.md"] })).artifacts[0];
  assert.deepEqual(requirement.findings, [], "a written status that differs from the recorded one is no format finding");
});

test("clauses 53, 54: each glossary a checkout sees is checked on its own, and its sources resolve in its own scope first and never in a scope it does not see", async (context) => {
  const { place, call } = await storeProject(context);
  // api's first tool call moves its files into scope api before the workspace holds the same paths, which would keep them in the checkout.
  await storeRead(call, PATHS.glossary);
  const web = await otherCheckout(context, place);
  // The workspace holds a Draft copy of the requirement that api's own copy holds Approved, and a workspace glossary cites it.
  await storeWrite(web.call, PATHS.requirements, draft, { scope: "workspace" });
  await storeWrite(web.call, PATHS.glossary, GLOSSARY, { scope: "workspace" });
  const value = await checked(call, { type: "glossary" });
  assert.deepEqual(value.artifacts.map(keyOf), [["glossary", PATHS.glossary, "api"], ["glossary", PATHS.glossary, "workspace"]]);
  const [own, shared] = value.artifacts;
  assert.deepEqual(own.findings, [], "api's glossary resolves the requirement in api's own scope, where it is Approved");
  assert.ok(shared.findings.some((finding) => finding.rule === "glossary.source-decided" && /Draft/.test(finding.message)), "the workspace glossary resolves it in the workspace scope");
  assert.ok(shared.findings.some((finding) => finding.rule === "glossary.source-decided" && /scope/.test(finding.message) && /total-retry-deadline/.test(finding.message)), "an ADR only api's scope holds is outside the workspace glossary's scope");
  assert.ok(!own.findings.some((finding) => finding.rule === "glossary.identity") && !shared.findings.some((finding) => finding.rule === "glossary.identity"), "one term id in two glossaries is no finding");
  assert.deepEqual((await checked(web.call, { type: "glossary" })).artifacts.map((entry) => entry.findings.map((finding) => finding.rule).sort()), [shared.findings.map((finding) => finding.rule).sort()], "the workspace glossary has the same findings in every checkout");
});
