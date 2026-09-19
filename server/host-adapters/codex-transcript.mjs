import { constants as fileConstants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import path from "node:path";

const MAX_SESSION_META_BYTES = 256 * 1024;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;
const HOST_VALUE_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:/@\[\]-]{0,255}$/;
const ROOT_SESSION_SOURCES = new Set(["cli", "vscode", "exec", "mcp"]);

export const CODEX_TRANSCRIPT_REASON = Object.freeze({
  NO_TRANSCRIPT: "NO_TRANSCRIPT",
  INVALID_TRANSCRIPT: "INVALID_TRANSCRIPT",
  SESSION_MISMATCH: "SESSION_MISMATCH",
  PROJECT_MISMATCH: "PROJECT_MISMATCH"
});

function unsupported(reasonCode) {
  return { status: "UNSUPPORTED", reasonCode };
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function executionKind(payload) {
  if (["subagent", "subAgent"].includes(payload.thread_source)) {
    return "subagent";
  }
  if (payload.source && typeof payload.source === "object" && !Array.isArray(payload.source)) {
    if (Object.hasOwn(payload.source, "subagent") || Object.hasOwn(payload.source, "subAgent")) {
      return "subagent";
    }
    return null;
  }
  return ROOT_SESSION_SOURCES.has(payload.source) ? "root" : null;
}

async function canonicalDirectory(value, fileSystem) {
  const normalized = nonemptyString(value);
  if (!normalized || !path.isAbsolute(normalized)) return null;
  try {
    const canonical = await fileSystem.realpath(normalized);
    const metadata = await fileSystem.lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    return canonical;
  } catch {
    return null;
  }
}

function isSameOrDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function noFollowFlags(flags) {
  return Number.isInteger(fileConstants.O_NOFOLLOW) ? flags | fileConstants.O_NOFOLLOW : flags;
}

async function readSessionMetaLine(transcriptPath, fileSystem) {
  const expected = await fileSystem.lstat(transcriptPath);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) {
    throw new Error("The Codex transcript is not a regular file.");
  }
  const handle = await fileSystem.open(transcriptPath, noFollowFlags(fileConstants.O_RDONLY));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || opened.dev !== expected.dev
      || opened.ino !== expected.ino
    ) {
      throw new Error("The Codex transcript changed during validation.");
    }
    const byteCount = Math.min(opened.size, MAX_SESSION_META_BYTES + 1);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline === -1 && opened.size > MAX_SESSION_META_BYTES) {
      throw new Error("The Codex session metadata exceeds its read limit.");
    }
    const end = newline === -1 ? bytesRead : newline;
    if (end === 0 || end > MAX_SESSION_META_BYTES) {
      throw new Error("The Codex session metadata is invalid.");
    }
    return buffer.subarray(0, end).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function inspectCodexTranscriptMetadata({
  transcriptPath,
  sessionId,
  projectRoot,
  fileSystem = defaultFileSystem
} = {}) {
  const normalizedPath = nonemptyString(transcriptPath);
  if (!normalizedPath || !path.isAbsolute(normalizedPath)) {
    return unsupported(CODEX_TRANSCRIPT_REASON.NO_TRANSCRIPT);
  }
  const normalizedSession = nonemptyString(sessionId);
  const canonicalHookDirectory = await canonicalDirectory(projectRoot, fileSystem);
  if (!normalizedSession || !canonicalHookDirectory) {
    return unsupported(CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
  }

  let record;
  try {
    record = JSON.parse(await readSessionMetaLine(normalizedPath, fileSystem));
  } catch {
    return unsupported(CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
  }
  const payload = record?.type === "session_meta" && record.payload && typeof record.payload === "object"
    ? record.payload
    : null;
  if (!payload) {
    return unsupported(CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
  }
  const transcriptIds = [nonemptyString(payload.id), nonemptyString(payload.session_id)].filter(Boolean);
  if (!transcriptIds.includes(normalizedSession)) {
    return unsupported(CODEX_TRANSCRIPT_REASON.SESSION_MISMATCH);
  }
  const transcriptProject = await canonicalDirectory(payload.cwd, fileSystem);
  if (!transcriptProject) {
    return unsupported(CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT);
  }
  if (!isSameOrDescendant(transcriptProject, canonicalHookDirectory)) {
    return unsupported(CODEX_TRANSCRIPT_REASON.PROJECT_MISMATCH);
  }

  const harnessVersion = nonemptyString(payload.cli_version);
  const provider = nonemptyString(payload.model_provider);
  if (!harnessVersion || !VERSION_PATTERN.test(harnessVersion) || !provider || !HOST_VALUE_PATTERN.test(provider)) {
    return {
      ...unsupported(CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT),
      projectRoot: transcriptProject
    };
  }
  const execution = executionKind(payload);
  if (execution === null) {
    return {
      ...unsupported(CODEX_TRANSCRIPT_REASON.INVALID_TRANSCRIPT),
      projectRoot: transcriptProject,
      harnessVersion,
      provider
    };
  }
  return {
    status: "SUPPORTED",
    execution,
    harnessVersion,
    provider,
    projectRoot: transcriptProject
  };
}
