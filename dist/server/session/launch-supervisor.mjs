#!/usr/bin/env node
// Generated from src/server/session/launch-supervisor.mts by scripts/native-build/compile.mjs.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { launchCoordinator, readLaunchRecord, readStopRequest, stopGraceMs, tokenVoided, withRunStartLock, writeLaunchRecord, HEARTBEAT_MS } from "./launch-records.mjs";
import { hostArguments, hostConversation, redactSessionId, resolveHost, validHostSessionId } from "./launch-hosts.mjs";
const STDERR_KEEP = 64 * 1024;
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
function requestTime(request) {
  const at = Date.parse(request?.requestedAt ?? "");
  return Number.isFinite(at) ? Math.min(at, Date.now()) : Date.now();
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
  });
  const record = await readLaunchRecord(folder2);
  if (!record) return;
  const resume = record.runs.length > 0;
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
  const args = hostArguments({ host: record.host, hostSessionId: record.hostSessionId, resume, coordinator });
  const number = record.runs.length + 1;
  const graceMs = stopGraceMs(env);
  let stderr = Buffer.alloc(0);
  const watch = (child) => {
    child.stdin.on("error", () => {
    });
    const conversation = hostConversation(record.host, {
      initiative: record.initiative,
      checkout: record.checkout,
      hostSessionId: record.hostSessionId,
      resume,
      coordinator,
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
          current.runs.push({ number, cause: cause2, token: token2, supervisorPid: process.pid, hostPid: child.pid, startedAt: at, heartbeatAt: at, outputAt: null, model: null, endedAt: null, exit: null, refusals: [], refusalCount: 0, hostError: null, stderr: null, stopGraceMs: graceMs, stopRequestedAt: null });
        }).then(() => markSpawned(true));
        heartbeat = setInterval(() => update((current) => {
          const run = current.runs.find((entry) => entry.token === token2);
          if (run && !run.endedAt) run.heartbeatAt = (/* @__PURE__ */ new Date()).toISOString();
        }), HEARTBEAT_MS);
        let checking = false;
        stopPoll = setInterval(async () => {
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
        if (stderr.length > STDERR_KEEP) stderr = stderr.subarray(stderr.length - STDERR_KEEP);
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
        clearInterval(heartbeat);
        const { facts } = conversation;
        const lines = stderr.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        await update((current) => {
          if (!current.hostSessionId && facts.hostSessionId) current.hostSessionId = facts.hostSessionId;
          const run = current.runs.find((entry) => entry.token === token2);
          if (!run) return;
          const last = redactSessionId(lines.at(-1) ?? null, current.hostSessionId);
          Object.assign(run, { endedAt, model: facts.model, exit: { code: code ?? null, signal: signal ?? null }, refusals: facts.refusals, refusalCount: facts.refusalCount, hostError: facts.hostError, stderr: last?.slice(0, 300) ?? null });
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
    let child;
    try {
      child = spawn(resolved.command, [...resolved.prefix, ...args], { cwd: record.checkout, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      await failStart(`${resolved.label} could not be started: ${error.message}`);
      return null;
    }
    const watched = watch(child);
    await watched.spawned;
    return { ended: watched.ended };
  });
  if (started) await started.ended;
  await queue;
  if (started) {
    const { resumeForAnswers } = await import("./launched-sessions.mjs");
    await resumeForAnswers({ id: record.id, token: token2, env }).catch(() => {
    });
  }
}
const [folder, cause, token] = process.argv.slice(2);
if (folder && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  superviseRun({ folder, cause: ["launch", "person", "gate"].includes(cause) ? cause : "person", token: token ?? "" }).catch(() => {
  }).finally(() => process.exit(0));
}
export {
  superviseRun
};
