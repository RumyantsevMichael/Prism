// Generated from src/server/review/verification-view.mts by scripts/native-build/compile.mjs.
import { lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acceptedDesign, frozenTestContent } from "../workflow/slice-design.mjs";
import { listRecordEntries } from "../workflow/record-store.mjs";
const LOG_SHOWN_BYTES = 2 * 1024 * 1024;
const RECORDED_TAIL_CHARS = 4e3;
const NOTES = {
  staged: "The slice has not started, so this is the copy Prism keeps until it does.",
  kept: "The file in the work tree changed after the design was accepted, so this is the frozen copy Prism kept.",
  changed: "This file changed after the design was accepted, and Prism kept no frozen copy, so this is the changed file."
};
async function frozenTestFile(projectRoot, initiative, slice, relative) {
  const found = await frozenTestContent(projectRoot, initiative, slice, relative);
  if (!found) return null;
  return { path: found.path, kind: "source", content: found.bytes.toString("utf8"), state: found.state, ...NOTES[found.state] ? { note: NOTES[found.state] } : {} };
}
function candidates(name) {
  const names = [name];
  for (const separator of [" > ", "::", " \u203A "]) if (name.includes(separator)) names.push(name.split(separator).at(-1).trim());
  if (/^\w+\/\S+$/.test(name)) names.push(name.split("/")[0]);
  return [...new Set(names.filter(Boolean))];
}
function lineNaming(content, name) {
  const word = /^\w+$/.test(name) ? new RegExp(`(?<![\\w])${name}(?![\\w])`) : null;
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => word ? word.test(line) : line.includes(name));
  return index + 1;
}
async function failingTestLinks(projectRoot, initiative, slice, failing) {
  if (!Array.isArray(failing) || !failing.length) return [];
  const design = await acceptedDesign(projectRoot, initiative, slice).catch(() => null);
  const files = [];
  for (const test of design?.frozenTests ?? []) {
    const found = await frozenTestContent(projectRoot, initiative, slice, test.path).catch(() => null);
    if (found) files.push({ path: found.path, content: found.bytes.toString("utf8") });
  }
  return failing.filter((name) => typeof name === "string").map((name) => {
    const own = files.filter((file) => name.startsWith(`${file.path}::`));
    const scope = own.length ? own : files;
    for (const candidate of candidates(name)) {
      const matches = scope.map((file) => ({ path: file.path, line: lineNaming(file.content, candidate) })).filter((match) => match.line > 0);
      if (matches.length === 1) return { name, ...matches[0] };
      if (matches.length > 1) return { name };
    }
    return { name };
  });
}
function logLocation(recorded, initiative, slice, id) {
  if (typeof recorded !== "string" || !recorded) return null;
  const parts = recorded.replaceAll("\\", "/").split("/");
  const tailParts = parts.slice(-5);
  if (tailParts.length !== 5 || tailParts[0] !== "verification-logs" || !/^[0-9a-f]{16}$/.test(tailParts[1]) || tailParts[2] !== initiative || tailParts[3] !== slice || tailParts[4] !== `${id}.log`) return null;
  const local = recorded.startsWith("~/") ? path.join(os.homedir(), recorded.slice(2)) : recorded;
  return path.isAbsolute(local) ? local : null;
}
async function readEnd(file) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const handle = await open(file, "r");
  try {
    const length = Math.min(info.size, LOG_SHOWN_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const cut = info.size > length;
    const text = buffer.toString("utf8");
    const content = cut && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
    return { content, size: info.size, shown: Buffer.byteLength(content), cut };
  } finally {
    await handle.close();
  }
}
async function verificationLog(projectRoot, initiative, slice, id) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice });
  const run = entries.find((item) => item.id === id && item.entry?.kind === "verification")?.entry;
  if (!run) return null;
  const base = { id, command: typeof run.command === "string" ? run.command : null, finishedAt: run.finishedAt ?? null, passed: run.passed === true, exitCode: run.exitCode ?? null, host: run.checkout?.host ?? null };
  const local = logLocation(run.log, initiative, slice, id);
  const read = local ? await readEnd(local).catch(() => null) : null;
  if (read) return { ...base, source: "log", content: read.content, size: read.size, shown: read.shown, cut: read.cut, log: run.log };
  const tail = typeof run.outputTail === "string" ? run.outputTail : "";
  return { ...base, source: "record", content: tail, complete: tail.length < RECORDED_TAIL_CHARS, log: typeof run.log === "string" ? run.log : null };
}
export {
  LOG_SHOWN_BYTES,
  failingTestLinks,
  frozenTestFile,
  verificationLog
};
