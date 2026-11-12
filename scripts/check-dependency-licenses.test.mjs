import assert from "node:assert/strict";
import test from "node:test";
import { satisfies, violations } from "./check-dependency-licenses.mjs";

const policy = { allowed: ["MIT", "Apache-2.0"], notAllowed: ["GPL-*", "UNKNOWN"], approved: { approved: true } };
const lockfile = packages => ({ packages: { "": {}, ...packages } });

test("an SPDX expression is acceptable when OR has one acceptable side and AND has two", () => {
  const accepts = id => id === "MIT";
  assert.equal(satisfies("(MIT OR GPL-3.0)", accepts), true);
  assert.equal(satisfies("MIT AND GPL-3.0", accepts), false);
  assert.equal(satisfies("MIT AND (MIT OR GPL-3.0)", accepts), true);
  assert.equal(satisfies("GPL-2.0 WITH Classpath-exception-2.0", accepts), false);
});

test("a shipped package needs an allowed license and an unknown one fails", () => {
  const found = violations(lockfile({
    "node_modules/a": { version: "1.0.0", license: "MIT" },
    "node_modules/b": { version: "1.0.0", license: "LGPL-3.0-or-later", optional: true },
    "node_modules/c": { version: "1.0.0" },
  }), policy);
  assert.deepEqual(found.map(entry => entry.name), ["b", "c"]);
});

test("a development-only package fails only on a forbidden license", () => {
  const found = violations(lockfile({
    "node_modules/a": { version: "1.0.0", license: "LGPL-3.0-or-later", dev: true },
    "node_modules/b": { version: "1.0.0", license: "GPL-3.0-only", dev: true },
  }), policy);
  assert.deepEqual(found.map(entry => entry.name), ["b"]);
});

test("an approved package passes whatever its license", () => {
  assert.deepEqual(violations(lockfile({ "node_modules/approved": { version: "1.0.0", license: "LGPL-3.0" } }), policy), []);
});
