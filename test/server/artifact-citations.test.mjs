import assert from "node:assert/strict";
import test from "node:test";
import { CONFORMING, formatServer } from "./fixtures/artifact-formats.mjs";

// How the citation check names and reads the artifacts that work cites.

const OLD = "docs/requirements/old.md";
const BROKEN = "# Old notes\n\nThe client retries.\n";

const initiative = async (call, operations, id = "retries") => {
  const current = await call("get_initiative", { initiative: id });
  return call("update_initiative", { initiative: id, expectedRevision: current.value?.revision ?? null, operations });
};

const roadmap = async (call, operations) => {
  const current = await call("get_roadmap", {});
  return call("update_roadmap", { expectedRevision: current.value?.revision ?? null, operations });
};

const UNNORMALIZED = ["./docs/requirements/old.md#1", "docs//requirements/old.md#1", "docs/requirements/./old.md#1", "docs/requirements/../requirements/old.md#1", "../docs/requirements/old.md#1", "/docs/requirements/old.md#1"];

test("a requirement reference whose path is not normalized is refused as invalid by update_initiative, so no spelling of a nonconforming file escapes the citation check", async (context) => {
  const { call } = await formatServer(context, { ...CONFORMING, [OLD]: BROKEN });
  for (const reference of UNNORMALIZED) {
    const refused = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: [reference] }]);
    assert.equal(refused.value?.code, "validation_failed", `${reference}: ${refused.text}`);
    assert.match(refused.error?.message ?? refused.text, /normalized project-relative path/, reference);
    assert.equal((await call("get_initiative", { initiative: "retries" })).value.exists, false, `${reference}: nothing changed`);
  }
  const cited = await initiative(call, [{ op: "create", slug: "retries", title: "Retries", requirements: [`${OLD}#1`] }]);
  assert.equal(cited.value?.code, "artifact_nonconforming", cited.text);
});

test("a requirement reference whose path is not normalized is refused as invalid by update_roadmap", async (context) => {
  const { call } = await formatServer(context, { ...CONFORMING, [OLD]: BROKEN });
  for (const reference of UNNORMALIZED) {
    const refused = await roadmap(call, [{ op: "add_initiative", id: "retries", title: "Retries", intent: "Bound retries.", band: "Now", requirements: [reference] }]);
    assert.equal(refused.value?.code, "validation_failed", `${reference}: ${refused.text}`);
    assert.match(refused.error?.message ?? refused.text, /normalized project-relative path/, reference);
  }
});
