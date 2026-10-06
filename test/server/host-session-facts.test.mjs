import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fileSystem from "node:fs/promises";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { recordSessionFacts } from "../../dist/hooks/record-session-facts.mjs";
import { createCodexHostAdapter } from "../../dist/server/session/host-adapters/codex.mjs";
import {
  HOST_FACT_REASON,
  createHostSessionFactRecord,
  createSessionCorrelationKey,
  readHostSessionFacts,
  validateHostSessionFacts,
  writeHostSessionFacts
} from "../../dist/server/session/host-session-facts.mjs";

const observedAt = "2026-09-19T12:00:00.000Z";
const sessionId = "thr_private_session_identifier";
const projectRoot = "/workspace/private-project";
const correlationKey = createSessionCorrelationKey(sessionId);

function factRecord(id, time = observedAt) {
  return createHostSessionFactRecord({
    sessionId: id,
    projectRoot,
    observedAt: time,
    status: "SUPPORTED",
    host: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol"
    },
    capacityOverrides: {
      contextWindowTokens: 272000,
      compactionThresholdTokens: 244800
    },
    compactionScope: "total",
    sources: {
      harness: "codex-adapter",
      harnessVersion: "transcript.session_meta.cli_version",
      provider: "transcript.session_meta.model_provider",
      model: "hook.model",
      contextWindowTokens: "hook.model_context_window",
      compactionThresholdTokens: "hook.model_auto_compact_token_limit",
      compactionScope: "hook.model_auto_compact_token_limit_scope"
    }
  });
}

function transcriptMetadata(overrides = {}) {
  return async (identity) => {
    assert.equal(identity.sessionId, sessionId);
    assert.equal(identity.projectRoot, projectRoot);
    return {
      status: "SUPPORTED",
      execution: "root",
      harnessVersion: "0.147.0",
      provider: "openai",
      projectRoot,
      ...overrides
    };
  };
}

function supportedAdapter(metadataOverrides = {}) {
  return createCodexHostAdapter({
    now: () => new Date(observedAt),
    inspectTranscriptMetadata: transcriptMetadata(metadataOverrides)
  });
}

async function captureSupported(adapter = supportedAdapter(), hookOverrides = {}) {
  return adapter.capture({
    hookInput: {
      session_id: sessionId,
      transcript_path: "/private/transcript.jsonl",
      cwd: projectRoot,
      model: "gpt-5.6-sol",
      model_context_window: 272000,
      model_auto_compact_token_limit: 244800,
      model_auto_compact_token_limit_scope: "total",
      prompt: "private prompt text",
      tool_input: { command: "cat private-source.js" },
      tool_response: "private source response",
      ...hookOverrides
    },
    environment: {
      CODEX_VERSION: "must-not-be-used",
      OPENAI_API_KEY: "private-api-key",
      PATH: "/private/binary/path"
    }
  });
}

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function pauseBeforeTemporaryWrite(reached, resume) {
  return {
    ...fileSystem,
    async open(target, ...argumentsValue) {
      if (typeof target === "string" && target.endsWith(".tmp")) {
        reached.resolve();
        await resume.promise;
      }
      return fileSystem.open(target, ...argumentsValue);
    }
  };
}

