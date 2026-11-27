import assert from "node:assert/strict";
import test from "node:test";
import { ADR } from "./fixtures/artifact-formats.mjs";
import { DRAFT_ADR, OPTIONS, draftAdr, itemProject, storeRead, storeWrite, syncedFile } from "./fixtures/work-items.mjs";

// Draft ADRs: version 2 of the ADR format, the Draft status, and design's decision that makes a Draft ADR Proposed.
// Every write through Prism refuses an ADR that breaks its format, so a broken ADR arrives as another machine's sync brings it.

const PATH = "docs/ADRs/sync/change-delivery.md";

async function project(context) {
  return itemProject(context, { browser: false });
}

const checkOne = async (call, file) => (await call("check_artifacts", { paths: [file] })).value.artifacts.find((entry) => entry.path === file);
const rules = (entry) => [...new Set((entry?.findings ?? []).map((finding) => finding.rule))].sort();
const decide = (call, version, extra = {}) => call("update_artifact", { operations: [{ op: "decide", path: PATH, expectedVersion: version, option: "Push over a socket", rationale: "Sockets give updates within a second.", consequences: "Each client keeps a socket open.", mechanism: "The server keeps one socket per client and writes each change to it.", ...extra }] });

test("§33: check_artifacts reports the ADR format as version 2 and accepts a Draft ADR with two options and no decision", async (context) => {
  const { call } = await project(context);
  const value = (await call("check_artifacts", { paths: [DRAFT_ADR] })).value;
  assert.equal(value.formats.find((format) => format.type === "adr").version, 2);
  const entry = value.artifacts.find((item) => item.path === DRAFT_ADR);
  assert.equal(entry.conforms, true, JSON.stringify(entry.findings));
});

test("§33: a Draft ADR with fewer than two options, a decision, or an option without costs breaks the format under adr.sections", async (context) => {
  const { place, call } = await project(context);
  const cases = {
    "docs/ADRs/sync/one-option.md": draftAdr("One option", { options: [OPTIONS[0]] }),
    "docs/ADRs/sync/decided.md": draftAdr("Decided", { extra: "\n## Decision\n\nClients poll.\n" }),
    "docs/ADRs/sync/no-costs.md": draftAdr("No costs", { options: [OPTIONS[0], { ...OPTIONS[1], costs: "" }] }),
    "docs/ADRs/sync/bad-preference.md": draftAdr("Bad preference", { options: [OPTIONS[0], { ...OPTIONS[1], preferred: "Ada Reviewer" }] })
  };
  for (const [file, text] of Object.entries(cases)) await syncedFile(place, file, text, { status: "Draft" });
  for (const file of Object.keys(cases)) {
    const entry = await checkOne(call, file);
    assert.equal(entry.conforms, false, file);
    assert.deepEqual(rules(entry), ["adr.sections"], file);
  }
});

test("§33: a Declined ADR with options and no decision, as a declined Draft ADR is left, is checked by the Draft rules", async (context) => {
  const { place, call } = await project(context);
  const declined = "docs/ADRs/sync/declined.md";
  const broken = "docs/ADRs/sync/declined-one-option.md";
  await syncedFile(place, declined, draftAdr("Declined choice").replace("Status: Draft", "Status: Declined"), { status: "Declined" });
  await syncedFile(place, broken, draftAdr("Declined one option", { options: [OPTIONS[0]] }).replace("Status: Draft", "Status: Declined"), { status: "Declined" });
  const entry = await checkOne(call, declined);
  assert.equal(entry.conforms, true, JSON.stringify(entry.findings));
  assert.deepEqual(rules(await checkOne(call, broken)), ["adr.sections"]);
});

test("§34: an ADR that conformed to version 1 and is not Draft still conforms, and the format keeps version 1's rule ids", async (context) => {
  const { place, call } = await project(context);
  for (const status of ["Accepted", "Proposed", "Declined"]) {
    const file = `docs/ADRs/retries/v1-${status.toLowerCase()}.md`;
    await storeWrite(call, file, ADR.replace("Status: Accepted", `Status: ${status}`));
    const entry = await checkOne(call, file);
    assert.equal(entry.conforms, true, `${status}: ${JSON.stringify(entry.findings)}`);
  }
  const broken = "docs/ADRs/retries/broken.md";
  await syncedFile(place, broken, ADR.replace("## Mechanism\n\nThe client starts a deadline timer with the first attempt.\n\n", ""), { status: "Accepted" });
  assert.deepEqual(rules(await checkOne(call, broken)), ["adr.sections"]);
});

test("§35: a new ADR written with Status: Draft is recorded Draft, and another new ADR is recorded Proposed", async (context) => {
  const { call } = await project(context);
  assert.equal((await storeRead(call, DRAFT_ADR)).status, "Draft");
  await storeWrite(call, "docs/ADRs/sync/plain.md", ADR.replace("Status: Accepted", "Status: Proposed"));
  assert.equal((await storeRead(call, "docs/ADRs/sync/plain.md")).status, "Proposed");
});

