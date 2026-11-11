import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { acceptAtShip, linkedPaths, mergeStatusRecord, newRecord } from "../../dist/server/workflow/artifact-status.mjs";
import { createInitiative } from "./fixtures/repository-checkouts.mjs";
import { adrFile, answerGate, browserRequest, checkout, git, isolateGit, ok, refused, reviewBrowser, server, syncedWorkspace, workspace, writeArtifact } from "./fixtures/workspace-artifacts.mjs";

// A ship accepts the ADRs that the Markdown links of an initiative's slice.md files name, after a person's confirmation of the initiative as it stands (contract clauses 43 and 44).
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const TEST_FILE = "test/reports.test.mjs";
const CITED = "docs/ADRs/reports/storage.md";
const SLICE = "docs/plans/reports/slice.md";
const CONTRACT = "# Reports\n\n## Contract\n1. `check.mjs` exits 0, as [the storage decision](../../ADRs/reports/storage.md) requires.\n";
const TEST_SOURCE = "import test from \"node:test\";\ntest(\"check exits 0\", () => {});\n";

test("linkedPaths reads links as CommonMark does: code, raw HTML, escapes, images, and unused definitions name nothing", () => {
  const text = [
    "# Plan [heading](../../ADRs/r/heading.md)",
    "",
    "As [the storage decision](../../ADRs/r/storage.md#decision) and ![a figure](../../ADRs/r/image.md \"Figure\") show.",
    "See [the root ADR](/docs/ADRs/r/root.md), [a site](https://example.com/docs/ADRs/x.md), [a fragment](#contract), and [outside](../../../../outside.md).",
    "A full [reference][retries], a collapsed [Shortcut][], and a [shortcut].",
    "Example syntax: `[x](../../ADRs/r/code.md)` and ``[y](`../../ADRs/r/code2.md`)``, <!-- [c](../../ADRs/r/comment.md) -->, and \\[not a link](../../ADRs/r/escaped.md).",
    "An autolink <https://example.com/[a](../../ADRs/r/autolink.md)> and an [undefined][nowhere] reference.",
    "",
    "    [indented](../../ADRs/r/indented.md)",
    "",
    "<div>",
    "[in a block](../../ADRs/r/html.md)",
    "</div>",
    "",
    "<!--",
    "[commented out](../../ADRs/r/commented.md)",
    "-->",
    "",
    "```markdown",
    "[an example](../../ADRs/r/fenced.md)",
    "```",
    "",
    "1. A contract item [in a list](../../ADRs/r/listed.md)",
    "   continues [here](../../ADRs/r/continued.md).",
    "",
    "    still the item's paragraph [indented in the item](../../ADRs/r/item.md)",
    "",
    "> quoted [in a quote](../../ADRs/r/quoted.md)",
    "",
    "[retries]: <../../ADRs/r/retries.md>",
    "[shortcut]: ../../ADRs/r/shortcut.md \"Title\"",
    "[unused]: ../../ADRs/r/unused.md",
    "[after the fence](../../ADRs/r/after.md?plain=1) and [storage again](../../ADRs/r/storage.md)."
  ].join("\n");
  assert.deepEqual(linkedPaths(text, "docs/plans/reports/slice.md"), [
    "docs/ADRs/r/heading.md",
    "docs/ADRs/r/storage.md",
    "docs/ADRs/r/root.md",
    "docs/ADRs/r/retries.md",
    "docs/ADRs/r/shortcut.md",
    "docs/ADRs/r/listed.md",
    "docs/ADRs/r/continued.md",
    "docs/ADRs/r/item.md",
    "docs/ADRs/r/quoted.md",
    "docs/ADRs/r/after.md"
  ]);
});

test("linkedPaths reads 1 MiB of distinct links in linear time and gives up on syntax built to be read many times over", () => {
  const parts = [];
  for (let size = 0, index = 0; size < 1024 * 1024; index += 1) { const part = `](${index.toString(36)}) [a](../../ADRs/${index.toString(36)}.md)\n`; parts.push(part); size += part.length; }
  const started = Date.now();
  const found = linkedPaths(parts.join(""), "docs/plans/reports/slice.md");
  assert.ok(Date.now() - started < 3000, `reading the links took ${Date.now() - started} ms`);
  assert.equal(found.length, parts.length);
  assert.equal(linkedPaths(`${"[".repeat(200000)}${"](a".repeat(200000)}`, "docs/plans/reports/slice.md"), null);
  assert.equal(linkedPaths(`${"- ".repeat(1000)}[a](b.md)`, "docs/plans/reports/slice.md"), null);
});

