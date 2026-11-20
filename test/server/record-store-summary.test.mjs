import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { checkout, isolateGit, ok, server, syncedWorkspace, workspace } from "./fixtures/workspace-artifacts.mjs";

// An agent read a roadmap's recordPath as a file in the checkout, so a record tool's result in a project with a record store says where the record lives.
const environment = await isolateGit();
test.after(() => rm(environment, { recursive: true, force: true }));

const RECORD_TOOLS = [
  ["get_roadmap", {}],
  ["get_initiative", { initiative: "reports" }],
  ["get_coordination_state", { initiative: "reports" }]
];

test("with a record store, each record tool's result names the store, its folder, and its sync", async (context) => {
  const place = await syncedWorkspace(context);
  const prism = await server(context, place.a, await checkout(place.a, "api"));
  for (const [name, args] of RECORD_TOOLS) {
    const { recordStore } = ok(await prism.call(name, args));
    assert.ok(recordStore, `${name} names the record store`);
    assert.equal(recordStore.store, "../store-a");
    assert.equal(recordStore.folder, place.storeA);
    assert.equal(recordStore.sync, "on");
    assert.match(recordStore.note, /only through Prism's tools/);
  }
});

test("without a record store, a record tool's result names none", async (context) => {
  const place = await workspace(context);
  const prism = await server(context, place, await checkout(place, "api", { store: null }));
  for (const [name, args] of RECORD_TOOLS) assert.equal(ok(await prism.call(name, args)).recordStore, undefined, name);
});