test("captures only correlated transcript identity and direct hook capacity", async () => {
  const capture = await captureSupported();

  assert.equal(capture.status, "SUPPORTED");
  assert.equal(capture.record.host.harness, "codex-cli");
  assert.equal(capture.record.host.harnessVersion, "0.147.0");
  assert.equal(capture.record.host.provider, "openai");
  assert.equal(capture.record.host.model, "gpt-5.6-sol");
  assert.deepEqual(capture.record.capacityOverrides, {
    contextWindowTokens: 272000,
    compactionThresholdTokens: 244800
  });
  assert.equal(capture.record.compactionScope, "total");
  assert.deepEqual(capture.record.sources, {
    harness: "codex-adapter",
    harnessVersion: "transcript.session_meta.cli_version",
    provider: "transcript.session_meta.model_provider",
    model: "hook.model",
    contextWindowTokens: "hook.model_context_window",
    compactionThresholdTokens: "hook.model_auto_compact_token_limit",
    compactionScope: "hook.model_auto_compact_token_limit_scope"
  });
  assert.equal(validateHostSessionFacts(capture.record), true);

  const serialized = JSON.stringify(capture.record);
  for (const privateValue of [
    sessionId,
    projectRoot,
    "/private/transcript.jsonl",
    "private prompt text",
    "cat private-source.js",
    "private source response",
    "private-api-key",
    "/private/binary/path",
    "must-not-be-used"
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("resolves Desktop capacity from transcript context and effective config defaults", async () => {
  const adapter = createCodexHostAdapter({
    now: () => new Date(observedAt),
    inspectTranscriptMetadata: transcriptMetadata({
      contextWindowTokens: 258400,
      contextWindowSource: "transcript.event_msg.token_count.info.model_context_window"
    }),
    readEffectiveConfig: async ({ cwd }) => {
      assert.equal(cwd, projectRoot);
      return {
        status: "SUPPORTED",
        config: {
          model: "gpt-5.6-sol",
          model_context_window: null,
          model_auto_compact_token_limit: null,
          model_auto_compact_token_limit_scope: null
        },
        provenance: {
          source: "codex-app-server-config-read",
          sourceVersion: "codex-cli 0.155.1",
          verifiedAt: observedAt,
          fields: {
            model: "config.model",
            model_context_window: "config.model_context_window",
            model_auto_compact_token_limit: null,
            model_auto_compact_token_limit_scope: null
          }
        }
      };
    }
  });

  const capture = await adapter.capture({
    hookInput: {
      session_id: sessionId,
      transcript_path: "/private/transcript.jsonl",
      cwd: projectRoot,
      model: "gpt-5.6-sol",
      hook_event_name: "PreToolUse"
    }
  });

  assert.equal(capture.status, "SUPPORTED");
  assert.deepEqual(capture.record.capacityOverrides, { contextWindowTokens: 258400 });
  assert.equal(capture.record.compactionScope, "total");
  assert.equal(capture.record.sources.contextWindowTokens, "transcript.event_msg.token_count.info.model_context_window");
  assert.equal(capture.record.sources.compactionThresholdTokens, "config.absent.model_auto_compact_token_limit");
  assert.equal(capture.record.sources.compactionScope, "config.default.model_auto_compact_token_limit_scope");
});

test("derives the reviewed default threshold from an explicit context override", async () => {
  const adapter = createCodexHostAdapter({
    now: () => new Date(observedAt),
    inspectTranscriptMetadata: transcriptMetadata({
      contextWindowTokens: 285000,
      contextWindowSource: "transcript.event_msg.token_count.info.model_context_window"
    }),
    readEffectiveConfig: async () => ({
      status: "SUPPORTED",
      config: {
        model: "gpt-5.6-sol",
        model_context_window: 300000,
        model_auto_compact_token_limit: null,
        model_auto_compact_token_limit_scope: null
      }
    })
  });

  const capture = await adapter.capture({
    hookInput: {
      session_id: sessionId,
      transcript_path: "/private/transcript.jsonl",
      cwd: projectRoot,
      model: "gpt-5.6-sol",
      hook_event_name: "PreToolUse"
    }
  });

  assert.equal(capture.status, "SUPPORTED");
  assert.deepEqual(capture.record.capacityOverrides, {
    contextWindowTokens: 285000,
    compactionThresholdTokens: 270000
  });
  assert.equal(
    capture.record.sources.compactionThresholdTokens,
    "registry.derived.model_auto_compact_token_limit"
  );
});

test("fails closed while retaining correlated identity when direct capacity is incomplete", async () => {
  const capture = await captureSupported(supportedAdapter(), {
    model_auto_compact_token_limit: undefined,
    model_auto_compact_token_limit_scope: undefined
  });

  assert.equal(capture.status, "UNSUPPORTED");
  assert.equal(capture.reasonCode, HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE);
  assert.deepEqual(capture.record.host, {
    harness: "codex-cli",
    harnessVersion: "0.147.0",
    provider: "openai",
    model: "gpt-5.6-sol"
  });
  assert.deepEqual(capture.record.capacityOverrides, { contextWindowTokens: 272000 });
  assert.equal(capture.record.compactionScope, null);
});

test("fails closed when transcript metadata drifts or identifies a subagent", async () => {
  const drifted = createCodexHostAdapter({
    now: () => new Date(observedAt),
    inspectTranscriptMetadata: async () => ({ status: "UNSUPPORTED", reasonCode: "SESSION_MISMATCH" })
  });
  const driftedCapture = await captureSupported(drifted);
  const subagentCapture = await captureSupported(supportedAdapter({ execution: "subagent" }));

  assert.equal(driftedCapture.reasonCode, HOST_FACT_REASON.HOST_METADATA_UNAVAILABLE);
  assert.equal(driftedCapture.record, null);
  assert.equal(subagentCapture.reasonCode, HOST_FACT_REASON.UNSUPPORTED_EXECUTION);
  assert.equal(subagentCapture.record, null);
});

test("keys adapter facts to the canonical transcript root when the hook runs in a child directory", async () => {
  const hookRoot = path.join(projectRoot, "nested");
  const adapter = createCodexHostAdapter({
    now: () => new Date(observedAt),
    inspectTranscriptMetadata: async (identity) => {
      assert.equal(identity.projectRoot, hookRoot);
      return {
        status: "SUPPORTED",
        execution: "root",
        harnessVersion: "0.147.0",
        provider: "openai",
        projectRoot,
        contextWindowTokens: 272000,
        contextWindowSource: "transcript.event_msg.token_count.info.model_context_window"
      };
    },
    readEffectiveConfig: async ({ cwd }) => {
      assert.equal(cwd, hookRoot);
      return {
        status: "SUPPORTED",
        config: {
          model: "gpt-5.6-sol",
          model_context_window: null,
          model_auto_compact_token_limit: 244800,
          model_auto_compact_token_limit_scope: "total"
        }
      };
    }
  });

  const capture = await captureSupported(adapter, {
    cwd: hookRoot,
    hook_event_name: "PreToolUse"
  });

  assert.equal(capture.status, "SUPPORTED");
  assert.equal(capture.record.projectDigest, factRecord(sessionId).projectDigest);
});

test("fails closed for a body-after-prefix compaction scope", async () => {
  const capture = await captureSupported(supportedAdapter(), {
    model_auto_compact_token_limit_scope: "body_after_prefix"
  });

  assert.equal(capture.status, "UNSUPPORTED");
  assert.equal(capture.reasonCode, HOST_FACT_REASON.UNSUPPORTED_COMPACTION_SCOPE);
  assert.equal(capture.record.compactionScope, "body_after_prefix");
});

test("fails closed for a project root that is not absolute", async () => {
  const capture = await supportedAdapter().capture({
    hookInput: {
      session_id: sessionId,
      cwd: "relative-project",
      model: "gpt-5.6-sol"
    }
  });

  assert.equal(capture.status, "UNSUPPORTED");
  assert.equal(capture.reasonCode, HOST_FACT_REASON.INVALID_PROJECT_ROOT);
  assert.equal(capture.record, null);
});

test("stores private facts atomically and reads them by the emitted digest", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-");
  const capture = await captureSupported();
  const factPath = await writeHostSessionFacts(capture.record, { dataDirectory });
  const stored = await readFile(factPath, "utf8");
  const mode = (await stat(factPath)).mode & 0o777;

  assert.equal(mode, 0o600);
  assert.equal(factPath.includes(sessionId), false);
  assert.equal(stored.includes(sessionId), false);
  assert.equal(stored.includes(projectRoot), false);
  assert.equal(path.basename(factPath), `${correlationKey}.json`);

  const result = await readHostSessionFacts({
    dataDirectory,
    correlationKey,
    projectRoot,
    now: () => new Date("2026-09-19T12:01:00.000Z")
  });

  assert.deepEqual(result, {
    status: "SUPPORTED",
    session: {
      harness: "codex-cli",
      harnessVersion: "0.147.0",
      provider: "openai",
      model: "gpt-5.6-sol",
      capacityOverrides: {
        contextWindowTokens: 272000,
        compactionThresholdTokens: 244800
      }
    },
    compactionScope: "total",
    provenance: {
      source: "active-host-session",
      observedAt,
      fields: {
        harness: "codex-adapter",
        harnessVersion: "transcript.session_meta.cli_version",
        provider: "transcript.session_meta.model_provider",
        model: "hook.model",
        contextWindowTokens: "hook.model_context_window",
        compactionThresholdTokens: "hook.model_auto_compact_token_limit",
        compactionScope: "hook.model_auto_compact_token_limit_scope"
      }
    }
  });
});

test("returns stable reasons for another key, project mismatch, staleness, and invalid facts", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-errors-");
  const capture = await captureSupported();
  const factPath = await writeHostSessionFacts(capture.record, { dataDirectory });

  const otherSession = await readHostSessionFacts({
    dataDirectory,
    correlationKey: "b".repeat(64),
    projectRoot
  });
  assert.equal(otherSession.reasonCode, HOST_FACT_REASON.NO_SESSION_FACTS);

  const invalidKey = await readHostSessionFacts({
    dataDirectory,
    correlationKey: sessionId,
    projectRoot
  });
  assert.equal(invalidKey.reasonCode, HOST_FACT_REASON.INVALID_CORRELATION_KEY);

  const wrongProject = await readHostSessionFacts({
    dataDirectory,
    correlationKey,
    projectRoot: "/workspace/other-project",
    now: () => new Date("2026-09-19T12:01:00.000Z")
  });
  assert.equal(wrongProject.reasonCode, HOST_FACT_REASON.PROJECT_MISMATCH);

  const stale = await readHostSessionFacts({
    dataDirectory,
    correlationKey,
    projectRoot,
    maxAgeMs: 1000,
    now: () => new Date("2026-09-19T12:00:01.001Z")
  });
  assert.equal(stale.reasonCode, HOST_FACT_REASON.STALE_SESSION_FACTS);

  await writeFile(factPath, "{}\n", { mode: 0o600 });
  const invalid = await readHostSessionFacts({ dataDirectory, correlationKey, projectRoot });
  assert.equal(invalid.reasonCode, HOST_FACT_REASON.INVALID_SESSION_FACTS);
});

test("returns identity and scope from a matched unsupported record", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-unsupported-");
  const capture = await captureSupported(supportedAdapter(), {
    model_auto_compact_token_limit: undefined,
    model_auto_compact_token_limit_scope: undefined
  });
  await writeHostSessionFacts(capture.record, { dataDirectory });

  const result = await readHostSessionFacts({
    dataDirectory,
    correlationKey,
    projectRoot,
    now: () => new Date("2026-09-19T12:01:00.000Z")
  });

  assert.equal(result.status, "UNSUPPORTED");
  assert.equal(result.reasonCode, HOST_FACT_REASON.HOST_CAPACITY_UNAVAILABLE);
  assert.equal(result.session.model, "gpt-5.6-sol");
  assert.deepEqual(result.session.capacityOverrides, { contextWindowTokens: 272000 });
  assert.equal(result.compactionScope, null);
});

test("keeps the newest observation and rejects equal-time material conflicts", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-monotonic-");
  const newest = factRecord("monotonic-session", "2026-09-19T12:00:02.000Z");
  const older = factRecord("monotonic-session", "2026-09-19T12:00:01.000Z");
  const conflict = {
    ...newest,
    host: {
      ...newest.host,
      model: "gpt-6-astra"
    }
  };
  const target = await writeHostSessionFacts(newest, { dataDirectory });

  await assert.rejects(
    writeHostSessionFacts(older, { dataDirectory }),
    /older than the stored record/
  );
  await assert.rejects(
    writeHostSessionFacts(conflict, { dataDirectory }),
    /conflicts with stored facts at the same observation time/
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), newest);

  const recordBytes = Buffer.byteLength(`${JSON.stringify(newest)}\n`, "utf8");
  assert.equal(await writeHostSessionFacts(newest, { dataDirectory, maxDirectoryBytes: recordBytes }), target);
});