test("acceptAtShip rewrites the Status line and records the acceptance", () => {
  const verifiedBy = [{ slice: "reports", repository: "api", commit: "a".repeat(40) }];
  const at = "2026-11-11T08:00:00.000Z";
  const accepted = acceptAtShip(newRecord("adrs"), "# Storage\n\nStatus: Proposed\n\n## Decision\n", { gate: "gate-1", initiative: "reports", verifiedBy, at, versionOf: (text) => `v:${text.length}` });
  assert.equal(accepted.text, "# Storage\n\nStatus: Accepted\n\n## Decision\n");
  assert.equal(accepted.record.status, "Accepted");
  assert.equal(accepted.record.acceptedVersion, `v:${accepted.text.length}`);
  assert.deepEqual(accepted.record.acceptance, { gate: "gate-1", initiative: "reports", at, verifiedBy });
  assert.equal(accepted.record.history.at(-1).event, "shipped");
});

test("a status record merge keeps a ship's acceptance and ends an approval that the other side asked, alike on both machines", () => {
  const version = `sha256:${"1".repeat(64)}`;
  const base = newRecord("adrs");
  const ship = acceptAtShip(base, "# S\n\nStatus: Proposed\n", { gate: "gate-1", initiative: "reports", verifiedBy: [], at: "2026-11-11T08:00:00.000Z", versionOf: () => version }).record;
  const asked = { ...base, pending: [{ id: "approval-1", status: "Superseded", version: `sha256:${"0".repeat(64)}`, question: "Supersede it?", context: null, askedAt: "2026-11-11T07:00:00.000Z" }] };
  const file = "artifact-status/adrs/reports/storage.md/status.json";
  const text = (record) => `${JSON.stringify(record)}\n`;
  const one = mergeStatusRecord({ path: file, base: text(base), local: text(ship), upstream: text(asked) });
  const other = mergeStatusRecord({ path: file, base: text(base), local: text(asked), upstream: text(ship) });
  assert.equal(one.contents, other.contents, "both machines merge the same versions to the same bytes");
  const merged = JSON.parse(one.contents);
  assert.equal(merged.status, "Accepted");
  assert.deepEqual(merged.acceptance, ship.acceptance);
  assert.deepEqual(merged.pending, []);
  assert.deepEqual(merged.closed.map((gate) => [gate.id, gate.closed]), [["approval-1", "shipped"]]);
  const approved = { ...base, status: "Superseded", approval: { gate: "approval-1", status: "Superseded" } };
  assert.ok(mergeStatusRecord({ path: file, base: text(base), local: text(ship), upstream: text(approved) }).conflict, "a status that the other side changed too keeps the upstream record");
});

// An initiative of one slice in checkout api that links the given ADRs, verified and done.
async function finished(context, { contract = CONTRACT, adrs = [CITED] } = {}) {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: TEST_SOURCE } });
  git(api, "config", "user.name", "Ada Reviewer");
  const prism = await server(context, place, api);
  const review = await reviewBrowser(context, api);
  for (const file of adrs) await writeArtifact(prism, file, adrFile(file));
  ok(await createInitiative(prism, "reports"));
  await writeArtifact(prism, SLICE, contract);
  await designAndVerify(prism, review, "reports", "reports", TEST_FILE);
  ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  return { place, api, prism, review };
}

const revision = async (prism) => ok(await prism.call("get_initiative", { initiative: "reports" })).revision;
async function designAndVerify(prism, review, initiative, slice, frozen) {
  ok(await prism.call("update_initiative", { initiative, expectedRevision: await revision(prism), operations: [{ op: "accept_design", slug: slice, frozenTests: [frozen], review: "none" }] }));
  ok(await prism.call("update_initiative", { initiative, expectedRevision: await revision(prism), operations: [{ op: "set_status", slug: slice, status: "in-progress" }] }));
  return verify(prism, review, initiative, slice);
}
async function verify(prism, review, initiative, slice) {
  const asked = ok(await prism.call("verify_slice", { initiative, slice }));
  if (asked.status !== "approval_needed") return asked;
  assert.equal((await answerGate(review, { initiative, id: asked.gateId, choice: "allow" })).status, 200);
  const run = ok(await prism.call("verify_slice", { initiative, slice, approvalGate: asked.gateId }));
  assert.equal(run.status, "passed", JSON.stringify(run));
  return run;
}

