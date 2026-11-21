// What a slice's Verification tab opens in the side panel: a frozen test, the test behind a failing name, and a run's log.
import { lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acceptedDesign, frozenTestContent } from "../workflow/slice-design.mjs";
import { listRecordEntries } from "../workflow/record-store.mjs";

// The panel shows the end of a log larger than this, since the end holds the failures and the summary.
export const LOG_SHOWN_BYTES = 2 * 1024 * 1024;
// A run record keeps the last this many characters of the output, as verification records them.
const RECORDED_TAIL_CHARS = 4000;

// Content other than the work tree's frozen file says which copy the panel shows.
const NOTES: Record<string, string> = {
  staged: "The slice has not started, so this is the copy Prism keeps until it does.",
  kept: "The file in the work tree changed after the design was accepted, so this is the frozen copy Prism kept.",
  changed: "This file changed after the design was accepted, and Prism kept no frozen copy, so this is the changed file."
};

/** A frozen test as the side panel reads it, { path, kind: "source", content, state }, or null for a path the accepted design does not freeze. */
export async function frozenTestFile(projectRoot: string, initiative: string, slice: string, relative: string) {
  const found = await frozenTestContent(projectRoot, initiative, slice, relative);
  if (!found) return null;
  return { path: found.path, kind: "source", content: found.bytes.toString("utf8"), state: found.state, ...(NOTES[found.state] ? { note: NOTES[found.state] } : {}) };
}

// A failing name may carry its suite, file, or module before the test's own name, in the forms the runners that verification reads print.
function candidates(name: string) {
  const names = [name];
  for (const separator of [" > ", "::", " › "]) if (name.includes(separator)) names.push(name.split(separator).at(-1)!.trim());
  // A Go subtest is named Parent/sub, where only the parent is written as it reads.
  if (/^\w+\/\S+$/.test(name)) names.push(name.split("/")[0]);
  return [...new Set(names.filter(Boolean))];
}

// The first line of a file that names a test, as a whole word when the name is one; 0 when no line does.
function lineNaming(content: string, name: string) {
  const word = /^\w+$/.test(name) ? new RegExp(`(?<![\\w])${name}(?![\\w])`) : null;
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => word ? word.test(line) : line.includes(name));
  return index + 1;
}

/**
 * Each failing name of a run with the frozen test that names it: { name, path, line } when exactly one frozen test names it, and { name } otherwise,
 * so a link never opens a test that only shares a name with the failing one. A pytest name that starts with a frozen test's path looks only in that file.
 */
export async function failingTestLinks(projectRoot: string, initiative: string, slice: string, failing: unknown) {
  if (!Array.isArray(failing) || !failing.length) return [];
  const design = await acceptedDesign(projectRoot, initiative, slice).catch(() => null);
  const files: { path: string; content: string }[] = [];
  for (const test of design?.frozenTests ?? []) {
    const found = await frozenTestContent(projectRoot, initiative, slice, test.path).catch(() => null);
    if (found) files.push({ path: found.path, content: found.bytes.toString("utf8") });
  }
  return failing.filter((name): name is string => typeof name === "string").map((name) => {
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

// A log path names the run it holds, under Prism's plugin data, so a record cannot point the review app at another file on this machine.
function logLocation(recorded: unknown, initiative: string, slice: string, id: string) {
  if (typeof recorded !== "string" || !recorded) return null;
  const parts = recorded.replaceAll("\\", "/").split("/");
  const tailParts = parts.slice(-5);
  if (tailParts.length !== 5 || tailParts[0] !== "verification-logs" || !/^[0-9a-f]{16}$/.test(tailParts[1]) || tailParts[2] !== initiative || tailParts[3] !== slice || tailParts[4] !== `${id}.log`) return null;
  const local = recorded.startsWith("~/") ? path.join(os.homedir(), recorded.slice(2)) : recorded;
  return path.isAbsolute(local) ? local : null;
}

async function readEnd(file: string) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const handle = await open(file, "r");
  try {
    const length = Math.min(info.size, LOG_SHOWN_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const cut = info.size > length;
    // A log cut part way through a line starts at the next whole line, so it never opens on a broken character.
    const text = buffer.toString("utf8");
    const content = cut && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
    return { content, size: info.size, shown: Buffer.byteLength(content), cut };
  } finally { await handle.close(); }
}

/**
 * The log of a slice's verification run, as the side panel shows it: the whole log when this machine holds the file the run wrote,
 * and else the output the shared record keeps, with whether that is the whole output and where the full log is.
 * Returns null for a run the slice does not have.
 */
export async function verificationLog(projectRoot: string, initiative: string, slice: string, id: string) {
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative, slice });
  const run = entries.find((item: any) => item.id === id && item.entry?.kind === "verification")?.entry;
  if (!run) return null;
  const base = { id, command: typeof run.command === "string" ? run.command : null, finishedAt: run.finishedAt ?? null, passed: run.passed === true, exitCode: run.exitCode ?? null, host: run.checkout?.host ?? null };
  const local = logLocation(run.log, initiative, slice, id);
  const read = local ? await readEnd(local).catch(() => null) : null;
  if (read) return { ...base, source: "log", content: read.content, size: read.size, shown: read.shown, cut: read.cut, log: run.log };
  const tail = typeof run.outputTail === "string" ? run.outputTail : "";
  return { ...base, source: "record", content: tail, complete: tail.length < RECORDED_TAIL_CHARS, log: typeof run.log === "string" ? run.log : null };
}