test("removes expired fact records and stale temporary files during the next write", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-retention-");
  const first = factRecord("retention-first");
  const second = factRecord("retention-second");
  const firstPath = await writeHostSessionFacts(first, { dataDirectory });
  const temporaryPath = `${firstPath}.1234.orphan.tmp`;
  await writeFile(temporaryPath, "{}\n", { mode: 0o600 });
  const oldTime = new Date("2026-09-01T00:00:00.000Z");
  await utimes(firstPath, oldTime, oldTime);
  await utimes(temporaryPath, oldTime, oldTime);

  await writeHostSessionFacts(second, {
    dataDirectory,
    maxFactAgeMs: 1000,
    now: () => new Date("2026-09-19T12:00:00.000Z")
  });

  await assert.rejects(access(firstPath), (error) => error.code === "ENOENT");
  await assert.rejects(access(temporaryPath), (error) => error.code === "ENOENT");
});

test("removes fresh orphan fact temporary files before enforcing the byte quota", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-fresh-orphan-");
  const directory = path.join(dataDirectory, "session-capacity");
  const record = factRecord("fresh-orphan");
  const recordText = `${JSON.stringify(record)}\n`;
  const maxDirectoryBytes = Buffer.byteLength(recordText, "utf8");
  const temporaryPath = path.join(directory, `${record.sessionDigest}.json.1234.orphan.tmp`);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(temporaryPath, recordText, { mode: 0o600 });

  const target = await writeHostSessionFacts(record, { dataDirectory, maxDirectoryBytes });

  await assert.rejects(access(temporaryPath), (error) => error.code === "ENOENT");
  await access(target);
  const factNames = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  const aggregateBytes = (await Promise.all(factNames.map((name) => stat(path.join(directory, name)))))
    .reduce((total, metadata) => total + metadata.size, 0);
  assert.equal(aggregateBytes <= maxDirectoryBytes, true);
});