const roadmapRevision = async (prism) => ok(await prism.call("get_roadmap", {})).revision;
const ship = async (prism, afterGate) => prism.call("update_roadmap", { expectedRevision: await roadmapRevision(prism), operations: [{ op: "ship", id: "reports", afterGate }] });
async function ask(prism, gate) {
  const state = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
  return ok(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { gateOperations: [{ op: "ask", ...gate }] } })).openedGates[0].id;
}
async function approved(prism, review, gate = { kind: "correctness", question: "Ship the reports initiative?", context: "Every slice passed verification.", artifacts: [] }) {
  const id = await ask(prism, gate);
  assert.equal((await answerGate(review, { initiative: "reports", id, choice: "approve" })).status, 200);
  return id;
}
const statusOf = async (prism, file, scope) => ok(await prism.call("get_artifact", { path: file, ...(scope ? { scope } : {}) })).status;

test("clause 43: an answered gate keeps its kind and question, so an approved visual review or decision never confirms a ship", async (context) => {
  const { prism, review } = await finished(context);
  const visual = await approved(prism, review, { kind: "visual-review", question: "Does the diagram look right?", context: "Only the layout.", artifacts: [] });
  const decision = await approved(prism, review, { kind: "decision", question: "Use tabs or spaces?", context: "Style only.", options: [{ id: "approve", label: "Tabs", consequence: "The files use tabs." }, { id: "spaces", label: "Spaces", consequence: "The files use spaces." }], recommended: { option: "approve", reason: "Tabs match." } });
  for (const id of [visual, decision]) {
    const state = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
    const relabelled = state.state.pending.map((gate) => {
      if (gate.id !== id) return gate;
      const { options, recommended, ...rest } = gate;
      return { ...rest, kind: "correctness", question: "Ship the reports initiative?" };
    });
    refused(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { pending: relabelled } }), "invalid_changes");
    const reworded = state.state.pending.map((gate) => gate.id === id ? { ...gate, context: "Something else." } : gate);
    refused(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { pending: reworded } }), "invalid_changes");
    const after = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
    assert.deepEqual(after.state.pending.find((gate) => gate.id === id), state.state.pending.find((gate) => gate.id === id), "the answered gate is unchanged");
    refused(await ship(prism, id), "ship_unconfirmed");
  }
  // An agent cannot place a correctness gate that claims what the initiative stood at either: only an ask records that.
  const state = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
  const forged = { id: "gate-0123456789ab", kind: "correctness", question: "Ship?", artifacts: [], askedAt: new Date().toISOString(), standing: { runs: [], slices: [], repositories: [], adrs: [] } };
  refused(await prism.call("update_coordination_state", { initiative: "reports", expectedRevision: state.revision, changes: { pending: [...state.state.pending, forged] } }), "invalid_changes");
  assert.equal(await statusOf(prism, CITED), "Proposed");
});

