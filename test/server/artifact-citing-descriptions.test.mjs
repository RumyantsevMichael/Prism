import assert from "node:assert/strict";
import test from "node:test";
import { CONFORMING } from "./fixtures/artifact-formats.mjs";
import { listedTools, runCheckout } from "./fixtures/format-migration-runs.mjs";

// The descriptions of the citing tools name the refusal's migration state and mention neither legacy marks nor asking for a migration.

test("clause 1: the update_initiative and update_roadmap descriptions name the migration's state and never legacy marks or asking for a migration", async (context) => {
  const { root } = await runCheckout(context, CONFORMING);
  const tools = await listedTools(context, root);
  for (const name of ["update_initiative", "update_roadmap"]) {
    const description = tools[name]?.description ?? "";
    assert.match(description, /artifact_nonconforming/, name);
    assert.match(description, /state of (its|each artifact's) (format )?migration/i, name);
    assert.doesNotMatch(description, /legacy marks?\b|mark(ed|s)? (it |them |\w+ )?as legacy|artifacts\.(mark|remove)-legacy|legacy:<id>/i, name);
    assert.doesNotMatch(description, /ask for a migration|in a session of its own/i, name);
  }
});