test("evicts oldest fact records by modification time and file name under the byte quota", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-quota-");
  const first = factRecord("quota-first");
  const second = factRecord("quota-second");
  const third = factRecord("quota-third");
  const firstPath = await writeHostSessionFacts(first, { dataDirectory });
  const secondPath = await writeHostSessionFacts(second, { dataDirectory });
  await utimes(firstPath, new Date("2026-09-19T10:00:00.000Z"), new Date("2026-09-19T10:00:00.000Z"));
  await utimes(secondPath, new Date("2026-09-19T11:00:00.000Z"), new Date("2026-09-19T11:00:00.000Z"));
  const candidateBytes = Buffer.byteLength(`${JSON.stringify(third)}\n`, "utf8");
  const maxDirectoryBytes = (await stat(secondPath)).size + candidateBytes;
  const thirdPath = await writeHostSessionFacts(third, {
    dataDirectory,
    maxDirectoryBytes,
    now: () => new Date("2026-09-19T12:00:00.000Z")
  });

  await assert.rejects(access(firstPath), (error) => error.code === "ENOENT");
  await access(secondPath);
  await access(thirdPath);
});

test("accounts for the old target and replacement temporary file at the same time", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-replacement-quota-");
  const original = factRecord("replacement-quota", "2026-09-19T12:00:00.000Z");
  const replacement = {
    ...factRecord("replacement-quota", "2026-09-19T12:01:00.000Z"),
    host: {
      ...original.host,
      model: "gpt-6-astra"
    }
  };
  const target = await writeHostSessionFacts(original, { dataDirectory });
  const originalBytes = (await stat(target)).size;
  const replacementBytes = Buffer.byteLength(`${JSON.stringify(replacement)}\n`, "utf8");

  await assert.rejects(
    writeHostSessionFacts(replacement, {
      dataDirectory,
      maxDirectoryBytes: originalBytes + replacementBytes - 1
    }),
    /storage limit/
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), original);
  assert.deepEqual(
    (await readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp")),
    []
  );

  await writeHostSessionFacts(replacement, {
    dataDirectory,
    maxDirectoryBytes: originalBytes + replacementBytes
  });
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), replacement);
});

