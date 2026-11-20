import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { actionOf, apply, listing, runOptionsReview } from "./fixtures/run-options-hosts.mjs";

// The choice of Prism's own runs when its stored file cannot be read: the page can store a readable choice over it, even the
// default of any available host, and a file Prism must not replace is refused with its reason.
const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;
const TARGET = "machine:prism-runs";
const ACTION = "machine.prismRuns";
const AUTOMATIC = { host: "automatic", provider: null, run: null };
const DEFAULTS = { provider: null, model: null, effort: null, typed: false };

const choiceFile = (s) => path.join(s.app, "prism-runs.json");
const current = async (s) => actionOf(await listing(s.base, TARGET, s.headers), ACTION);
const send = async (s, input) => apply(s.base, { action: ACTION, target: TARGET, input, revision: (await current(s)).revision }, s.headers);
const launch = async (s) => (await import("../../dist/server/session/prism-runs.mjs")).prismRunLaunch({ checkout: s.root, env: s.env });

test("any available host applied over an unreadable choice stores a readable one", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  await writeFile(choiceFile(s), "{ not json", { mode: 0o600 });
  const shown = await current(s);
  assert.equal(shown.value.host, null, "an unreadable choice names no host");
  assert.match(shown.fields[0].hint, /could not be read/);
  assert.match((await launch(s)).reason, /could not be read/);
  const applied = await send(s, AUTOMATIC);
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.deepEqual(applied.json.applied.after, { host: "automatic", provider: null, run: { model: null, effort: null, typed: false } });
  const stored = JSON.parse(await readFile(choiceFile(s), "utf8"));
  assert.equal(stored.host, "automatic");
  assert.deepEqual(await launch(s), { host: "claude-code", coordinator: DEFAULTS, reason: null });
  assert.equal((await current(s)).value.host, "automatic");
  assert.equal((await send(s, AUTOMATIC)).json.applied, null, "a stored any available host is no change");
});

test("any available host with no stored choice records nothing", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  const applied = await send(s, AUTOMATIC);
  assert.equal(applied.status, 200);
  assert.equal(applied.json.applied, null);
  await assert.rejects(readFile(choiceFile(s)), "nothing is stored");
});

test("a link or a folder in place of the stored choice is refused with its reason and left alone", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t, { hosts: ["claude"] });
  const elsewhere = path.join(s.app, "elsewhere.json");
  await writeFile(elsewhere, "kept\n");
  await symlink(elsewhere, choiceFile(s));
  const linked = await send(s, { ...AUTOMATIC, host: "claude-code" });
  assert.equal(linked.status, 400, JSON.stringify(linked.json));
  assert.equal(linked.json.code, "invalid_input");
  assert.match(linked.json.message, /is not a regular file, so Prism cannot store the choice there/);
  assert.equal(await readFile(elsewhere, "utf8"), "kept\n", "the link's target is unchanged");
  const other = await runOptionsReview(t, { hosts: ["claude"] });
  await mkdir(choiceFile(other));
  const folder = await send(other, { ...AUTOMATIC, host: "claude-code" });
  assert.equal(folder.status, 400, JSON.stringify(folder.json));
  assert.match(folder.json.message, /is not a regular file/);
});
