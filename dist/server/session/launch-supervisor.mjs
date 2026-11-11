#!/usr/bin/env node
// The detached supervisor of one run of a launched session: node launch-supervisor.mjs <launch folder> <cause> <token>.
// It starts the run's host in the checkout with its own environment, which the starter prepared, holds the host's standard input,
// gives the host its prompt there and closes it once the host's work is over, reads the host's output, renews the heartbeat in the
// launch record, and records the run's end with the host's exit code and signal.
// It watches its launch folder for a stop request that names its run, and then sends the host the interrupt of the host's own Stop
// button, closes the host's input once the host answered it, and only when the host still runs after the grace period ends the host
// process itself. It starts, watches, and signals only the host process, never a process that the host started.
// It names its launch folder on its command line, so any process on this machine can find it.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readLaunchRecord, readStopRequest, stopGraceMs, tokenVoided, withRunStartLock, writeLaunchRecord, HEARTBEAT_MS } from "./launch-records.mjs";
import { hostArguments, hostConversation, redactSessionId, resolveHost, validHostSessionId } from "./launch-hosts.mjs";

const STDERR_KEEP = 64 * 1024;
const OUTPUT_DRAIN_MS = 2000;
// After a stop's forced end, the output is drained for at most this long past the stop's deadline, so the end is recorded in time.
const STOP_DRAIN_MS = 500;
const STOP_POLL_MS = 100;
// After the grace period, the forced end and the recording of the run's end finish within this long, inside the grace period
// and 5 seconds that a stop answers within.
const STOP_FINISH_MS = 2000;
const TASKKILL_TIMEOUT_MS = 2000;