test("rejects a symbolic-link fact directory without touching its target", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-directory-link-");
  const outsideDirectory = await temporaryDirectory(context, "prism-host-facts-directory-target-");
  const markerPath = path.join(outsideDirectory, "marker.txt");
  await writeFile(markerPath, "outside\n", { mode: 0o600 });
  await chmod(outsideDirectory, 0o755);
  await symlink(outsideDirectory, path.join(dataDirectory, "session-capacity"), "dir");

  await assert.rejects(
    writeHostSessionFacts(factRecord("directory-link"), { dataDirectory }),
    /symbolic link/
  );
  assert.equal(await readFile(markerPath, "utf8"), "outside\n");
  assert.equal((await stat(outsideDirectory)).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(dataDirectory, "session-capacity"))).isSymbolicLink(), true);
});

test("rejects a symbolic-link fact record without reading or replacing its target", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-record-link-");
  const outsideDirectory = await temporaryDirectory(context, "prism-host-facts-record-target-");
  const directory = path.join(dataDirectory, "session-capacity");
  const record = factRecord("record-link");
  const target = path.join(directory, `${record.sessionDigest}.json`);
  const outsidePath = path.join(outsideDirectory, "outside.json");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(outsidePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await symlink(outsidePath, target, "file");

  const readResult = await readHostSessionFacts({
    dataDirectory,
    correlationKey: record.sessionDigest,
    projectRoot,
    now: () => new Date("2026-09-19T12:01:00.000Z")
  });
  assert.equal(readResult.status, "UNSUPPORTED");
  assert.equal(readResult.reasonCode, HOST_FACT_REASON.INVALID_SESSION_FACTS);
  await assert.rejects(
    writeHostSessionFacts(record, { dataDirectory }),
    /symbolic link/
  );
  assert.equal((await lstat(target)).isSymbolicLink(), true);
  assert.equal(await readFile(outsidePath, "utf8"), `${JSON.stringify(record)}\n`);
});

