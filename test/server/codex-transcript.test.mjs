import assert from "node:assert/strict";
import * as fileSystem from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_TRANSCRIPT_REASON,
  inspectCodexTranscriptMetadata
} from "../../dist/server/session/host-adapters/codex-transcript.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prism-codex-transcript-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function sessionMeta({ sessionId, projectRoot, subagent = false }) {
  return JSON.stringify({
    type: "session_meta",
    payload: {
      id: subagent ? "subagent-execution" : sessionId,
      session_id: sessionId,
      cli_version: "0.155.0-alpha.9.2",
      model_provider: "openai",
      cwd: projectRoot,
      source: subagent ? { subagent: { depth: 1 } } : "vscode"
    }
  });
}

test("reads only allowlisted root execution metadata", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "rollout.jsonl");
  await writeFile(transcript, `${sessionMeta({ sessionId: "thread-1", projectRoot: root })}\n{\"private\":\"content\"}\n`);

  assert.deepEqual(await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root
  }), {
    status: "SUPPORTED",
    execution: "root",
    harnessVersion: "0.155.0-alpha.9.2",
    provider: "openai",
    projectRoot: await fileSystem.realpath(root)
  });
});

test("reads the latest bounded token count context window", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "rollout-with-token-counts.jsonl");
  await writeFile(transcript, [
    sessionMeta({ sessionId: "thread-1", projectRoot: root }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { model_context_window: 258400 } }
    }),
    JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", info: { model_context_window: 260000 } }
    })
  ].join("\n") + "\n");

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root
  });

  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.contextWindowTokens, 260000);
  assert.equal(result.contextWindowSource, "transcript.event_msg.token_count.info.model_context_window");
});

test("identifies subagent execution with the parent session identifier", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "subagent.jsonl");
  await writeFile(transcript, `${sessionMeta({ sessionId: "parent-thread", projectRoot: root, subagent: true })}\n`);

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "parent-thread",
    projectRoot: root
  });
  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.execution, "subagent");
});

test("returns the stable transcript project root when the hook runs in a child directory", async (context) => {
  const root = await fixture(context);
  const child = path.join(root, "nested");
  const transcript = path.join(root, "rollout.jsonl");
  await mkdir(child);
  await writeFile(transcript, `${sessionMeta({ sessionId: "thread-1", projectRoot: root })}\n`);

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: child
  });
  assert.equal(result.status, "SUPPORTED");
  assert.equal(result.execution, "root");
  assert.equal(result.projectRoot, await fileSystem.realpath(root));
});

test("fails closed when a hook or transcript project root is a file", async (context) => {
  const root = await fixture(context);
  const rootFile = path.join(root, "root-file");
  const transcript = path.join(root, "rollout.jsonl");
  await writeFile(rootFile, "not a directory\n");
  await writeFile(transcript, `${sessionMeta({ sessionId: "thread-1", projectRoot: root })}\n`);

  const fileHookRoot = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: rootFile
  });
  assert.equal(fileHookRoot.status, "UNSUPPORTED");
  assert.equal(fileHookRoot.reasonCode, CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);

  await writeFile(transcript, `${sessionMeta({ sessionId: "thread-1", projectRoot: rootFile })}\n`);
  const fileTranscriptRoot = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root
  });
  assert.equal(fileTranscriptRoot.status, "UNSUPPORTED");
  assert.equal(fileTranscriptRoot.reasonCode, CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
});

test("fails closed for an unknown session source instead of assuming root execution", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "unknown-source.jsonl");
  const record = JSON.parse(sessionMeta({ sessionId: "thread-1", projectRoot: root }));
  record.payload.source = "future-source";
  await writeFile(transcript, `${JSON.stringify(record)}\n`);

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root
  });
  assert.equal(result.reasonCode, CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
});

