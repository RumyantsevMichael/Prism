import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CATALOG, CODEX_CATALOG, optionOf, runOptions, runOptionsReview } from "./fixtures/run-options-hosts.mjs";
import { settled } from "./fixtures/wait.mjs";

// A run options read keeps a bounded amount of what a host reports: each name and description that reaches the answer is cut,
// a model keeps a bounded number of effort levels, and a host that sends too much or lists too many models answers failed.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const read = (s, query) => runOptions(s.base, query, s.headers);
const NAME_MAX = 100;
const DESCRIPTION_MAX = 300;
const MAX_MODEL_LEVELS = 16;
const longText = (length) => "x".repeat(length);

test("names and descriptions that reach the answer are cut, and a model keeps a bounded number of effort levels", { skip: posixOnly }, async (t) => {
  const levels = ["low", "medium", "high", ...Array.from({ length: 200 }, (_, index) => `level-${index}`)];
  const claude = { models: [
    { value: "default", displayName: "Default", description: longText(50000), supportsEffort: true, supportedEffortLevels: levels.slice(50) },
    { value: "opus", displayName: longText(20000), description: longText(80000), supportsEffort: true, supportedEffortLevels: levels }
  ], account: null };
  const codexModel = { id: "big", model: "big", displayName: longText(20000), description: longText(80000), hidden: false, isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: levels.map((level) => ({ reasoningEffort: level, description: longText(10000) })) };
  const codex = { ...CODEX_CATALOG, providers: { data: [{ id: "openai", name: longText(20000) }], defaultProviderId: "openai" }, models: { openai: [codexModel] } };
  const s = await runOptionsReview(t, { catalog: { claude, codex } });
  const within = (report) => {
    for (const option of report.options) {
      assert.ok(option.values.length <= MAX_MODEL_LEVELS + 1 || option.id !== "effort", `${report.host} keeps at most ${MAX_MODEL_LEVELS} effort levels`);
      for (const entry of option.values) {
        assert.ok(entry.name.length <= NAME_MAX, `${report.host} ${option.id} name is cut`);
        assert.ok(entry.description.length <= DESCRIPTION_MAX, `${report.host} ${option.id} description is cut`);
      }
    }
  };
  const claudeReport = (await read(s, { host: "claude-code", for: "coordinator", model: "opus" })).json;
  assert.equal(claudeReport.state, "ready");
  within(claudeReport);
  assert.deepEqual(optionOf(claudeReport, "model").values.map((entry) => [entry.value, entry.name.length, entry.description.length]), [[null, 12, DESCRIPTION_MAX], ["opus", NAME_MAX, DESCRIPTION_MAX]]);
  assert.equal(optionOf(claudeReport, "effort").values.length, MAX_MODEL_LEVELS + 1);
  const typed = (await read(s, { host: "claude-code", for: "coordinator", model: "my-proxy-model", typed: 1 })).json;
  assert.equal(optionOf(typed, "effort").values.length, MAX_MODEL_LEVELS + 1, "a typed model's levels from every listed model stay within the limit");
  const codexReport = (await read(s, { host: "codex", for: "coordinator" })).json;
  assert.equal(codexReport.state, "ready");
  within(codexReport);
  assert.deepEqual(optionOf(codexReport, "model").values.map((entry) => [entry.value, entry.name.length, entry.description.length]), [[null, 12, NAME_MAX], ["big", NAME_MAX, DESCRIPTION_MAX]]);
  assert.equal(optionOf(codexReport, "provider").values[1].name.length, NAME_MAX);
  assert.equal(optionOf(codexReport, "effort").values.length, MAX_MODEL_LEVELS + 1);
});

test("a host that lists more than 1000 models answers failed with the reason", { skip: posixOnly }, async (t) => {
  const models = Array.from({ length: 1001 }, (_, index) => ({ value: `model-${index}`, displayName: `Model ${index}`, description: "", supportsEffort: false }));
  const s = await runOptionsReview(t, { catalog: { claude: { ...CLAUDE_CATALOG, models }, codex: CODEX_CATALOG } });
  const report = (await read(s, { host: "claude-code", for: "coordinator" })).json;
  assert.deepEqual([report.state, report.reason], ["failed", "Claude Code did not report its run options: it listed more than 1000 models."]);
  assert.deepEqual(optionOf(report, "model").values.map((entry) => entry.value), [null]);
});

test("a host that sends more than 4 MiB answers failed at once and is ended, in one line or over model/list pages", { skip: posixOnly }, async (t) => {
  const claude = { models: [{ value: "opus", displayName: "Opus", description: longText(6 * 1024 * 1024) }], account: null };
  const pageModel = (index) => ({ id: `m-${index}`, model: `m-${index}`, displayName: `M ${index}`, description: longText(64 * 1024), hidden: false, isDefault: index === 0, supportedReasoningEfforts: [] });
  const codex = { ...CODEX_CATALOG, models: { openai: Array.from({ length: 90 }, (_, index) => pageModel(index)) } };
  const s = await runOptionsReview(t, { catalog: { claude, codex } });
  const started = Date.now();
  const claudeReport = (await read(s, { host: "claude-code", for: "coordinator" })).json;
  assert.deepEqual([claudeReport.state, claudeReport.reason], ["failed", "Claude Code did not report its run options: it sent more than 4 MiB."]);
  assert.ok(Date.now() - started < 15000, "the read fails when the limit is passed, not at the read time");
  const codexReport = (await read(s, { host: "codex", for: "coordinator" })).json;
  assert.deepEqual([codexReport.state, codexReport.reason], ["failed", "Codex did not report its run options: it sent more than 4 MiB."]);
  const lists = s.optionReads("codex").flatMap((run) => s.inputs(run.pid)).filter((message) => message.method === "model/list");
  assert.ok(lists.length < 90, "the read stops asking for pages once the limit is passed");
  for (const run of s.optionReads()) assert.equal(await settled(() => s.alive(run.pid), false), false, `${run.host} is ended`);
});