test("rejects a hard-linked fact record without reading or replacing its external inode", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-record-hard-link-");
  const outsideDirectory = await temporaryDirectory(context, "prism-host-facts-record-hard-target-");
  const directory = path.join(dataDirectory, "session-capacity");
  const record = factRecord("record-hard-link");
  const target = path.join(directory, `${record.sessionDigest}.json`);
  const outsidePath = path.join(outsideDirectory, "outside.json");
  const recordText = `${JSON.stringify(record)}\n`;
  await mkdir(directory, { mode: 0o700 });
  await writeFile(outsidePath, recordText, { mode: 0o640 });
  await link(outsidePath, target);

  const readResult = await readHostSessionFacts({
    dataDirectory,
    correlationKey: record.sessionDigest,
    projectRoot,
    now: () => new Date("2026-09-19T12:01:00.000Z")
  });
  assert.equal(readResult.status, "UNSUPPORTED");
  assert.equal(readResult.reasonCode, HOST_FACT_REASON.INVALID_SESSION_FACTS);
  await assert.rejects(
    writeHostSessionFacts(record, { dataDirectory }),
    /multiple links/
  );
  assert.equal(await readFile(outsidePath, "utf8"), recordText);
  assert.equal((await stat(outsidePath)).nlink, 2);
  assert.equal((await stat(outsidePath)).mode & 0o777, 0o640);
});

test("rejects a hard-linked lock owner without changing its external inode", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-lock-hard-link-");
  const outsideDirectory = await temporaryDirectory(context, "prism-host-facts-lock-hard-target-");
  const directory = path.join(dataDirectory, "session-capacity");
  const lockPath = path.join(directory, ".retention.lock");
  const token = "11111111-1111-4111-8111-111111111111";
  const outsidePath = path.join(outsideDirectory, "owner.json");
  const ownerText = `${JSON.stringify({ token, pid: process.pid })}\n`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(outsidePath, ownerText, { mode: 0o640 });
  await link(outsidePath, path.join(lockPath, `owner-${token}`));
  const staleTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(lockPath, staleTime, staleTime);

  await assert.rejects(
    writeHostSessionFacts(factRecord("lock-hard-link"), { dataDirectory }),
    /multiple links/
  );
  assert.equal(await readFile(outsidePath, "utf8"), ownerText);
  assert.equal((await stat(outsidePath)).nlink, 2);
  assert.equal((await stat(outsidePath)).mode & 0o777, 0o640);
});

test("recovers an aged empty lock left before owner publication", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-empty-lock-");
  const directory = path.join(dataDirectory, "session-capacity");
  const lockPath = path.join(directory, ".retention.lock");
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  const staleTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(lockPath, staleTime, staleTime);

  const target = await writeHostSessionFacts(factRecord("empty-lock-recovery"), { dataDirectory });

  await access(target);
  await assert.rejects(access(lockPath), (error) => error.code === "ENOENT");
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".retention.lock.")),
    []
  );
});

test("tolerates faults reported after atomic owner publication and unpublication", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-lock-boundary-");
  let publicationFaulted = false;
  let unpublicationFaulted = false;
  const faultingFileSystem = {
    ...fileSystem,
    async rename(source, destination) {
      const sourceName = path.basename(source);
      const destinationName = path.basename(destination);
      if (!publicationFaulted && sourceName.startsWith(".retention.lock.pending.") && destinationName === ".retention.lock") {
        publicationFaulted = true;
        await fileSystem.rename(source, destination);
        const error = new Error("injected publication boundary fault");
        error.code = "EIO";
        throw error;
      }
      if (!unpublicationFaulted && sourceName === ".retention.lock" && destinationName.startsWith(".retention.lock.release.")) {
        unpublicationFaulted = true;
        await fileSystem.rename(source, destination);
        const error = new Error("injected unpublication boundary fault");
        error.code = "EIO";
        throw error;
      }
      return fileSystem.rename(source, destination);
    }
  };

  const target = await writeHostSessionFacts(factRecord("lock-boundary"), {
    dataDirectory,
    fileSystem: faultingFileSystem
  });

  assert.equal(publicationFaulted, true);
  assert.equal(unpublicationFaulted, true);
  await access(target);
  assert.deepEqual(
    (await readdir(path.dirname(target))).filter((name) => name.startsWith(".retention.lock")),
    []
  );
});