// Forcibly ends the host process alone: SIGKILL to its process id on POSIX, and `taskkill /PID <pid> /F` without /T on Windows,
// so no process that the host started is ended.
function forceEndHost(child) {
  if (process.platform !== "win32") {
    try { child.kill("SIGKILL"); } catch {}
    return Promise.resolve();
  }
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const system = path.join(root, "System32", "taskkill.exe");
  const taskkill = existsSync(system) ? system : "taskkill.exe";
  return new Promise((done) => {
    execFile(taskkill, ["/PID", String(child.pid), "/F"], { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, () => done());
  });
}

// The time of a stop request, never later than now.
function requestTime(request) {
  const at = Date.parse(request?.requestedAt ?? "");
  return Number.isFinite(at) ? Math.min(at, Date.now()) : Date.now();
}

export async function superviseRun({ folder, cause, token, env = process.env }) {
  let queue = Promise.resolve();
  const update = (change) => {
    queue = queue.then(async () => {
      const record = await readLaunchRecord(folder);
      if (!record) return;
      change(record);
      await writeLaunchRecord(folder, record);
    }).catch(() => {});
    return queue;
  };
  const failStart = (message) => update((record) => { record.startFailure = { token, message, at: new Date().toISOString() }; });

  const record = await readLaunchRecord(folder);
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
  const args = hostArguments({ host: record.host, hostSessionId: record.hostSessionId, resume });
  const number = record.runs.length + 1;
  const graceMs = stopGraceMs(env);
  let stderr = Buffer.alloc(0);

  // Every listener is attached as soon as the host process exists, so no early output or exit is missed.
  const watch = (child) => {
    // The host's input is written only through the conversation, which closes it once the host's work is over.
    child.stdin.on("error", () => {});
    const conversation = hostConversation(record.host, {
      initiative: record.initiative,
      checkout: record.checkout,
      hostSessionId: record.hostSessionId,
      resume,
      send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
      closeInput: () => child.stdin.end(),
      onSessionId: (id) => update((current) => { if (!current.hostSessionId) current.hostSessionId = id; })
    });
    let started = false;
    let heartbeat = null;
    let spoke = false;
    let exited = false;
    let stopping = null;
    let stopDeadline = null;
    let stopPoll = null;
    let markExited;
    const hostEnded = new Promise((done) => { markExited = done; });
    let markSpawned;
    const spawned = new Promise((done) => { markSpawned = done; });
    const ended = new Promise((resolve) => {
      child.on("error", (error) => {
        if (started) return;
        failStart(`${resolved.label} could not be started: ${error.message}`).then(() => { markSpawned(false); resolve(); });
      });
      child.once("spawn", () => {
        started = true;
        conversation.start();
        const at = new Date().toISOString();
        update((current) => {
          delete current.startFailure;
          current.runs.push({ number, cause, token, supervisorPid: process.pid, hostPid: child.pid, startedAt: at, heartbeatAt: at, outputAt: null, endedAt: null, exit: null, refusals: [], refusalCount: 0, hostError: null, stderr: null, stopGraceMs: graceMs, stopRequestedAt: null });
        }).then(() => markSpawned(true));
        heartbeat = setInterval(() => update((current) => {
          const run = current.runs.find((entry) => entry.token === token);
          if (run && !run.endedAt) run.heartbeatAt = new Date().toISOString();
        }), HEARTBEAT_MS);
        // A stop request counts only for this run's token; the stop is recorded before the host is asked to end.
        let checking = false;
        stopPoll = setInterval(async () => {
          if (checking || stopping || exited) return;
          checking = true;
          try {
            const request = await readStopRequest(folder);
            if (request?.token !== token || stopping || exited) return;
            // The grace period and the stop's deadline count from the request, not from this poll.
            const requested = requestTime(request);
            stopDeadline = requested + graceMs + STOP_FINISH_MS;
            const requestedAt = new Date().toISOString();
            stopping = update((current) => {
              const run = current.runs.find((entry) => entry.token === token);
              if (run && !run.endedAt && !run.stopRequestedAt) run.stopRequestedAt = requestedAt;
            }).then(async () => {
              // The host's own interrupt; the conversation closes the input once the host answers it, so the host exits by itself.
              if (!exited) conversation.interrupt();
              let timer;
              await Promise.race([hostEnded, new Promise((done) => { timer = setTimeout(done, Math.max(0, requested + graceMs - Date.now())); })]);
              clearTimeout(timer);
              // The host is this supervisor's own child, so its process id cannot be reused before the exit event, which sets exited.
              if (!exited) await forceEndHost(child);
            }).catch(() => {});
          } finally {
            checking = false;
          }
        }, STOP_POLL_MS);
      });
      child.stdout.on("data", (chunk) => {
        conversation.push(chunk);
        if (spoke) return;
        spoke = true;
        const at = new Date().toISOString();
        update((current) => {
          const run = current.runs.find((entry) => entry.token === token);
          if (run && !run.outputAt) run.outputAt = at;
        });
      });
      child.stderr.on("data", (chunk) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > STDERR_KEEP) stderr = stderr.subarray(stderr.length - STDERR_KEEP);
      });
      const drained = new Promise((done) => {
        let open = 2;
        const one = () => { open -= 1; if (open === 0) done(); };
        child.stdout.once("close", one);
        child.stderr.once("close", one);
      });
      child.once("exit", async (code, signal) => {
        exited = true;
        markExited();
        clearInterval(stopPoll);
        if (!started) return;
        const endedAt = new Date().toISOString();
        if (stopping) await stopping;
        const drainMs = stopDeadline === null ? OUTPUT_DRAIN_MS : Math.min(OUTPUT_DRAIN_MS, Math.max(0, stopDeadline + STOP_DRAIN_MS - Date.now()));
        let drainTimer;
        await Promise.race([drained, new Promise((done) => { drainTimer = setTimeout(done, drainMs); })]);
        clearTimeout(drainTimer);
        // A stop request for this run that the poll had not read yet when the host ended still makes the end a stopped one,
        // while a request written after the host ended on its own, during the drain, leaves the end as the host's.
        const read = stopping ? null : await readStopRequest(folder);
        const request = read?.token === token && requestTime(read) <= Date.parse(endedAt) ? read : null;
        conversation.end();
        clearInterval(heartbeat);
        const { facts } = conversation;
        const lines = stderr.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        await update((current) => {
          if (!current.hostSessionId && facts.hostSessionId) current.hostSessionId = facts.hostSessionId;
          const run = current.runs.find((entry) => entry.token === token);
          if (!run) return;
          // The id is replaced before the line is cut, so no cut leaves part of it behind.
          const last = redactSessionId(lines.at(-1) ?? null, current.hostSessionId);
          Object.assign(run, { endedAt, exit: { code: code ?? null, signal: signal ?? null }, refusals: facts.refusals, refusalCount: facts.refusalCount, hostError: facts.hostError, stderr: last?.slice(0, 300) ?? null });
          if (!run.stopRequestedAt && request) run.stopRequestedAt = new Date(requestTime(request)).toISOString();
        });
        resolve();
      });
    });
    return { spawned, ended };
  };

  // The host starts only under the run-start lock and only while the starter has not voided this token,
  // and the run is recorded before the lock is released, so a starter that gives up either sees the run or stops this start.
  const started = await withRunStartLock(folder, async () => {
    const current = await readLaunchRecord(folder);
    if (!current || tokenVoided(current, token)) return null;
    let child;
    try {
      child = spawn(resolved.command, [...resolved.prefix, ...args], { cwd: record.checkout, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      await failStart(`${resolved.label} could not be started: ${error.message}`);
      return null;
    }
    const watched = watch(child);
    await watched.spawned;
    // Wrapped, so the lock is released once the run is recorded rather than when the host ends.
    return { ended: watched.ended };
  });
  if (started) await started.ended;
  await queue;
}

const [folder, cause, token] = process.argv.slice(2);
if (folder && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Errors are caught so a failing write never leaves an unhandled rejection behind; the launch view then shows the lost supervision.
  superviseRun({ folder, cause: ["launch", "person", "gate"].includes(cause) ? cause : "person", token: token ?? "" }).catch(() => {}).finally(() => process.exit(0));
}
