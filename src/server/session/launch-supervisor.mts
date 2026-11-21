#!/usr/bin/env node
// The detached supervisor of one run of a launched session: node launch-supervisor.mjs <launch folder> <cause> <token>.
// It starts the run's host in the checkout with its own environment, which the starter prepared, holds the host's standard input,
// gives the host its prompt there and closes it once the host's work is over, reads the host's output, renews the heartbeat in the
// launch record, and records the run's end with the host's exit code and signal.
// It watches its launch folder for a stop request that names its run, and then sends the host the interrupt of the host's own Stop
// button, closes the host's input once the host answered it, and only when the host still runs after the grace period ends the host
// process itself through the handle of the child process it started. It starts, watches, and signals only the host process, never
// a process that the host started.
// It names its launch folder on its command line, so any process on this machine can find it.
// After a run that exited 0, it resumes the session once when the person answered here, during the run, a gate that is still pending.
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeAtomically } from "../workflow/artifact-store.mjs";
import { launchCoordinator, readLaunchRecord, readStopRequest, stopGraceMs, tokenVoided, withRunStartLock, writeLaunchRecord, HEARTBEAT_MS } from "./launch-records.mjs";
import { hostArguments, hostConversation, hostEnvironment, redactSessionId, resolveHost, validHostSessionId } from "./launch-hosts.mjs";

// The tail of a host's standard error that a run keeps in run-<n>.stderr of its launch folder, with the host session id redacted.
const STDERR_KEEP = 64 * 1024;
const STDERR_LINE_MAX = 300;
// A stack frame: a line whose first word after spaces is `at`.
const STACK_FRAME = /^\s*at(\s|$)/;
const OUTPUT_DRAIN_MS = 2000;
// After a stop's forced end, the output is drained for at most this long past the stop's deadline, so the end is recorded in time.
const STOP_DRAIN_MS = 500;
const STOP_POLL_MS = 100;
// After the grace period, the forced end and the recording of the run's end finish within this long, inside the grace period
// and 5 seconds that a stop answers within.
const STOP_FINISH_MS = 2000;

// Forcibly ends the host process alone, through the handle of the child process that this supervisor started, on every platform:
// on POSIX SIGKILL reaches the host while Node has not reaped it, and on Windows the process that the handle holds is terminated,
// so neither a process that the host started nor one that reused an ended host's id is ever hit. Once Node has seen the host
// exit, the handle sends nothing; no process is ever ended by a looked-up process id.
function forceEndHost(child: any) {
  try { child.kill("SIGKILL"); } catch {}
}

/** The last non-blank line of a host's standard error that is no stack frame, or null. */
export function lastReasonLine(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !STACK_FRAME.test(line)).at(-1) ?? null;
}

// The time of a stop request, never later than now.
function requestTime(request: any) {
  const at = Date.parse(request?.requestedAt ?? "");
  return Number.isFinite(at) ? Math.min(at, Date.now()) : Date.now();
}