test("cleans an empty release artifact left after owner removal", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-release-boundary-");
  let removalFaulted = false;
  const faultingFileSystem = {
    ...fileSystem,
    async rmdir(target, ...argumentsValue) {
      if (!removalFaulted && path.basename(target).startsWith(".retention.lock.release.")) {
        removalFaulted = true;
        const error = new Error("injected owner removal boundary fault");
        error.code = "EIO";
        throw error;
      }
      return fileSystem.rmdir(target, ...argumentsValue);
    }
  };

  await writeHostSessionFacts(factRecord("release-boundary-first"), {
    dataDirectory,
    fileSystem: faultingFileSystem
  });
  const directory = path.join(dataDirectory, "session-capacity");
  assert.equal(removalFaulted, true);
  assert.equal((await readdir(directory)).some((name) => name.startsWith(".retention.lock.release.")), true);

  const target = await writeHostSessionFacts(factRecord("release-boundary-second"), { dataDirectory });

  await access(target);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".retention.lock")),
    []
  );
});

test("an active stale-aged lock owner cannot be taken over by another writer", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-lock-owner-");
  const firstReached = deferred();
  const firstResume = deferred();
  context.after(() => firstResume.resolve());
  const firstRecord = factRecord("lock-first");
  const secondRecord = factRecord("lock-second");
  const maxDirectoryBytes = Buffer.byteLength(`${JSON.stringify(firstRecord)}\n`, "utf8");

  const firstWrite = writeHostSessionFacts(firstRecord, {
    dataDirectory,
    fileSystem: pauseBeforeTemporaryWrite(firstReached, firstResume),
    maxDirectoryBytes
  });
  await firstReached.promise;
  const lockPath = path.join(dataDirectory, "session-capacity", ".retention.lock");
  const staleTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(lockPath, staleTime, staleTime);

  try {
    await assert.rejects(
      writeHostSessionFacts(secondRecord, { dataDirectory, maxDirectoryBytes }),
      /busy/
    );
  } finally {
    firstResume.resolve();
  }
  await firstWrite;

  await assert.rejects(access(lockPath), (error) => error.code === "ENOENT");
  const directory = path.join(dataDirectory, "session-capacity");
  const factNames = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  assert.deepEqual(factNames, [`${firstRecord.sessionDigest}.json`]);
  const aggregateBytes = (await Promise.all(factNames.map((name) => stat(path.join(directory, name)))))
    .reduce((total, metadata) => total + metadata.size, 0);
  assert.equal(aggregateBytes <= maxDirectoryBytes, true);
});

test("recovers a stale lock only after its recorded owner is proven dead", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-dead-lock-");
  const directory = path.join(dataDirectory, "session-capacity");
  const lockPath = path.join(directory, ".retention.lock");
  const token = "22222222-2222-4222-8222-222222222222";
  const deadPid = 424242;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(lockPath, `owner-${token}`),
    `${JSON.stringify({ token, pid: deadPid })}\n`,
    { mode: 0o600 }
  );
  const staleTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(lockPath, staleTime, staleTime);

  const target = await writeHostSessionFacts(factRecord("dead-lock-recovery"), {
    dataDirectory,
    isProcessAlive(pid) {
      assert.equal(pid, deadPid);
      return false;
    }
  });

  await access(target);
  await assert.rejects(access(lockPath), (error) => error.code === "ENOENT");
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith(".retention.lock.stale.")),
    []
  );
});

test("does not take over a stale lock when owner liveness is unknown", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-unknown-lock-");
  const directory = path.join(dataDirectory, "session-capacity");
  const lockPath = path.join(directory, ".retention.lock");
  const token = "33333333-3333-4333-8333-333333333333";
  const ownerPath = path.join(lockPath, `owner-${token}`);
  const ownerText = `${JSON.stringify({ token, pid: 434343 })}\n`;
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(ownerPath, ownerText, { mode: 0o600 });
  const staleTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(lockPath, staleTime, staleTime);

  await assert.rejects(
    writeHostSessionFacts(factRecord("unknown-lock-owner"), {
      dataDirectory,
      isProcessAlive() {
        return null;
      }
    }),
    /busy/
  );

  assert.equal(await readFile(ownerPath, "utf8"), ownerText);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)),
    []
  );
});

