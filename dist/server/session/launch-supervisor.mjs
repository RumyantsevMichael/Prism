#!/usr/bin/env node
// Generated from src/server/session/launch-supervisor.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { ANSWERED_GATE_PATTERN, launchCoordinator, launchView, readLaunchRecord, readStopRequest, stopGraceMs, tokenVoided, withRunStartLock, writeLaunchRecord, HEARTBEAT_MS } from "./launch-records.mjs";
import { isAcpHost } from "./acp-agents.mjs";
import { askerResumeOf, hostArguments, hostConversation, hostEnvironment, migrationServerDefinition, MIGRATION_SERVER, redactSessionId, resolveHost, validHostSessionId } from "./launch-hosts.mjs";
import { approvalText, confirmApproval } from "./launch-confirmation.mjs";
import { permissionBroker, shownForm } from "./permission-requests.mjs";
const STDERR_KEEP = 64 * 1024;
const STDERR_LINE_MAX = 300;
const STDERR_HELD = 2 * STDERR_KEEP;
const STACK_FRAME = /^\s*at(\s|$)/;
const OUTPUT_DRAIN_MS = 2e3;
const STOP_DRAIN_MS = 500;
const STOP_POLL_MS = 100;
const STOP_FINISH_MS = 2e3;
function forceEndHost(child) {
  try {
    child.kill("SIGKILL");
  } catch {
  }
}
function keptStderr(held, trimmed, ids) {
  const named = ids.filter((id) => typeof id === "string" && id.length > 0);
  let text = named.reduce((value, id) => redactSessionId(value, id), held.toString("utf8"));
  if (trimmed) text = text.slice(Math.max(0, ...named.map((id) => id.length)) + 3);
  const bytes = Buffer.from(text, "utf8");
  return bytes.length > STDERR_KEEP ? bytes.subarray(bytes.length - STDERR_KEEP).toString("utf8") : text;
}
function lastReasonLine(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !STACK_FRAME.test(line)).at(-1) ?? null;
}
function requestTime(request) {
  const at = Date.parse(request?.requestedAt ?? "");
  return Number.isFinite(at) ? Math.min(at, Date.now()) : Date.now();
}
async function initiativeTitle(checkout, initiative) {
  const { readRoadmap } = await import("../workflow/roadmap.mjs");
  const roadmap = await readRoadmap(checkout).catch(() => null);
  const title = roadmap?.loaded?.record?.initiatives?.find((item) => item?.id === initiative)?.title;
  return typeof title === "string" && title ? shownForm(title) : initiative;
}
async function superviseRun({ folder: folder2, cause: cause2, token: token2, env = process.env }) {
  let queue = Promise.resolve();
  const update = (change) => {
    queue = queue.then(async () => {
      const record2 = await readLaunchRecord(folder2);
      if (!record2) return;
      change(record2);
      await writeLaunchRecord(folder2, record2);
    }).catch(() => {
    });
    return queue;
  };
  const failStart = (message) => update((record2) => {
    record2.startFailure = { token: token2, message, at: (/* @__PURE__ */ new Date()).toISOString() };
    if (record2.starting?.token === token2) delete record2.starting;
  });
  const record = await readLaunchRecord(folder2);
  if (!record) return;
  const asker = askerResumeOf(record.askerResume);
  const resume = record.runs.length > 0 || asker !== null;
  if (isAcpHost(record.host)) {
    await update((current) => {
      current.starting = { token: token2, supervisorPid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() };
    });
  }
  const resolved = await resolveHost(record.host, env);
  if (!resolved?.available) {
    await failStart(resolved?.reason ?? `Unknown host ${record.host}.`);
    return;
  }
  if (resume && !validHostSessionId(record.hostSessionId)) {
    await failStart("The session never reported its host session id, so it cannot be resumed.");
    return;
  }
  const coordinator = launchCoordinator(record);
  if (!coordinator) {
    await failStart("The session's recorded model choice is not one Prism can pass to a host.");
    return;
  }
  const acp = resolved.acp ?? null;
  const agentVersion = acp?.install ? path.basename(acp.install.folder) : null;
  const workFolder = typeof record.migrationRun === "string" ? record.workdir : record.checkout;
  if (typeof workFolder !== "string" || !workFolder) {
    await failStart("The format migration run's launch has no working folder of its own, so its session cannot start.");
    return;
  }
  const migration = typeof record.migrationRun === "string";
  const migrationServer = migration ? migrationServerDefinition({ run: record.migrationRun, project: record.checkout, launch: record.id, env }) : null;
  let mcpConfig = null;
  if (migration) {
    mcpConfig = path.join(folder2, "mcp-config.json");
    await writeFile(mcpConfig, `${JSON.stringify({ mcpServers: { [MIGRATION_SERVER]: migrationServer } }, null, 2)}
`, { mode: 384 });
  }
  let args;
  try {
    args = hostArguments({
      host: record.host,
      hostSessionId: record.hostSessionId,
      resume,
      coordinator,
      access: record.access ?? "full",
      readRoots: record.readRoots ?? [],
      // A format migration run's Claude Code session is denied every read of the checkout, whatever the person's own settings allow.
      deniedRoots: migration ? [record.checkout] : [],
      mcpConfig,
      acp
    });
  } catch (error) {
    await failStart(error.message);
    return;
  }
  const number = record.runs.length + 1;
  const graceMs = stopGraceMs(env);
  let stderr = Buffer.alloc(0);
  let stderrTrimmed = false;
  let ending = null;
  const watch = (child) => {
    child.stdin.on("error", () => {
    });
    const permissions = permissionBroker({
      folder: folder2,
      launch: record.id,
      run: token2,
      host: record.host,
      hostLabel: resolved.label,
      confirm: async ({ action, reason }) => confirmApproval({ text: approvalText({ initiative: record.initiative === null ? null : await initiativeTitle(record.checkout, record.initiative), artifact: asker?.artifact ?? null, host: resolved.label, action, reason }), env })
    });
    const conversation = hostConversation(record.host, {
      permissions,
      acp: acp && { label: resolved.label, autoMode: acp.autoMode ?? null, env, launch: record.id },
      initiative: record.initiative,
      migrationRun: record.migrationRun ?? null,
      access: record.access ?? "full",
      readRoots: record.readRoots ?? [],
      migrationServer,
      checkout: workFolder,
      hostSessionId: record.hostSessionId,
      resume,
      coordinator,
      // Only the first run starts from the answered gate; a resume continues the conversation that already acted on it.
      asker,
      askerAnswered: record.runs.length === 0,
      answeredGate: !resume && typeof record.answeredGate === "string" && ANSWERED_GATE_PATTERN.test(record.answeredGate) ? record.answeredGate : null,
      send: (message) => child.stdin.write(`${JSON.stringify(message)}
`),
      closeInput: () => child.stdin.end(),
      onSessionId: (id) => update((current) => {
        if (!current.hostSessionId) current.hostSessionId = id;
      }),
      // The run's model is recorded as soon as the host names it, so a running launch already shows it.
      onModel: (model) => update((current) => {
        const run = current.runs.find((entry) => entry.token === token2);
        if (run) run.model = model;
      })
    });
    let started2 = false;
    let heartbeat = null;
    let spoke = false;
    let exited = false;
    let stopping = null;
    let stopDeadline = null;
    let stopPoll = null;
    let markExited;
    const hostEnded = new Promise((done) => {
      markExited = done;
    });
    let markSpawned;
    const spawned = new Promise((done) => {
      markSpawned = done;
    });
    const ended = new Promise((resolve) => {
      child.on("error", (error) => {
        if (started2) return;
        failStart(`${resolved.label} could not be started: ${error.message}`).then(() => {
          markSpawned(false);
          resolve();
        });
      });
      child.once("spawn", () => {
        started2 = true;
        conversation.start();
        const at = (/* @__PURE__ */ new Date()).toISOString();
        update((current) => {
          delete current.startFailure;
          if (current.starting?.token === token2) delete current.starting;
          current.runs.push({ number, cause: cause2, token: token2, supervisorPid: process.pid, hostPid: child.pid, ...acp ? { agentVersion } : {}, startedAt: at, heartbeatAt: at, outputAt: null, model: null, endedAt: null, exit: null, refusals: [], refusalCount: 0, hostError: null, stderr: null, stopGraceMs: graceMs, stopRequestedAt: null });
        }).then(() => markSpawned(true));
        heartbeat = setInterval(() => update((current) => {
          const run = current.runs.find((entry) => entry.token === token2);
          if (run && !run.endedAt) run.heartbeatAt = (/* @__PURE__ */ new Date()).toISOString();
        }), HEARTBEAT_MS);
        let checking = false;
        stopPoll = setInterval(async () => {
          void permissions.poll();
          if (checking || stopping || exited) return;
          checking = true;
          try {
            const request = await readStopRequest(folder2);
            if (request?.token !== token2 || stopping || exited) return;
            const requested = requestTime(request);
            stopDeadline = requested + graceMs + STOP_FINISH_MS;
            const requestedAt = (/* @__PURE__ */ new Date()).toISOString();
            stopping = update((current) => {
              const run = current.runs.find((entry) => entry.token === token2);
              if (run && !run.endedAt && !run.stopRequestedAt) run.stopRequestedAt = requestedAt;
            }).then(async () => {
              if (!exited) conversation.interrupt();
              let timer;
              await Promise.race([hostEnded, new Promise((done) => {
                timer = setTimeout(done, Math.max(0, requested + graceMs - Date.now()));
              })]);
              clearTimeout(timer);
              if (!exited) forceEndHost(child);
            }).catch(() => {
            });
          } finally {
            checking = false;
          }
        }, STOP_POLL_MS);
      });
      child.stdout.on("data", (chunk) => {
        conversation.push(chunk);
        if (spoke) return;
        spoke = true;
        const at = (/* @__PURE__ */ new Date()).toISOString();
        update((current) => {
          const run = current.runs.find((entry) => entry.token === token2);
          if (run && !run.outputAt) run.outputAt = at;
        });
      });
      child.stderr.on("data", (chunk) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > STDERR_HELD) {
          stderr = stderr.subarray(stderr.length - STDERR_HELD);
          stderrTrimmed = true;
        }
      });
      const drained = new Promise((done) => {
        let open = 2;
        const one = () => {
          open -= 1;
          if (open === 0) done();
        };
        child.stdout.once("close", one);
        child.stderr.once("close", one);
      });
      child.once("exit", async (code, signal) => {
        exited = true;
        markExited();
        clearInterval(stopPoll);
        if (!started2) return;
        const endedAt = (/* @__PURE__ */ new Date()).toISOString();
        if (stopping) await stopping;
        const drainMs = stopDeadline === null ? OUTPUT_DRAIN_MS : Math.min(OUTPUT_DRAIN_MS, Math.max(0, stopDeadline + STOP_DRAIN_MS - Date.now()));
        let drainTimer;
        await Promise.race([drained, new Promise((done) => {
          drainTimer = setTimeout(done, drainMs);
        })]);
        clearTimeout(drainTimer);
        const read = stopping ? null : await readStopRequest(folder2);
        const request = read?.token === token2 && requestTime(read) <= Date.parse(endedAt) ? read : null;
        conversation.end();
        await permissions.close();
        clearInterval(heartbeat);
        const { facts } = conversation;
        const kept = keptStderr(stderr, stderrTrimmed, [record.hostSessionId, facts.hostSessionId, facts.agentSessionId]);
        await writeAtomically(path.join(folder2, `run-${number}.stderr`), kept, { mode: 384 }).catch(() => {
        });
        ending = { normal: acp ? facts.settled && facts.stopReason === "end_turn" : true, lastMessage: facts.lastMessage };
        const { markResultCheck } = await import("./launched-sessions.mjs");
        await markResultCheck({ id: record.id, token: token2, env }).catch(() => {
        });
        await update((current) => {
          if (!current.hostSessionId && facts.hostSessionId) current.hostSessionId = facts.hostSessionId;
          const run = current.runs.find((entry) => entry.token === token2);
          if (!run) return;
          const last = lastReasonLine(redactSessionId(kept, current.hostSessionId));
          Object.assign(run, { endedAt, model: facts.model, exit: { code: code ?? null, signal: signal ?? null }, refusals: facts.refusals, refusalCount: facts.refusalCount, hostError: facts.hostError, failure: facts.failure, stderr: last?.slice(0, STDERR_LINE_MAX) ?? null, ...acp ? { usage: facts.usage, settled: facts.settled, ownToolAllows: facts.ownToolAllows } : {} });
          if (!run.stopRequestedAt && request) run.stopRequestedAt = new Date(requestTime(request)).toISOString();
        });
        resolve();
      });
    });
    return { spawned, ended };
  };
  const started = await withRunStartLock(folder2, async () => {
    const current = await readLaunchRecord(folder2);
    if (!current || tokenVoided(current, token2)) return null;
    if (acp?.install && !existsSync(acp.install.folder)) {
      await failStart(`${resolved.label} could not be started: its version ${agentVersion} is no longer installed.`);
      return null;
    }
    let child;
    try {
      child = spawn(resolved.command, [...resolved.prefix, ...args], { cwd: workFolder, env: acp ? hostEnvironment(env, record.id, null, null, acp) : env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      await failStart(`${resolved.label} could not be started: ${error.message}`);
      return null;
    }
    const watched = watch(child);
    await watched.spawned;
    return { ended: watched.ended };
  });
  if (!started) await update((current) => {
    if (current.starting?.token === token2) delete current.starting;
  });
  if (started) {
    const { withdrawRunQuestions } = await import("./launched-sessions.mjs");
    await withdrawRunQuestions({ id: record.id, env }).catch(() => {
    });
    await started.ended;
  }
  await queue;
  if (started && agentVersion !== null) {
    const { sweepUnusedVersions } = await import("./agent-installs.mjs");
    await sweepUnusedVersions(env, [acp.id]);
  }
  if (started && typeof record.migrationRun === "string") {
    await reportRunEnd(folder2, token2).catch(() => {
    });
    return;
  }
  if (started) {
    const { resumeForAnswers, settleRunResult } = await import("./launched-sessions.mjs");
    const resumed = await resumeForAnswers({ id: record.id, token: token2, env }).catch(() => false);
    const ended = ending;
    await settleRunResult({ id: record.id, token: token2, normal: ended?.normal === true, resumed, lastMessage: ended?.lastMessage ?? null, env }).catch(() => {
    });
  }
}
async function reportRunEnd(folder2, token2) {
  const record = await readLaunchRecord(folder2);
  const run = record?.runs.find((entry) => entry.token === token2);
  if (!run?.endedAt || record.runs.at(-1) !== run) return;
  const view = launchView(record);
  const exit = run.exit?.signal ? `signal ${run.exit.signal}` : `exit code ${run.exit?.code ?? "unknown"}`;
  const reason = view.reason ?? (view.state === "stopped" ? `${view.hostLabel} was stopped.` : `${view.hostLabel} ended with ${exit}.`);
  const { sessionEnded } = await import("../workflow/migration-runs.mjs");
  await sessionEnded(record.checkout, record.migrationRun, { launch: record.id, reason, endedAt: run.endedAt });
}
const [folder, cause, token] = process.argv.slice(2);
if (folder && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  superviseRun({ folder, cause: ["launch", "person", "gate"].includes(cause) ? cause : "person", token: token ?? "" }).catch(() => {
  }).finally(() => process.exit(0));
}
export {
  keptStderr,
  lastReasonLine,
  superviseRun
};