export async function superviseRun({ folder, cause, token, env = process.env }: { folder: string; cause: any; token: string; env?: NodeJS.ProcessEnv }) {
  let queue = Promise.resolve();
  const update = (change: any) => {
    queue = queue.then(async () => {
      const record = await readLaunchRecord(folder);
      if (!record) return;
      change(record);
      await writeLaunchRecord(folder, record);
    }).catch(() => {});
    return queue;
  };
  const failStart = (message: any) => update((record: any) => { record.startFailure = { token, message, at: new Date().toISOString() }; });

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
  // Every run, the first and each resume, passes the choice that the launch recorded, never the settings of the moment.
  const coordinator = launchCoordinator(record);
  if (!coordinator) {
    await failStart("The session's recorded model choice is not one Prism can pass to a host.");
    return;
  }
  // An ACP agent runs with the arguments and environment of its declaration or install record.
  const acp: any = (resolved as any).acp ?? null;
  const args = hostArguments({ host: record.host, hostSessionId: record.hostSessionId, resume, coordinator, acp });
  const number = record.runs.length + 1;
  const graceMs = stopGraceMs(env);
  let stderr = Buffer.alloc(0);

  // Every listener is attached as soon as the host process exists, so no early output or exit is missed.
  const watch = (child: any) => {
    // The host's input is written only through the conversation, which closes it once the host's work is over.
    child.stdin.on("error", () => {});
    const conversation = hostConversation(record.host, {
      acp: acp && { label: resolved.label, autoMode: acp.autoMode ?? null, env, launch: record.id, agentPid: () => child.pid ?? null },
      initiative: record.initiative,
      checkout: record.checkout,
      hostSessionId: record.hostSessionId,
      resume,
      coordinator,
      send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
      closeInput: () => child.stdin.end(),
      onSessionId: (id) => update((current: any) => { if (!current.hostSessionId) current.hostSessionId = id; }),
      // The run's model is recorded as soon as the host names it, so a running launch already shows it.
      onModel: (model) => update((current: any) => {
        const run = current.runs.find((entry: any) => entry.token === token);
        if (run) run.model = model;
      })
    });
    let started = false;
    let heartbeat: any = null;
    let spoke = false;
    let exited = false;
    let stopping: any = null;
    let stopDeadline: any = null;
    let stopPoll: any = null;
    let markExited: any;
    const hostEnded = new Promise<void>((done) => { markExited = done; });
    let markSpawned: any;
    const spawned = new Promise<void>((done) => { markSpawned = done; });
    const ended = new Promise<void>((resolve) => {
      child.on("error", (error: any) => {
        if (started) return;
        failStart(`${resolved.label} could not be started: ${error.message}`).then(() => { markSpawned(false); resolve(); });
      });
      child.once("spawn", () => {
        started = true;
        conversation.start();
        const at = new Date().toISOString();
        update((current: any) => {
          delete current.startFailure;
          current.runs.push({ number, cause, token, supervisorPid: process.pid, hostPid: child.pid, startedAt: at, heartbeatAt: at, outputAt: null, model: null, endedAt: null, exit: null, refusals: [], refusalCount: 0, hostError: null, stderr: null, stopGraceMs: graceMs, stopRequestedAt: null });
        }).then(() => markSpawned(true));
        heartbeat = setInterval(() => update((current: any) => {
          const run = current.runs.find((entry: any) => entry.token === token);
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
            stopping = update((current: any) => {
              const run = current.runs.find((entry: any) => entry.token === token);
              if (run && !run.endedAt && !run.stopRequestedAt) run.stopRequestedAt = requestedAt;
            }).then(async () => {
              // The host's own interrupt; the conversation closes the input once the host answers it, so the host exits by itself.
              if (!exited) conversation.interrupt();
              let timer;
              await Promise.race([hostEnded, new Promise<void>((done) => { timer = setTimeout(done, Math.max(0, requested + graceMs - Date.now())); })]);
              clearTimeout(timer);
              // The end goes through the held child process handle, which no longer reaches anything once the host has exited.
              if (!exited) forceEndHost(child);
            }).catch(() => {});
          } finally {
            checking = false;
          }
        }, STOP_POLL_MS);
      });
      child.stdout.on("data", (chunk: any) => {
        conversation.push(chunk);
        if (spoke) return;
        spoke = true;
        const at = new Date().toISOString();
        update((current: any) => {
          const run = current.runs.find((entry: any) => entry.token === token);
          if (run && !run.outputAt) run.outputAt = at;
        });
      });
      child.stderr.on("data", (chunk: any) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > STDERR_KEEP) stderr = stderr.subarray(stderr.length - STDERR_KEEP);
      });
      const drained = new Promise<void>((done) => {
        let open = 2;
        const one = () => { open -= 1; if (open === 0) done(); };
        child.stdout.once("close", one);
        child.stderr.once("close", one);
      });
      child.once("exit", async (code: any, signal: any) => {
        exited = true;
        markExited();
        clearInterval(stopPoll);
        if (!started) return;
        const endedAt = new Date().toISOString();
        if (stopping) await stopping;
        const drainMs = stopDeadline === null ? OUTPUT_DRAIN_MS : Math.min(OUTPUT_DRAIN_MS, Math.max(0, stopDeadline + STOP_DRAIN_MS - Date.now()));
        let drainTimer;
        await Promise.race([drained, new Promise<void>((done) => { drainTimer = setTimeout(done, drainMs); })]);
        clearTimeout(drainTimer);
        // A stop request for this run that the poll had not read yet when the host ended still makes the end a stopped one,
        // while a request written after the host ended on its own, during the drain, leaves the end as the host's.
        const read = stopping ? null : await readStopRequest(folder);
        const request = read?.token === token && requestTime(read) <= Date.parse(endedAt) ? read : null;
        conversation.end();
        clearInterval(heartbeat);
        const { facts } = conversation;
        // The id is replaced before the text is cut, so no cut leaves part of it behind.
        const kept = redactSessionId(stderr.toString("utf8"), record.hostSessionId ?? facts.hostSessionId);
        await writeAtomically(path.join(folder, `run-${number}.stderr`), kept, { mode: 0o600 }).catch(() => {});
        await update((current: any) => {
          if (!current.hostSessionId && facts.hostSessionId) current.hostSessionId = facts.hostSessionId;
          const run = current.runs.find((entry: any) => entry.token === token);
          if (!run) return;
          const last = lastReasonLine(redactSessionId(kept, current.hostSessionId));
          Object.assign(run, { endedAt, model: facts.model, exit: { code: code ?? null, signal: signal ?? null }, refusals: facts.refusals, refusalCount: facts.refusalCount, hostError: facts.hostError, failure: facts.failure, stderr: last?.slice(0, STDERR_LINE_MAX) ?? null, ...(acp ? { usage: facts.usage } : {}) });
          if (!run.stopRequestedAt && request) run.stopRequestedAt = new Date(requestTime(request)).toISOString();
        });
        resolve();
      });
    });
    return { spawned, ended };
  };

  // The host starts only under the run-start lock and only while the starter has not voided this token,
  // and the run is recorded before the lock is released, so a starter that gives up either sees the run or stops this start.
  const started: any = await withRunStartLock(folder, async () => {
    const current = await readLaunchRecord(folder);
    if (!current || tokenVoided(current, token)) return null;
    let child;
    try {
      child = (spawn as any)(resolved.command, [...resolved.prefix, ...args], { cwd: record.checkout, env: acp ? hostEnvironment(env, record.id, acp) : env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
  // A run that exited 0 with an answer given here while it ran, whose gate is still pending, is resumed once for that answer.
  if (started) {
    const { resumeForAnswers } = await import("./launched-sessions.mjs");
    await resumeForAnswers({ id: record.id, token, env }).catch(() => {});
  }
}

const [folder, cause, token] = process.argv.slice(2);
if (folder && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Errors are caught so a failing write never leaves an unhandled rejection behind; the launch view then shows the lost supervision.
  superviseRun({ folder, cause: ["launch", "person", "gate"].includes(cause) ? cause : "person", token: token ?? "" }).catch(() => {}).finally(() => process.exit(0));
}