test("clause 43: a correctness gate asked before a slice.md changed, or before a later passing run, confirms no ship", async (context) => {
  const OTHER = "docs/ADRs/billing/ledger.md";
  const { prism, review } = await finished(context, { adrs: [CITED, OTHER] });
  const early = await approved(prism, review);
  const current = ok(await prism.call("get_artifact", { path: SLICE }));
  await writeArtifact(prism, SLICE, `${CONTRACT}\nSee [ledger](../../ADRs/billing/ledger.md).\n`, { expectedVersion: current.version });
  const stale = refused(await ship(prism, early), "ship_unconfirmed");
  assert.deepEqual(stale.data.changed, [{ path: SLICE, scope: "workspace", change: "changed" }]);
  assert.match(stale.message, /docs\/plans\/reports\/slice\.md in scope workspace was changed/);
  assert.equal(await statusOf(prism, OTHER), "Proposed", "a refused ship accepts nothing");

  const second = await approved(prism, review);
  // Verifying the done slice again needs a claim on it, which is released before the ship, since a live claim is open work.
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "claim", slug: "reports" }] }));
  const rerun = await verify(prism, review, "reports", "reports");
  assert.equal(rerun.status, "passed");
  ok(await prism.call("update_initiative", { initiative: "reports", expectedRevision: await revision(prism), operations: [{ op: "release_claim", slug: "reports" }] }));
  const verifiedAgain = refused(await ship(prism, second), "ship_unconfirmed");
  assert.deepEqual(verifiedAgain.data.changed, [{ slice: "reports", run: rerun.runId ?? verifiedAgain.data.changed[0].run }]);
  assert.match(verifiedAgain.message, /reports passed verification again in run/);
  const confirmed = await approved(prism, review);
  const shipped = ok(await ship(prism, confirmed));
  assert.deepEqual(shipped.acceptedAdrs.map((adr) => adr.path), [OTHER, CITED]);
});

test("clause 43: a correctness gate asked before a linked ADR was rewritten, or before one was created at a linked path, confirms no ship", async (context) => {
  const LATER = "docs/ADRs/reports/later.md";
  const { prism, review } = await finished(context, { contract: `${CONTRACT}2. Exports follow [the export decision](../../ADRs/reports/later.md).\n` });
  const before = ok(await prism.call("get_roadmap", {}));
  const early = await approved(prism, review);
  const cited = ok(await prism.call("get_artifact", { path: CITED }));
  await writeArtifact(prism, CITED, adrFile("Storage").replace("The system MUST do the thing.", "The system MUST store reports in a public bucket."), { expectedVersion: cited.version });
  const rewritten = refused(await ship(prism, early), "ship_unconfirmed");
  assert.deepEqual(rewritten.data.changed, [{ kind: "adrs", path: CITED, scope: "workspace", change: "changed" }]);
  assert.match(rewritten.message, /the ADR docs\/ADRs\/reports\/storage\.md in scope workspace was changed/);

  const second = await approved(prism, review);
  await writeArtifact(prism, LATER, adrFile("Export"));
  const created = refused(await ship(prism, second), "ship_unconfirmed");
  assert.deepEqual(created.data.changed, [{ kind: "adrs", path: LATER, scope: "workspace", change: "added" }]);
  assert.match(created.message, /the ship would now also accept the ADR docs\/ADRs\/reports\/later\.md in scope workspace/);
  for (const file of [CITED, LATER]) assert.equal(await statusOf(prism, file), "Proposed", "a refused ship accepts nothing");
  assert.equal(ok(await prism.call("get_roadmap", {})).revision, before.revision, "the roadmap is unchanged");

  // A gate asked after both writes confirms the ADRs as they now read.
  const shipped = ok(await ship(prism, await approved(prism, review)));
  assert.deepEqual(shipped.acceptedAdrs.map((adr) => adr.path), [LATER, CITED]);
  assert.match(ok(await prism.call("get_artifact", { path: CITED })).content, /public bucket/);
});

test("clause 44: a linked Proposed ADR with an open approval refuses the ship with adr_pending and changes nothing", async (context) => {
  const OTHER = "docs/ADRs/billing/ledger.md";
  const { prism, review } = await finished(context, { contract: `${CONTRACT}\nSee [ledger](../../ADRs/billing/ledger.md).\n`, adrs: [CITED, OTHER] });
  const pending = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: OTHER, status: "Rejected", question: "Reject the ledger decision?", context: "Billing dropped it." }] })).artifacts[0].gate;
  const gate = await approved(prism, review);
  const before = ok(await prism.call("get_roadmap", {}));
  const stopped = refused(await ship(prism, gate), "adr_pending");
  assert.deepEqual(stopped.data.adrs, [{ path: OTHER, scope: { kind: "workspace", label: "workspace" }, gates: [pending] }]);
  assert.match(stopped.message, new RegExp(`${OTHER} in scope workspace \\(${pending}\\)`));
  assert.equal(await statusOf(prism, CITED), "Proposed", "no ADR changes");
  assert.equal(await statusOf(prism, OTHER), "Proposed");
  assert.equal(ok(await prism.call("get_roadmap", {})).revision, before.revision, "the roadmap is unchanged");
  assert.equal((await answerGate(review, { id: pending, choice: "request-changes", note: "Keep it for now." })).status, 200, "the person's question is still open");
  assert.deepEqual(ok(await ship(prism, gate)).acceptedAdrs.map((adr) => adr.path), [OTHER, CITED]);
});

