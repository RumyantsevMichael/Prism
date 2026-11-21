import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_NAMES, DIALOG_NAMES } from "./fixtures/no-host-path.mjs";

// Every test process takes the real hosts off PATH before any test runs, so no test can start a real Claude Code or Codex session,
// while the other executables beside a host stay reachable by name. No test process finds a native dialog program or a well-known
// coding agent either, and under the test runner a confirmation runs no dialog program outside the temporary directory.
const GUARD = fileURLToPath(new URL("./fixtures/no-host-path.mjs", import.meta.url));

test("a test process finds no claude or codex on PATH, and still finds the tools kept beside them", { skip: process.platform === "win32" ? "the check runs POSIX executables" : false }, (t) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "prism-host-folder-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const name of ["claude", "codex", "helper"]) {
    writeFileSync(path.join(folder, name), `#!/bin/sh\necho ${name}\n`);
    chmodSync(path.join(folder, name), 0o755);
  }
  const probe = "const { spawnSync } = require('node:child_process'); console.log(JSON.stringify(['claude', 'codex', 'helper'].map((name) => spawnSync(name, { encoding: 'utf8' }).stdout?.trim() || null)));";
  const env = { ...process.env, PATH: folder };
  delete env.PRISM_TEST_PATH_GUARDED;
  const found = JSON.parse(execFileSync(process.execPath, ["--import", GUARD, "-e", probe], { env, encoding: "utf8" }));
  assert.deepEqual(found, [null, null, "helper"]);
  const left = process.env.PATH.split(path.delimiter).filter(Boolean).flatMap((entry) => ["claude", "codex"].filter((host) => existsSync(path.join(entry, host))).map((host) => path.join(entry, host)));
  assert.deepEqual(left, [], "this test process holds no host on PATH either");
});

const TEXT = "Start a session?";
const PLATFORMS = [["linux", "neither zenity nor kdialog is installed"], ["darwin", "osascript was not found on PATH"], ["win32", "powershell.exe was not found on PATH"]];

/** Makes the temporary directory a fresh folder of its own for one test, and answers it with a sibling folder outside it. */
function ownTemporaryDirectory(t) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "prism-dialog-backstop-"));
  const temporary = path.join(scratch, "tmp");
  const outside = path.join(scratch, "outside");
  for (const folder of [temporary, outside]) mkdirSync(folder);
  const names = ["TMPDIR", "TMP", "TEMP"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = temporary;
  t.after(() => {
    for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    rmSync(scratch, { recursive: true, force: true });
  });
  return { temporary, outside };
}

function dialogPrograms(folder) {
  for (const name of [...DIALOG_NAMES, "powershell.exe"]) {
    writeFileSync(path.join(folder, name), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(folder, name), 0o755);
  }
}

test("a test process finds no native dialog program or well-known coding agent on PATH", { skip: process.platform === "win32" ? "the check runs POSIX executables" : false }, (t) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "prism-agent-folder-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const names = [...DIALOG_NAMES, ...AGENT_NAMES, "helper"];
  for (const name of names) {
    writeFileSync(path.join(folder, name), `#!/bin/sh\necho ${name}\n`);
    chmodSync(path.join(folder, name), 0o755);
  }
  const probe = `const { spawnSync } = require('node:child_process'); console.log(JSON.stringify(${JSON.stringify(names)}.map((name) => spawnSync(name, { encoding: 'utf8' }).stdout?.trim() || null)));`;
  const env = { ...process.env, PATH: folder };
  delete env.PRISM_TEST_PATH_GUARDED;
  const found = JSON.parse(execFileSync(process.execPath, ["--import", GUARD, "-e", probe], { env, encoding: "utf8" }));
  assert.deepEqual(found, names.map((name) => (name === "helper" ? "helper" : null)));
  const left = process.env.PATH.split(path.delimiter).filter(Boolean).flatMap((entry) => [...DIALOG_NAMES, ...AGENT_NAMES].filter((name) => existsSync(path.join(entry, name))).map((name) => path.join(entry, name)));
  assert.deepEqual(left, [], "this test process holds none on PATH either");
});

test("in a test process, nativeDialog on every platform reports no dialog rather than finding a real one on PATH", async () => {
  const { nativeDialog } = await import("../../dist/server/session/launch-confirmation.mjs");
  for (const [platform, missing] of PLATFORMS) {
    const dialog = await nativeDialog({ text: TEXT, env: { ...process.env, DISPLAY: ":0" }, platform });
    assert.equal(dialog.code, "confirmation_unavailable", `${platform} has no dialog: ${dialog.command ?? ""}`);
    assert.equal(dialog.message, `This computer cannot show a confirmation outside the browser: ${missing}.`);
  }
});

test("under the test runner a dialog program outside the temporary directory is passed over, and a stub inside it is used", async (t) => {
  const { nativeDialog } = await import("../../dist/server/session/launch-confirmation.mjs");
  const { temporary, outside } = ownTemporaryDirectory(t);
  dialogPrograms(outside);
  const stubs = path.join(temporary, "bin");
  mkdirSync(stubs);
  dialogPrograms(stubs);
  // Without NODE_TEST_CONTEXT in the environment that the call names, the test process's own still counts.
  const bare = { PATH: outside, DISPLAY: ":0" };
  for (const [platform, missing] of PLATFORMS) {
    const refused = await nativeDialog({ text: TEXT, env: bare, platform });
    assert.equal(refused.message, `This computer cannot show a confirmation outside the browser: ${missing}.`, `${platform} passes over ${outside}`);
    const stub = await nativeDialog({ text: TEXT, env: { ...bare, PATH: [outside, stubs].join(path.delimiter) }, platform });
    assert.equal(path.dirname(stub.command), stubs, `${platform} takes the stub`);
  }
});

test("a test process reads no person's ACP declarations", async () => {
  const { declarationFile, readDeclarations } = await import("../../dist/server/session/acp-agents.mjs");
  const file = declarationFile(process.env);
  assert.equal(file, process.env.PRISM_ACP_AGENTS);
  assert.equal(path.relative(realpathSync(os.tmpdir()), realpathSync(path.dirname(file))).split(path.sep)[0] !== "..", true, "the file lies in the temporary directory");
  assert.deepEqual([readDeclarations(process.env).state, readDeclarations(process.env).agents], ["missing", []]);
});