test("a same-parent subagent hook cannot overwrite the supported root capacity record", async (context) => {
  const dataDirectory = await temporaryDirectory(context, "prism-host-facts-subagent-hook-");
  const root = await temporaryDirectory(context, "prism-host-facts-subagent-project-");
  const canonicalRoot = await fileSystem.realpath(root);
  const hookInput = {
    session_id: sessionId,
    transcript_path: path.join(root, "private-transcript.jsonl"),
    cwd: root,
    hook_event_name: "SessionStart",
    model: "gpt-5.6-sol",
    model_context_window: 272000,
    model_auto_compact_token_limit: 244800,
    model_auto_compact_token_limit_scope: "total"
  };
  const adapterFor = (execution, time) => createCodexHostAdapter({
    now: () => new Date(time),
    inspectTranscriptMetadata: async (identity) => {
      assert.equal(identity.projectRoot, canonicalRoot);
      return {
        status: "SUPPORTED",
        execution,
        harnessVersion: "0.147.0",
        provider: "openai",
        projectRoot: canonicalRoot
      };
    }
  });
  const environment = { PLUGIN_DATA: dataDirectory };

  const rootCapture = await recordSessionFacts({
    input: Readable.from([JSON.stringify(hookInput)]),
    environment,
    adapter: adapterFor("root", "2026-09-19T12:00:00.000Z")
  });
  const subagentCapture = await recordSessionFacts({
    input: Readable.from([JSON.stringify(hookInput)]),
    environment,
    adapter: adapterFor("subagent", "2026-09-19T12:01:00.000Z")
  });

  assert.equal(rootCapture.status, "SUPPORTED");
  assert.equal(subagentCapture.status, "UNSUPPORTED");
  assert.equal(subagentCapture.reasonCode, HOST_FACT_REASON.UNSUPPORTED_EXECUTION);
  assert.equal(subagentCapture.record, null);
  const stored = await readHostSessionFacts({
    dataDirectory,
    correlationKey,
    projectRoot: canonicalRoot,
    now: () => new Date("2026-09-19T12:02:00.000Z")
  });
  assert.equal(stored.status, "SUPPORTED");
  assert.deepEqual(stored.session.capacityOverrides, {
    contextWindowTokens: 272000,
    compactionThresholdTokens: 244800
  });
});

test("the hook emits the digest and plugin data directory after storing facts", async (context) => {
  const hookPath = fileURLToPath(new URL("../../dist/hooks/record-session-facts.mjs", import.meta.url));
  const dataDirectory = await temporaryDirectory(context, "prism-host-hook-output-");
  const root = await temporaryDirectory(context, "prism-host-hook-project-");
  const transcriptPath = path.join(root, "private-transcript.jsonl");
  await writeFile(transcriptPath, `${JSON.stringify({
    type: "session_meta",
    payload: {
      id: sessionId,
      cwd: root,
      cli_version: "0.147.0",
      model_provider: "openai",
      source: "cli"
    }
  })}\n`);
  const child = spawn(process.execPath, [hookPath], {
    env: {
      ...process.env,
      PLUGIN_DATA: dataDirectory
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end(JSON.stringify({
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: root,
    hook_event_name: "SessionStart",
    model: "gpt-5.6-sol",
    model_context_window: 272000,
    model_auto_compact_token_limit: 244800,
    model_auto_compact_token_limit_scope: "total",
    prompt: "private prompt"
  }));

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  const outputText = Buffer.concat(stdout).toString();
  const output = JSON.parse(outputText);

  assert.equal(exitCode, 0);
  assert.equal(Buffer.concat(stderr).toString(), "");
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(createSessionCorrelationKey(sessionId)));
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(dataDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const privateValue of [sessionId, transcriptPath, root, "private prompt"]) {
    assert.equal(outputText.includes(privateValue), false);
  }
});

test("the hook command fails open for malformed input", async (context) => {
  const hookPath = fileURLToPath(new URL("../../dist/hooks/record-session-facts.mjs", import.meta.url));
  const dataDirectory = await temporaryDirectory(context, "prism-host-hook-");
  const child = spawn(process.execPath, [hookPath], {
    env: {
      ...process.env,
      CLAUDE_PLUGIN_DATA: dataDirectory
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.end("not-json");

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0);
  assert.equal(Buffer.concat(stdout).toString(), "");
  assert.equal(Buffer.concat(stderr).toString(), "");
});

test("the canonical JavaScript validator rejects unknown properties and incomplete supported facts", async () => {
  const capture = await captureSupported();
  assert.throws(
    () => validateHostSessionFacts({ ...capture.record, unexpected: true }),
    /unknown property/
  );
  assert.throws(
    () => validateHostSessionFacts({ ...capture.record, capacityOverrides: {} }),
    /present together/
  );
  assert.throws(
    () => validateHostSessionFacts({
      ...capture.record,
      sources: { ...capture.record.sources, compactionScope: null }
    }),
    /compactionScope value and source must be present together/
  );
});