test("clause 44: text that CommonMark shows as code, a comment, or escaped characters accepts no ADR, while inline and reference links do", async (context) => {
  const names = ["inline", "reference", "code", "indented", "comment", "escaped"];
  const contract = [
    "# Reports", "", "## Contract",
    "1. As [inline](../../ADRs/r/inline.md) and [the reference][ref] require.",
    "", "Example syntax: `[x](../../ADRs/r/code.md)`.",
    "", "    [indented](../../ADRs/r/indented.md)",
    "", "<!-- [c](../../ADRs/r/comment.md) -->",
    "", "\\[not a link](../../ADRs/r/escaped.md)",
    "", "[ref]: ../../ADRs/r/reference.md", ""
  ].join("\n");
  const { prism, review } = await finished(context, { contract, adrs: names.map((name) => `docs/ADRs/r/${name}.md`) });
  const shipped = ok(await ship(prism, await approved(prism, review)));
  assert.deepEqual(shipped.acceptedAdrs.map((adr) => adr.path), ["docs/ADRs/r/inline.md", "docs/ADRs/r/reference.md"]);
  for (const name of ["code", "indented", "comment", "escaped"]) assert.equal(await statusOf(prism, `docs/ADRs/r/${name}.md`), "Proposed", `${name} names no link`);
});

test("clause 44: a ship of a slice.md of 1 MiB of distinct links takes seconds, and one above an artifact's bound refuses", async (context) => {
  const { place, prism, review } = await finished(context);
  const parts = [CONTRACT];
  for (let size = CONTRACT.length, index = 0; size < 1024 * 1024 - 64; index += 1) { const part = `](${index.toString(36)})`; parts.push(part); size += part.length; }
  const current = ok(await prism.call("get_artifact", { path: SLICE }));
  await writeArtifact(prism, SLICE, parts.join(""), { expectedVersion: current.version });
  const gate = await approved(prism, review);
  const started = Date.now();
  const shipped = ok(await ship(prism, gate));
  assert.ok(Date.now() - started < 10000, `the ship took ${Date.now() - started} ms`);
  assert.deepEqual(shipped.acceptedAdrs.map((adr) => adr.path), [CITED]);

  // A slice.md that a sync brought above the bound of an artifact is never read whole: the ship refuses and changes nothing.
  const { place: other, prism: second, review: secondReview } = await finished(context, { adrs: [CITED] });
  const stored = path.join(other.store, "artifacts", "plans", "reports", "slice.md");
  await mkdir(path.dirname(stored), { recursive: true });
  await writeFile(stored, `${CONTRACT}${" ".repeat(1024 * 1024 + 1)}\n`);
  const late = await approved(second, secondReview);
  const tooLarge = refused(await ship(second, late), "artifact_too_large");
  assert.equal(tooLarge.data.path, SLICE);
  assert.equal(await statusOf(second, CITED), "Proposed");
  assert.ok(place.store !== other.store);
});

