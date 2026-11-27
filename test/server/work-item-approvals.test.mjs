import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_REQUIREMENT, DRAFT_REQUIREMENT, addEntries, answeredRound, itemDone, itemProject, requirementText, storeRead, storeWrite } from "./fixtures/work-items.mjs";

// Asking a person to approve a requirement file names the work items that cite it, waits for an answered round, and warns about implementation text.

const ask = (call, file, extra = {}) => call("update_artifact", { operations: [{ op: "ask_approval", path: file, context: "Approve the requirements.", ...extra }] });

// The export item gains a shaping record without a round, so it is emerging and cites export.md, whose bytes then change.
async function unaskedExport(call) {
  await itemDone(call, "export", [{ op: "add_input", link: "https://example.invalid/brief", note: "The export brief." }]);
  const current = await storeRead(call, APPROVED_REQUIREMENT);
  await storeWrite(call, APPROVED_REQUIREMENT, current.content.replace("People need it.", "People need it every month."), { expectedVersion: current.version });
}

const attentionText = async (root) => {
  const { loadAttention } = await import("../../dist/server/review/workspace-model.mjs");
  return JSON.stringify(await loadAttention(root));
};

test("§29: approval of a requirement file that an emerging item cites is refused, naming the item, until the item has an answered round", async (context) => {
  const { call, review } = await itemProject(context);
  await unaskedExport(call);
  const refused = await ask(call, APPROVED_REQUIREMENT);
  assert.equal(refused.value?.code, "shaping_unasked", refused.text);
  assert.deepEqual(refused.value.items, ["export"]);
  assert.match(refused.text, /export/);
  await answeredRound(call, review, "export");
  const asked = await ask(call, APPROVED_REQUIREMENT);
  assert.equal(asked.value?.code ?? null, null, asked.text);
});

test("§29: a requirement file that no emerging item cites is asked as before", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const lonely = "docs/requirements/lonely.md";
  await storeWrite(call, lonely, requirementText("Lonely"));
  const asked = await ask(call, lonely);
  assert.equal(asked.value?.code ?? null, null, asked.text);
});

test("§30: an approval request names each work item that cites the file, in its result and in the gate's context", async (context) => {
  const { root, call, review } = await itemProject(context);
  await answeredRound(call, review, "sync");
  await itemDone(call, "sync", [{ op: "cite", requirements: ["sync.md§1"] }]);
  await addEntries(call, [{ id: "mobile", title: "Mobile sync", intent: "Phones sync too.", band: "Later" }]);
  await answeredRound(call, review, "mobile");
  await itemDone(call, "mobile", [{ op: "cite", requirements: ["sync.md§1"] }]);
  const asked = await ask(call, DRAFT_REQUIREMENT);
  assert.equal(asked.value?.code ?? null, null, asked.text);
  assert.deepEqual(asked.value.artifacts[0].citedBy, [{ id: "sync", title: "Sync changes" }, { id: "mobile", title: "Mobile sync" }]);
  const attention = await attentionText(root);
  assert.match(attention, /Sync changes[^"]*Mobile sync|Mobile sync[^"]*Sync changes/, "the gate's context names both items");
  const lonely = "docs/requirements/lonely.md";
  await storeWrite(call, lonely, requirementText("Lonely"));
  const none = await ask(call, lonely);
  assert.deepEqual(none.value.artifacts[0].citedBy, []);
  assert.match(await attentionText(root), /no work item cites/i);
});

test("§31, §32: a requirement statement with a code span or a file path is warned about on write, edit, check, and approval, and nothing is refused", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const file = "docs/requirements/tooling.md";
  const text = requirementText("Tooling", { statement: "When a build starts, the system shall run `codegraph index` and write src/index/cache.json." });
  const written = await call("update_artifact", { operations: [{ op: "write", path: file, content: text, expectedVersion: null }] });
  assert.equal(written.value?.code ?? null, null, written.text);
  const warnings = written.value.artifacts[0].warnings;
  assert.deepEqual(warnings.map((warning) => [warning.rule, warning.section]), [["requirements.implementation-text", 1]]);
  assert.equal(typeof warnings[0].line, "number");
  assert.match(warnings[0].text, /codegraph index/);
  assert.match(warnings[0].message, /implementation/i);
  const edited = await call("update_artifact", { operations: [{ op: "edit", path: file, expectedVersion: written.value.artifacts[0].version, edits: [{ oldText: "write src/index/cache.json", newText: "keep its index" }] }] });
  assert.equal(edited.value.artifacts[0].warnings.length, 1, "the code span still warns");
  const checked = (await call("check_artifacts", { paths: [file] })).value.artifacts.find((entry) => entry.path === file);
  assert.equal(checked.conforms, true, "a warning is no format finding");
  assert.equal(checked.warnings.length, 1);
  const asked = await ask(call, file);
  assert.equal(asked.value?.code ?? null, null, asked.text);
  assert.equal(asked.value.artifacts[0].warnings.length, 1);
});

test("§31: prose with slashes, links, and plain words is not warned about, and each path form is", async (context) => {
  const { call } = await itemProject(context, { browser: false });
  const cases = {
    "When a person chooses export and/or print, the system shall keep a TCP/IP connection for 1/2 a minute.": 0,
    "When a person opens https://example.invalid/page, the system shall show it.": 0,
    "When a build starts, the system shall read ./config.": 1,
    "When a build starts, the system shall read ~/settings.": 1,
    "When a build starts, the system shall read docs/requirements/x.": 1,
    "When a build starts, the system shall read config/app.yaml.": 1,
    "When a build starts, the system shall read C:\\tools.": 1,
    "When a build starts, the system shall read /etc.": 1
  };
  let index = 0;
  for (const [statement, expected] of Object.entries(cases)) {
    index += 1;
    const file = `docs/requirements/case-${index}.md`;
    const result = await call("update_artifact", { operations: [{ op: "write", path: file, content: requirementText(`Case ${index}`, { statement }), expectedVersion: null }] });
    const warnings = result.value.artifacts[0].warnings ?? [];
    assert.equal(warnings.length, expected, statement);
  }
});

test("§32: the approval gate's context names each warned section so the person sees the warning", async (context) => {
  const { root, call } = await itemProject(context, { browser: false });
  const file = "docs/requirements/tooling.md";
  await storeWrite(call, file, requirementText("Tooling", { statement: "When a build starts, the system shall run `codegraph index`." }));
  const asked = await ask(call, file);
  assert.equal(asked.value?.code ?? null, null, asked.text);
  const attention = await attentionText(root);
  assert.match(attention, /implementation/i, "Attention shows the warning in the approval's context");
  assert.match(attention, /§1|section 1/i);
});
