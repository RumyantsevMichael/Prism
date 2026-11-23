import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resumeRefusal } from "../../dist/server/session/launched-sessions.mjs";

// Review finding (gate-resume, correctness): two launched sessions of a resumed asker of an approval gate that names no initiative
// share one kept host session id, so a launch.resume of the ended one must be refused while the other runs under that id.

const posixOnly = process.platform === "win32" ? "the stub host is a POSIX script" : false;

test("a launch.resume of a resumed asker is refused while another launched session runs under the same kept id", { skip: posixOnly }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-shared-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // A stub that is never run: resolveHost only checks that an executable named claude is on PATH.
  await writeFile(path.join(bin, "claude"), "#!/bin/sh\nexit 1\n");
  await chmod(path.join(bin, "claude"), 0o755);
  const env = { PATH: bin, HOME: root, PRISM_REVIEW_APP_DIR: path.join(root, "app") };
  const now = new Date().toISOString();
  const sessionId = "0f8e7d6c-1111-4222-8333-444455556666";
  const base = { initiative: null, host: "claude-code", checkout: root, store: root, createdAt: now, hostSessionId: sessionId, coordinator: null, askerResume: { gate: "approval-0123abcd", initiative: null, artifact: "docs/requirements/x.md" } };
  const ended = { ...base, id: "launch-aaaaaaaaaaaaaaaa", runs: [{ token: "a1", startedAt: now, heartbeatAt: now, endedAt: now, exit: { code: 0 }, supervisorPid: process.pid }] };
  const running = { ...base, id: "launch-bbbbbbbbbbbbbbbb", runs: [{ token: "b1", startedAt: now, heartbeatAt: now, endedAt: null, exit: null, supervisorPid: process.pid }] };
  for (const record of [ended, running]) {
    const folder = path.join(root, "app", "launches", record.id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "launch.json"), JSON.stringify(record));
  }
  assert.notEqual(await resumeRefusal({ id: ended.id, env }), null);
});
