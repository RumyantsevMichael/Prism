import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDesignView } from "../workflow/design-view.mjs";
import { changedPaths, treeId } from "../workflow/slice-gate.mjs";
import { listRecordEntries, sliceDocumentFolder } from "../workflow/record-store.mjs";
import { glossaryEntries, loadGlossary, loadInitiativeView, recordFiles } from "./workspace-model.mjs";

const GIT_TIMEOUT_MS = 10000;
const SLICE_PATTERN = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/;

export class TouchedError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const WHY = Object.freeze({ linked: "Linked from the design", planned: "Planned by the design", verified: "Changed by the verified result" });

// "Section 1" or "Sections 1, 2", and the same for clauses, in number order.
function numbered(word, numbers) {
  const sorted = [...new Set(numbers)].sort((left, right) => Number(left) - Number(right) || String(left).localeCompare(String(right)));
  return `${sorted.length === 1 ? word : `${word}s`} ${sorted.join(", ")}`;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A term occurs in a clause as a whole word, ignoring case, with any run of spaces between its words.
function namesTerm(text, term) {
  const pattern = term.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return pattern ? new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, "iu").test(text) : false;
}

// The project-relative targets of a Markdown document's links, resolved against the document's folder, without their anchors.
function linkTargets(source, documentPath) {
  const targets = [];
  for (const match of (source ?? "").matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1].split("#")[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/")) continue;
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* keep the raw target */ }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(documentPath), decoded));
    if (!target.startsWith("../")) targets.push(target);
  }
  return targets;
}

/**
 * The files that differ between the content a slice started from and the content its latest passing verification run tested,
 * as { files } with project-relative paths, { unreadable: true } when Git cannot read either, or null when the slice has no such pair.
 * Both trees come from records a cloned repository can carry, so a value that is not a Git object identifier counts as no pair and never reaches Git.
 */
async function verifiedChanges(projectRoot, id, slug, slice) {
  const start = slice?.design?.startTree;
  if (!treeId(start)) return null;
  const entries = await listRecordEntries(projectRoot, { kind: "runs", initiative: id, slice: slug }).catch(() => []);
  const passed = entries.filter((item) => item.entry?.kind === "verification" && item.entry.passed === true && typeof item.entry.tree === "string").at(-1);
  if (!passed || !treeId(passed.entry.tree)) return null;
  // A moved file lists both its paths, and only its new path names a record file.
  // The page asks while the person waits, so Git counts as unreadable when either of its two commands does not answer within 10 seconds.
  const files = await changedPaths(projectRoot, start, passed.entry.tree, { timeoutMs: GIT_TIMEOUT_MS });
  return files ? { files } : { unreadable: true };
}

/**
 * Touched by my work for one slice, given as `<initiative>/<slug>`: what its contract cites, from the slice's design, and what the work changes,
 * planned by the design or changed by the verified result, each record with its kind, title, status, and why it is listed.
 */
export async function touchedRecords(projectRoot, sliceId) {
  const match = SLICE_PATTERN.exec(String(sliceId ?? ""));
  if (!match) throw new TouchedError("invalid_slice", "Name the slice as <initiative>/<slug>.", 400);
  const [, id, slug] = match;
  const view = await loadInitiativeView(projectRoot, id).catch(() => null);
  const slice = view?.record?.slices && Object.hasOwn(view.record.slices, slug) ? view.record.slices[slug] : null;
  if (!slice) throw new TouchedError("unknown_slice", `The initiative ${id} has no slice ${slug}.`, 404);
  const title = view.roadmapItem?.title ?? view.record.slices[view.derived?.root]?.title ?? id;
  const { records } = await recordFiles(projectRoot);
  const byRef = new Map(records.map((record) => [record.ref, record]));
  const glossary = await loadGlossary(projectRoot);
  const design = await loadDesignView(projectRoot, id, slug).catch(() => null);
  const folder = await sliceDocumentFolder(projectRoot, id, slug).catch(() => null);
  const designPath = design?.path ?? (folder ? `${folder}/slice.md` : null);
  const designSource = designPath ? await readFile(path.join(projectRoot, designPath), "utf8").catch(() => null) : null;

  const group = () => new Map();
  const add = (target, key, record, why) => {
    const entry = target.get(key) ?? { kind: record.kind, title: record.title, status: record.status, ref: record.ref, why: [] };
    if (!entry.why.includes(why)) entry.why.push(why);
    target.set(key, entry);
  };
  // A record file of a kind the group lists; a path that names no record, such as code, is left out.
  const recordAt = (ref, kinds) => {
    const record = byRef.get(ref);
    return record && kinds.includes(record.kind) ? record : null;
  };

  const cites = group();
  const sections = new Map();
  for (const reference of slice.requirements ?? []) {
    const [file, anchor] = String(reference).split("#");
    if (!sections.has(file)) sections.set(file, []);
    if (anchor) sections.get(file).push(anchor);
  }
  for (const [file, anchors] of sections) {
    const record = recordAt(file, ["requirement"]) ?? { kind: "requirement", title: path.posix.basename(file, ".md"), status: null, ref: file };
    add(cites, file, record, anchors.length ? numbered("Section", anchors) : WHY.linked);
  }
  for (const target of linkTargets(designSource, designPath ?? "")) {
    const record = recordAt(target, ["requirement", "decision", "diagram"]);
    if (record) add(cites, target, record, WHY.linked);
  }
  const clauses = design?.clauses ?? [];
  for (const entry of glossary.exists ? glossaryEntries(glossary.content) : []) {
    const naming = clauses.filter((clause) => namesTerm(clause.text, entry.term)).map((clause) => clause.number);
    if (naming.length) cites.set(`term:${entry.term}`, { kind: "glossary-term", title: entry.term, status: "Defined", ref: "glossary", why: [numbered("Clause", naming)] });
  }

  const changes = group();
  const changeKinds = ["requirement", "decision", "glossary", "diagram"];
  for (const change of design?.changes ?? []) {
    const record = recordAt(change.path, changeKinds);
    if (record) add(changes, change.path, record, WHY.planned);
  }
  const verified = await verifiedChanges(projectRoot, id, slug, slice);
  for (const file of verified?.files ?? []) {
    const record = recordAt(file, changeKinds);
    if (record) add(changes, file, record, WHY.verified);
  }

  const listed = (target) => [...target.values()].map((entry) => ({ ...entry, status: entry.status ?? null }));
  return {
    initiative: { id, title },
    slice: { slug, title: slice.title },
    groups: [{ reason: "cites", records: listed(cites) }, { reason: "changes", records: listed(changes) }],
    ...(verified?.unreadable ? { verifiedUnreadable: true } : {})
  };
}
