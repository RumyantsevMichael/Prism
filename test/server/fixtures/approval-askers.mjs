// A checkout with a record store whose requirement approval gate a harness session asked and the person then answered on this
// machine's review page, for the tests of continuing an approval gate with its original asker.
// The review page runs in the test's process on a PATH whose only claude and codex are the launched-session stubs, and with a
// private CODEX_HOME, so no test reaches a real harness.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { answerGate, browserRequest, checkout, git, eventually, ok, requirementFile, reviewBrowser, server, workspace, writeArtifact } from "./workspace-artifacts.mjs";
import { controlledPath, stubBin } from "./launched-sessions.mjs";

export const FILE = "docs/requirements/billing.md";
export const INITIATIVE = "reports";

/**
 * Asks an approval of FILE as one harness session, client and env as askerServer takes them, naming the initiative unless
 * initiative is null, answers it with request-changes and a note, and returns { gate, review, place, api, codexHome }.
 */
export async function answeredApproval(t, { client, env = {}, initiative = INITIATIVE, answer = true } = {}) {
  const place = await workspace(t);
  const api = await checkout(place, "api");
  git(api, "config", "user.name", "Ada Reviewer");
  const bin = await stubBin(t);
  // The launched-session stub answers every command alike, so a wrapper answers `claude agents --json` with no open agents.
  await rename(path.join(bin, "claude"), path.join(bin, "claude-session"));
  await writeFile(path.join(bin, "claude"), `#!/bin/sh\nif [ "$1" = agents ]; then echo '[]'; exit 0; fi\nexec "$(dirname "$0")/claude-session" "$@"\n`);
  await chmod(path.join(bin, "claude"), 0o755);
  const codexHome = await realpath(await mkdtemp(path.join(os.tmpdir(), "prism-approval-codex-")));
  await mkdir(path.join(codexHome, "thread-writer-locks"), { recursive: true });
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, PRISM_REVIEW_APP_DIR: process.env.PRISM_REVIEW_APP_DIR };
  process.env.PATH = controlledPath(bin, process.env.PATH);
  process.env.CODEX_HOME = codexHome;
  process.env.PRISM_REVIEW_APP_DIR = place.app;
  for (const name of ["CLAUDE_CODE_REMOTE", "CLAUDE_CODE_REMOTE_SESSION_ID"]) delete process.env[name];
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  const prism = await server(t, place, api, { client, env: { PATH: process.env.PATH, CODEX_HOME: codexHome, ...env } });
  await writeArtifact(prism, FILE, requirementFile("Billing"));
  if (initiative) ok(await prism.call("update_roadmap", { expectedRevision: null, operations: [{ op: "add_initiative", id: initiative, title: "Monthly reports", intent: "Reports ship.", band: "Now" }] }));
  const asked = ok(await prism.call("update_artifact", { operations: [{ op: "ask_approval", path: FILE, question: "Approve billing?", context: "Billing.", ...(initiative ? { initiative } : {}) }] }));
  const gate = asked.artifacts[0].gate;
  const review = await reviewBrowser(t, api);
  await eventually(async () => (await browserRequest(review, "/api/entity?ref=attention")).body.data.needsYou.some((item) => item.id === gate), 30000, "the approval reaches Attention");
  if (answer) {
    const answered = await answerGate(review, { id: gate, choice: "request-changes", note: "Billing must cover refunds; continue the ideation." });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
  }
  return { gate, review, place, api, prism, codexHome };
}

/** The gate.continue action of an approval gate on this machine's page, once its listing names it. */
export async function approvalContinue(review, gate) {
  let action;
  await eventually(async () => (action = (await browserRequest(review, `/api/actions?target=${encodeURIComponent(`approval:${gate}`)}`)).body.actions?.find((item) => item.id === "gate.continue")) !== undefined, 30000, "the approval lists Continue");
  return action;
}

export const optionOf = (action, value) => action.fields[0].options.find((item) => item.value === value);
