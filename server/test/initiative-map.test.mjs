import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseMap } from "../../skills/write-map/scripts/validate-map.mjs";

const format = await readFile(new URL("../../skills/write-map/references/map-format.md", import.meta.url), "utf8");
const example = format.match(/```puml\n([\s\S]*?)\n```/)[1];
const alias = (slug) => "s_" + Buffer.from(slug).toString("hex");
const fixture = (states, assignments, edges = []) => [
  "@startuml", "title Initiative: fixture", "hide empty description",
  ...states, ...assignments.map(([slug, req]) => alias(slug) + ' : requires "req.md#' + req + '"'),
  ...edges.map(([from, to]) => alias(from) + " --> " + alias(to) + " : depends on"), "@enduml"
].join("\n");
const state = (slug, status, open = false) => 'state "Meaningful capability" as ' + alias(slug) + " <<" + status + ">>" + (open ? " {" : "");

test("parses the documented map and derives topology without cursor duplication", () => {
  const map = parseMap(example);
  assert.equal(map.slices.download.title, "Download signed reports");
  assert.equal(map.slices.download.parent, "reports");
  assert.deepEqual(map.effectiveDependencies.download, ["auth"]);
  assert.deepEqual(map.designCandidates, ["download"]);
  assert.equal(map.complete.reports, false);
  assert.equal(map.complete.auth, true);
  assert.equal(map.dependenciesComplete.includes("download"), true);
  assert.equal(parseMap(example.replace("<<not-started>>", "<<done>>")).complete.reports, true);
});

test("preserves distinct aliases including natural suffixes and object property names", () => {
  const slugs = ["a-b", "a_b", "a_b_2", "__proto__", "constructor"];
  const source = fixture(
    [state("root", "split", true), ...slugs.map((slug) => state(slug, "not-started")), "}"],
    [["root", "R1"], ...slugs.map((slug) => [slug, "R1"])]
  );
  const map = parseMap(source);
  assert.equal(Object.keys(map.slices).length, 6);
  for (const slug of slugs) assert.equal(map.slices[slug].parent, "root");
});

test("expands inherited dependencies and parent completion while allowing early design", () => {
  const source = fixture([
    state("root", "split", true),
    state("group", "split", true), state("child", "not-started"), "}",
    state("prerequisite", "split", true), state("first", "done"), state("second", "blocked"), "}", "}"
  ], ["root", "group", "child", "prerequisite", "first", "second"].map((slug) => [slug, "R1"]), [["group", "prerequisite"]]);
  const map = parseMap(source);
  assert.deepEqual(map.effectiveDependencies.child, ["first", "second"]);
  assert.deepEqual(map.designCandidates, ["child"]);
  assert.equal(map.dependenciesComplete.includes("child"), false);
  assert.equal(map.complete.prerequisite, false);
});

test("rejects ambiguous syntax, missing coverage, invalid aliases, and dependency cycles", () => {
  const bad = [
    [example.replace("hide empty description", "!include secret"), /Unsupported|Missing/],
    [example.replace('state "Download signed reports"', 'state ""'), /Invalid slice title/],
    [example.replace("s_646f776e6c6f6164", "s_0"), /Invalid slice alias/],
    [example.replace("<<split>>", "<<done>>"), /Split status/],
    [example.replace('s_646f776e6c6f6164 : requires "docs/requirements/reports.md#1"', ""), /Missing requirement|Incomplete child coverage/],
    [example.replace("reports.md#2", "reports.md#3"), /Incomplete child coverage/],
    [example.replace("@enduml", "s_61757468 --> s_646f776e6c6f6164 : depends on\n@enduml"), /cycle/],
    [example.replace("@enduml", "s_646f776e6c6f6164 --> s_7265706f727473 : depends on\n@enduml"), /self-dependency/],
    [example.replace("@enduml", "s_646f776e6c6f6164 --> s_78 : depends on\n@enduml"), /Unknown dependency/],
    [example.replace("@enduml", 'state "Other root" as s_78 <<done>>\n@enduml'), /one root/]
  ];
  for (const [source, error] of bad) {
    assert.notEqual(source, example, "invalid-map mutation must change the fixture");
    assert.throws(() => parseMap(source), error);
  }
});

test("migration preserves legacy evidence and blocks missing facts", async () => {
  const orchestrate = await readFile(new URL("../../skills/orchestrate/SKILL.md", import.meta.url), "utf8");
  assert.match(orchestrate, /Before replacing coordination formats, preserve older files until their needed information has a durable home/);
  assert.match(orchestrate, /If records conflict, ask the responsible worker to reconcile them against actual artifacts/);
  assert.match(orchestrate, /Missing records establish neither approval nor completion/);
});