test("fails closed for mismatched identities and symbolic-link transcripts", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "rollout.jsonl");
  const linked = path.join(root, "linked.jsonl");
  await writeFile(transcript, `${sessionMeta({ sessionId: "thread-1", projectRoot: root })}\n`);
  await symlink(transcript, linked);

  const wrongSession = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-2",
    projectRoot: root
  });
  assert.equal(wrongSession.reasonCode, CODEX_TRANSCRIPT_REASON.SESSION_MISMATCH);

  const linkedResult = await inspectCodexTranscriptMetadata({
    transcriptPath: linked,
    sessionId: "thread-1",
    projectRoot: root
  });
  assert.equal(linkedResult.reasonCode, CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
});

test("fails closed when the transcript path is swapped after inspection", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "swapped.jsonl");
  const original = path.join(root, "original.jsonl");
  const forged = path.join(root, "forged.jsonl");
  const forgedText = `${sessionMeta({ sessionId: "thread-1", projectRoot: root })}\n`;
  await writeFile(transcript, "x".repeat(2048));
  await writeFile(forged, forgedText);
  let swapped = false;
  const swappingFileSystem = {
    ...fileSystem,
    async open(target, ...argumentsValue) {
      if (!swapped && target === transcript) {
        swapped = true;
        await fileSystem.rename(transcript, original);
        await fileSystem.symlink(forged, transcript);
      }
      return fileSystem.open(target, ...argumentsValue);
    }
  };

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root,
    fileSystem: swappingFileSystem
  });

  assert.equal(swapped, true);
  assert.equal(result.status, "UNSUPPORTED");
  assert.equal(result.reasonCode, CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
  assert.equal(await fileSystem.readFile(forged, "utf8"), forgedText);
});

test("fails closed when the transcript inode changes between metadata and tail reads", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "changed-between-reads.jsonl");
  const original = path.join(root, "original-between-reads.jsonl");
  const forged = path.join(root, "forged-between-reads.jsonl");
  const metadata = sessionMeta({ sessionId: "thread-1", projectRoot: root });
  await writeFile(transcript, `${metadata}\n${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { model_context_window: 258400 } }
  })}\n`);
  await writeFile(forged, `${metadata}\n${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { model_context_window: 999999 } }
  })}\n`);
  let openCount = 0;
  const swappingFileSystem = {
    ...fileSystem,
    async open(target, ...argumentsValue) {
      if (target === transcript) {
        openCount += 1;
        if (openCount === 2) {
          await fileSystem.rename(transcript, original);
          await fileSystem.rename(forged, transcript);
        }
      }
      return fileSystem.open(target, ...argumentsValue);
    }
  };

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root,
    fileSystem: swappingFileSystem
  });

  assert.equal(openCount, 2);
  assert.equal(result.status, "UNSUPPORTED");
  assert.equal(result.reasonCode, CODEX_TRANSCRIPT_REASON.TOKEN_COUNT_UNAVAILABLE);
});

test("fails closed for a hard-linked transcript", async (context) => {
  const root = await fixture(context);
  const source = path.join(root, "source.jsonl");
  const transcript = path.join(root, "hard-linked.jsonl");
  const sourceText = `${sessionMeta({ sessionId: "thread-1", projectRoot: root })}\n`;
  await writeFile(source, sourceText, { mode: 0o640 });
  await fileSystem.link(source, transcript);

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root
  });

  assert.equal(result.status, "UNSUPPORTED");
  assert.equal(result.reasonCode, CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
  assert.equal(await fileSystem.readFile(source, "utf8"), sourceText);
  assert.equal((await fileSystem.stat(source)).nlink, 2);
  assert.equal((await fileSystem.stat(source)).mode & 0o777, 0o640);
});

test("bounds the first transcript record", async (context) => {
  const root = await fixture(context);
  const transcript = path.join(root, "large.jsonl");
  await writeFile(transcript, "x".repeat(256 * 1024 + 1));

  const result = await inspectCodexTranscriptMetadata({
    transcriptPath: transcript,
    sessionId: "thread-1",
    projectRoot: root
  });
  assert.equal(result.reasonCode, CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
});
