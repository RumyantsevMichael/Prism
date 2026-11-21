import assert from "node:assert/strict";
import test from "node:test";
import { runOptions, runOptionsReview } from "./fixtures/run-options-hosts.mjs";

// A run options query takes no command, arguments, environment, prompt, or folder: those come only from Prism's own host
// definitions and an agent's declaration or install record, so a query that names one is refused and starts nothing.

const posixOnly = process.platform === "win32" ? "the stub hosts are POSIX scripts" : false;

test("a run options query that names a command, arguments, environment, prompt, or folder is refused and starts nothing", { skip: posixOnly }, async (t) => {
  const s = await runOptionsReview(t);
  for (const field of ["command", "args", "env", "prompt", "cwd"]) {
    for (const host of ["claude-code", "acp-gemini"]) {
      const refused = await runOptions(s.base, { host, for: "coordinator", [field]: "/bin/sh" }, s.headers);
      assert.equal(refused.status, 400, `${field} for ${host} is refused`);
      assert.equal(refused.json.code, "invalid_input");
      assert.equal(refused.json.field, field);
    }
  }
  const empty = await runOptions(s.base, { host: "claude-code", for: "coordinator", cwd: "" }, s.headers);
  assert.equal(empty.json.code, "invalid_input", "an empty value is refused too");
  assert.equal(s.runs().length, 0, "no host process starts for a refused query");
});