test("clause 44: a ship accepts an ADR of the repository of the slice that links it, whichever checkout ships, and none of another repository", async (context) => {
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: TEST_SOURCE } });
  const web = await checkout(place, "web", { files: { "test/web.test.mjs": TEST_SOURCE } });
  const onApi = await server(context, place, api);
  const onWeb = await server(context, place, web);
  const apiReview = await reviewBrowser(context, api);
  const webReview = await reviewBrowser(context, web);
  await writeArtifact(onWeb, "docs/ADRs/web/client.md", adrFile("Client"), { scope: "repository" });
  await writeArtifact(onWeb, "docs/ADRs/web/other.md", adrFile("Other"), { scope: "repository" });
  ok(await createInitiative(onApi, "reports", { claim: false }));
  await writeArtifact(onApi, SLICE, "# Reports\n\n## Assumptions\n- Unprobed: the split holds; parts differ.\n");
  await writeArtifact(onApi, "docs/plans/reports/a/slice.md", "# A\n\n[another repository's](../../../ADRs/web/other.md)\n");
  await writeArtifact(onApi, "docs/plans/reports/b/slice.md", "# B\n\n[client](../../../ADRs/web/client.md)\n");
  ok(await onApi.call("update_initiative", { initiative: "reports", expectedRevision: await revision(onApi), operations: [{ op: "split", parent: "reports", children: [{ slug: "a", title: "A", requirements: ["r.md#1"] }, { slug: "b", title: "B", requirements: ["r.md#1"] }], evidence: { kind: "unfrozen", assumption: "the split holds", settledBy: "a" } }] }));
  await designAndVerify(onApi, apiReview, "reports", "a", TEST_FILE);
  await designAndVerify(onWeb, webReview, "reports", "b", "test/web.test.mjs");
  ok(await onApi.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  const shipped = ok(await ship(onApi, await approved(onApi, apiReview)));
  assert.deepEqual(shipped.acceptedAdrs.map((adr) => [adr.path, adr.scope.label]), [["docs/ADRs/web/client.md", "web"]]);
  const client = ok(await onWeb.call("get_artifact", { path: "docs/ADRs/web/client.md" }));
  assert.equal(client.status, "Accepted");
  assert.deepEqual(client.acceptance.verifiedBy.map((item) => item.repository), ["api", "web"]);
  assert.equal(await statusOf(onWeb, "docs/ADRs/web/other.md"), "Proposed", "a link in api's slice names no ADR of web");
});