test("§36: decide rewrites a Draft ADR as Proposed with the chosen option as its decision and every other option as an alternative", async (context) => {
  const { call } = await project(context);
  const before = await storeRead(call, PATH);
  const result = await decide(call, before.version);
  assert.equal(result.value?.code ?? null, null, result.text);
  const after = await storeRead(call, PATH);
  assert.equal(after.status, "Proposed");
  const text = after.content;
  assert.match(text, /^Status: Proposed$/m);
  const section = (name) => text.split(new RegExp(`^## ${name}\\s*$`, "m"))[1]?.split(/^## /m)[0] ?? "";
  assert.match(section("Decision"), /The server pushes each change\./);
  assert.doesNotMatch(section("Decision"), /Costs:|Rules out:|Preferred by:/);
  assert.doesNotMatch(section("Decision"), /Sockets give updates within a second\./, "the rationale is not the decision");
  assert.match(section("Rationale"), /Sockets give updates within a second\./);
  assert.match(section("Alternatives"), /^### Poll the server$/m);
  assert.match(section("Alternatives"), /Clients poll every minute\./);
  assert.match(section("Consequences"), /Costs: A socket per client\./);
  assert.match(section("Consequences"), /Rules out: Clients behind proxies that drop sockets\./);
  assert.match(section("Consequences"), /Each client keeps a socket open\./);
  assert.match(section("Mechanism"), /one socket per client/);
  assert.match(section("Decision drivers"), /Freshness of what clients show\./);
  assert.match(section("Decision Log"), /^- \d{4}-\d{2}-\d{2}: Decided from its Draft options; chose Push over a socket\.$/m);
  assert.doesNotMatch(text, /^## Options\s*$/m);
  assert.equal((await checkOne(call, PATH)).conforms, true);
});

test("§36: several decide operations in one update decide several Draft ADRs at once", async (context) => {
  const { call } = await project(context);
  const second = "docs/ADRs/sync/storage.md";
  await storeWrite(call, second, draftAdr("Store changes"));
  const [one, two] = [await storeRead(call, PATH), await storeRead(call, second)];
  const result = await call("update_artifact", { operations: [
    { op: "decide", path: PATH, expectedVersion: one.version, option: "Poll the server", rationale: "Polling is simple.", consequences: "Updates lag.", mechanism: "Clients poll." },
    { op: "decide", path: second, expectedVersion: two.version, option: "Push over a socket", rationale: "Pushes are fresh.", consequences: "Sockets stay open.", mechanism: "The server pushes." }
  ] });
  assert.equal(result.value?.code ?? null, null, result.text);
  assert.deepEqual([(await storeRead(call, PATH)).status, (await storeRead(call, second)).status], ["Proposed", "Proposed"]);
  assert.match((await storeRead(call, PATH)).content, /chose Poll the server\./);
});

test("§37: decide refuses an ADR that is not Draft, an unknown option, and a Draft ADR that breaks its format, changing nothing", async (context) => {
  const { place, call } = await project(context);
  const proposed = "docs/ADRs/sync/plain.md";
  const plain = await storeWrite(call, proposed, ADR.replace("Status: Accepted", "Status: Proposed"));
  const notDraft = await call("update_artifact", { operations: [{ op: "decide", path: proposed, expectedVersion: plain.version, option: "Poll the server", rationale: "r", consequences: "c", mechanism: "m" }] });
  assert.equal(notDraft.value?.code, "not_draft", notDraft.text);
  const before = await storeRead(call, PATH);
  const unknown = await decide(call, before.version, { option: "Carrier pigeons" });
  assert.equal(unknown.value?.code, "option_unknown", unknown.text);
  assert.deepEqual(unknown.value.options, ["Poll the server", "Push over a socket"]);
  const broken = "docs/ADRs/sync/one-option.md";
  await syncedFile(place, broken, draftAdr("One option", { options: [OPTIONS[0]] }), { status: "Draft" });
  const written = await storeRead(call, broken);
  const nonconforming = await call("update_artifact", { operations: [{ op: "decide", path: broken, expectedVersion: written.version, option: "Poll the server", rationale: "r", consequences: "c", mechanism: "m" }] });
  assert.equal(nonconforming.value?.code, "artifact_nonconforming", nonconforming.text);
  assert.equal((await storeRead(call, PATH)).version, before.version, "nothing changed");
  assert.equal((await storeRead(call, broken)).status, "Draft");
});

test("§38: an approval of a Draft ADR is refused for any status but Declined, naming decide for Proposed", async (context) => {
  const { call } = await project(context);
  for (const status of ["Proposed", "Superseded by [x](x.md)", "Approved"]) {
    const refused = await call("update_artifact", { operations: [{ op: "ask_approval", path: PATH, status, context: "Settle the choice." }] });
    assert.equal(refused.value?.code, "draft_transition", `${status}: ${refused.text}`);
    if (status === "Proposed") assert.match(refused.text, /decide/);
  }
  const declined = await call("update_artifact", { operations: [{ op: "ask_approval", path: PATH, status: "Declined", context: "The choice no longer matters." }] });
  assert.equal(declined.value?.code ?? null, null, declined.text);
});