// Copy an artifact and its status record within a store from one scope folder to another, as a sync that met the same path written in two scopes leaves them.
async function copyInStore(store, from, to, file) {
  const rest = file.replace(/^docs\/ADRs\//, "adrs/").replace(/^docs\/plans\//, "plans/");
  for (const [base, tail] of [["artifacts", rest], ["artifact-status", `${rest}/status.json`]]) {
    const source = path.join(store, base, from, tail);
    const contents = await readFile(source).catch((error) => { if (error.code === "ENOENT" && base === "artifact-status") return null; throw error; });
    if (contents === null) continue;
    await mkdir(path.dirname(path.join(store, base, to, tail)), { recursive: true });
    await writeFile(path.join(store, base, to, tail), contents);
  }
}

test("clause 44: a link that could name ADRs in two scopes names the one in its slice.md's scope, and is refused with adr_ambiguous where none is", async (context) => {
  const SHARED = "docs/ADRs/x/shared.md";
  const SPLIT = "docs/ADRs/x/split.md";
  const B_SLICE = "docs/plans/reports/b/slice.md";
  const place = await workspace(context);
  const api = await checkout(place, "api", { files: { [TEST_FILE]: TEST_SOURCE } });
  const web = await checkout(place, "web", { files: { "test/web.test.mjs": TEST_SOURCE } });
  for (const root of [api, web]) git(root, "config", "user.name", "Ada Reviewer");
  const onApi = await server(context, place, api);
  const onWeb = await server(context, place, web);
  const apiReview = await reviewBrowser(context, api);
  const webReview = await reviewBrowser(context, web);
  // Both repositories hold SHARED, and web and the workspace both hold SPLIT.
  await writeArtifact(onApi, SHARED, adrFile("Shared"), { scope: "repository" });
  await writeArtifact(onWeb, SHARED, adrFile("Shared"), { scope: "repository" });
  await writeArtifact(onWeb, SPLIT, adrFile("Split on web"), { scope: "repository" });
  await writeArtifact(onApi, SPLIT, adrFile("Split on the workspace"), { scope: "workspace" });
  ok(await createInitiative(onApi, "reports", { claim: false }));
  await writeArtifact(onApi, SLICE, "# Reports\n\nCites [shared](../../ADRs/x/shared.md).\n\n## Assumptions\n- Unprobed: the split holds; parts differ.\n");
  await writeArtifact(onApi, "docs/plans/reports/a/slice.md", "# A\n");
  await writeArtifact(onApi, B_SLICE, "# B\n");
  ok(await onApi.call("update_initiative", { initiative: "reports", expectedRevision: await revision(onApi), operations: [{ op: "split", parent: "reports", children: [{ slug: "a", title: "A", requirements: ["r.md#1"] }, { slug: "b", title: "B", requirements: ["r.md#1"] }], evidence: { kind: "unfrozen", assumption: "the split holds", settledBy: "a" } }] }));
  await designAndVerify(onApi, apiReview, "reports", "a", TEST_FILE);
  await designAndVerify(onWeb, webReview, "reports", "b", "test/web.test.mjs");
  // A copy of web's slice b's slice.md in api's repository scope links SPLIT, which api's scope does not hold.
  const apiSlice = path.join(place.store, "artifacts", "repositories", "api", "plans", "reports", "b", "slice.md");
  await mkdir(path.dirname(apiSlice), { recursive: true });
  await writeFile(apiSlice, "# B\n\n[split](../../../ADRs/x/split.md)\n");
  ok(await onApi.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  const before = ok(await onApi.call("get_roadmap", {}));
  const unclear = refused(await ship(onApi, await approved(onApi, apiReview)), "adr_ambiguous");
  assert.deepEqual(unclear.data.adrs, [{ path: SHARED, scopes: ["api", "web"] }, { path: SPLIT, scopes: ["web", "workspace"] }]);
  assert.match(unclear.message, /docs\/ADRs\/x\/shared\.md in scopes api, web; docs\/ADRs\/x\/split\.md in scopes web, workspace/);
  const statuses = async () => [
    await statusOf(onApi, SHARED, "repository"), await statusOf(onWeb, SHARED, "repository"),
    await statusOf(onWeb, SPLIT, "repository"), await statusOf(onApi, SPLIT, "workspace")
  ];
  assert.deepEqual(await statuses(), ["Proposed", "Proposed", "Proposed", "Proposed"], "an ambiguous link accepts nothing");
  assert.equal(ok(await onApi.call("get_roadmap", {})).revision, before.revision, "the roadmap is unchanged");

  // With SHARED in the workspace scope too, the root slice.md, which the workspace holds, names the workspace's; without api's copy of b's slice.md, nothing links SPLIT.
  await copyInStore(place.store, "repositories/web", "", SHARED);
  await rm(apiSlice);
  const shipped = ok(await ship(onApi, await approved(onApi, apiReview)));
  assert.deepEqual(shipped.acceptedAdrs.map((adr) => [adr.path, adr.scope.label]), [[SHARED, "workspace"]]);
  assert.deepEqual(await statuses(), ["Proposed", "Proposed", "Proposed", "Proposed"]);
  assert.equal(await statusOf(onApi, SHARED, "workspace"), "Accepted");
});

test("clause 44: a ship that stopped after accepting its ADRs reports them again when it is retried", async (context) => {
  const { api, prism, review } = await finished(context);
  const gate = await approved(prism, review);
  // The acceptance is written under the artifact lock before the roadmap write, so a ship that stops between them leaves the ADR Accepted and the initiative unshipped.
  const { initiativePlan } = await import("../../dist/server/workflow/ship-standing.mjs");
  const { acceptLinkedAdrs } = await import("../../dist/server/workflow/store-artifacts.mjs");
  const { plan, runs } = await initiativePlan(api, "reports");
  const state = ok(await prism.call("get_coordination_state", { initiative: "reports" }));
  const verifiedBy = runs.map((item) => ({ slice: item.slice, repository: item.checkout.repository, commit: item.checkout.head }));
  const standing = state.state.pending.find((item) => item.id === gate).standing;
  const shipOf = { gate, initiative: "reports", at: new Date().toISOString(), verifiedBy };
  // The comparison holds under the artifact lock where the acceptance writes: a plan whose links resolve in other repositories than the gate recorded accepts nothing.
  const moved = { ...plan, slices: plan.slices.map((slice) => ({ ...slice, repositories: ["web"] })), repositories: ["web"] };
  assert.deepEqual(await acceptLinkedAdrs(api, [{ plan: moved, standing, ship: shipOf }]), { refused: "ship_unconfirmed", gate, changed: [{ folder: "docs/plans/reports", repositories: ["web"], before: ["api"] }] });
  assert.equal(await statusOf(prism, CITED), "Proposed");
  assert.equal((await acceptLinkedAdrs(api, [{ plan, standing, ship: shipOf }])).accepted.length, 1);
  assert.equal(await statusOf(prism, CITED), "Accepted");
  const retried = ok(await ship(prism, gate));
  assert.deepEqual(retried.acceptedAdrs, [{ path: CITED, scope: { kind: "workspace", label: "workspace" }, verifiedBy }]);
});

test("clause 44: a sync that meets a ship's acceptance and an approval asked on another machine keeps the acceptance and ends the approval", async (context) => {
  const { syncRecordStoreNow } = await import("../../dist/server/workflow/record-store-sync.mjs");
  const place = await syncedWorkspace(context);
  const a = { ...place.a, sync: undefined };
  const api = await checkout(a, "api", { files: { [TEST_FILE]: TEST_SOURCE } });
  git(api, "config", "user.name", "Ada Reviewer");
  const onA = await server(context, a, api);
  const reviewA = await reviewBrowser(context, api);
  await writeArtifact(onA, CITED, adrFile(CITED));
  ok(await createInitiative(onA, "reports", { claim: false }));
  await writeArtifact(onA, SLICE, CONTRACT);
  await designAndVerify(onA, reviewA, "reports", "reports", TEST_FILE);
  ok(await onA.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: "reports", title: "Reports", intent: "Reports ship.", band: "Now", requirements: ["r.md§1"] }] }));
  const gate = await approved(onA, reviewA);
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");

  const bParent = path.join(place.parent, "machine-b");
  await mkdir(bParent);
  const b = { ...place.b, sync: undefined, parent: bParent };
  const apiOnB = await checkout(b, "api", { store: "../../store-b" });
  git(apiOnB, "config", "user.name", "Ada Reviewer");
  const onB = await server(context, b, apiOnB);
  const reviewB = await reviewBrowser(context, apiOnB);
  assert.equal((await syncRecordStoreNow(place.storeB)).state, "ok");
  const asked = ok(await onB.call("update_artifact", { operations: [{ op: "ask_approval", path: CITED, status: "Superseded", question: "Supersede storage?", context: "A newer decision replaces it." }] })).artifacts[0].gate;
  assert.equal((await syncRecordStoreNow(place.storeB)).state, "ok");
  // The person has the approval open in machine B's review browser when the ship on machine A accepts the ADR.
  const listed = (await browserRequest(reviewB, `/api/actions?target=${encodeURIComponent(`approval:${asked}`)}`)).body.actions.find((item) => item.id === "gate.answer");

  assert.deepEqual(ok(await ship(onA, gate)).acceptedAdrs.map((adr) => adr.path), [CITED]);
  assert.equal((await syncRecordStoreNow(place.storeA)).state, "ok");
  assert.equal((await syncRecordStoreNow(place.storeB)).state, "ok");
  for (const prism of [onA, onB]) {
    const adr = ok(await prism.call("get_artifact", { path: CITED }));
    assert.equal(adr.status, "Accepted");
    assert.match(adr.content, /^Status: Accepted$/m);
    assert.equal(adr.statusMismatch, undefined, "the file and the recorded status agree");
    assert.equal(adr.acceptance.gate, gate);
  }
  // Machine B's checkout names its Git user, so what refuses the answer is that the ship ended the approval, from the page open before the ship and from a fresh listing alike.
  // readdir names nested entries with the platform separator, which the filter writes as /.
  const records = (await readdir(path.join(place.storeB, "artifact-status"), { recursive: true })).filter((file) => file.split(path.sep).join("/").endsWith("storage.md/status.json"));
  assert.equal(records.length, 1);
  const record = JSON.parse(await readFile(path.join(place.storeB, "artifact-status", records[0]), "utf8"));
  assert.deepEqual(record.closed.filter((item) => item.id === asked).map((item) => item.closed), ["shipped"]);
  for (const ended of [
    await browserRequest(reviewB, "/api/actions/apply", { method: "POST", body: { action: "gate.answer", target: `approval:${asked}`, input: { choice: "approve" }, revision: listed.revision } }),
    await answerGate(reviewB, { id: asked, choice: "approve" })
  ]) {
    assert.equal(ended.status, 404, "the ended approval can no longer change the status");
    assert.equal(ended.body.code, "unknown_target");
  }
  assert.equal(await statusOf(onB, CITED), "Accepted");
});
