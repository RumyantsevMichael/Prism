// Generated from src/server/workflow/roadmap.mts by scripts/native-build/compile.mjs.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertInput, describeErrors } from "./artifact-schema.mjs";
import { withArtifactLock, withFileLock } from "./artifact-store.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { fitScopes, normalizeRequirementReference, readInitiative, scopeDependents, scopeLeaves, unfinishedFixes, unfinishedFixesMessage, withInitiativeWriteLocks } from "./initiative.mjs";
import { generatedNotice, writeProjection } from "./projection.mjs";
import { closeShipGate, readCoordinationState } from "./state.mjs";
import { readWorkflowConfig, roadmapPaths } from "./workflow-config.mjs";
import { resolveArtifactPath } from "../conservation/change-map.mjs";
import { conservationStore } from "../conservation/conservation-store.mjs";
import { revisionMismatch } from "./revision.mjs";
import { objectsAt } from "./git-objects.mjs";
import { repositoryOf } from "./verification.mjs";
import { inArtifactStore, listRecordEntries, locateRecord, moveLegacyRecords, oversizedRevision, readRecord, readStoreFileBytes, writeRecord } from "./record-store.mjs";
import { mergeHistory, mergeKeyed, mergeOrder, mergeScalars, MergeConflict, parseVersions } from "./record-merge.mjs";
import { ComponentError, listComponents, listsComponents, readComponents } from "./components.mjs";
import { latestDependentsRun, verifiedAt } from "./slice-design.mjs";
import { initiativePlan } from "./ship-standing.mjs";
import { acceptLinkedAdrs, linkedAdrProblems, unlinkedAdrs } from "./store-artifacts.mjs";
import { proposeComponents } from "./workspace-manifests.mjs";
import { parseStoreJson } from "./store-json.mjs";
import { documentDigests, entryShippedDecision, hasOpenWork, openWork, openWorkMessage, readSliceDocuments, recordEarlierShips, ShippedHistoryError, writeHistoryMarks } from "./shipped-history.mjs";
const BANDS = Object.freeze(["Now", "Next", "Later", "Parked"]);
const DISPLAY_BANDS = Object.freeze([...BANDS, "Shipped"]);
const ROADMAP_STATES = Object.freeze(["envisioned", "planned", "in-progress", "shipped", "superseded"]);
const RECORD_MAX_BYTES = 1024 * 1024;
const HISTORY_LIMIT = 500;
class RoadmapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoadmapError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new RoadmapError(code, message, details);
const text = { type: "string", minLength: 1, maxLength: 4e3 };
const id = { type: "string", minLength: 1, maxLength: 120 };
const ids = { type: "array", maxItems: 200, items: id };
const references = { type: "array", maxItems: 200, items: text };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const band = { enum: BANDS };
const position = { type: "integer", minimum: 0, maximum: 1e4 };
const corrects = object({ initiative: id, slices: { type: "array", maxItems: 200, items: id } });
const WORKSPACE_NAME_MAX = 64;
function workspaceNameProblem(value) {
  if (typeof value !== "string") return "workspaceName must be a string.";
  if (value !== value.trim() || !value) return "workspaceName must be non-empty and have no leading or trailing spaces.";
  if (value.length > WORKSPACE_NAME_MAX) return `workspaceName must have at most ${WORKSPACE_NAME_MAX} characters.`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "workspaceName must be one line without control characters.";
  return null;
}
const GET_ROADMAP_SCHEMA = object({ projectRoot: text }, ["projectRoot"]);
const UPDATE_ROADMAP_SCHEMA = object({
  projectRoot: text,
  expectedRevision: { oneOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
  actor: text,
  operations: { type: "array", minItems: 1, maxItems: 100, items: { oneOf: [
    object({ op: { const: "set_serves" }, serves: text }),
    object({ op: { const: "set_workspace_name" }, name: { type: "string", maxLength: WORKSPACE_NAME_MAX } }, ["op", "name"]),
    object({ op: { const: "add_initiative" }, id, title: text, intent: text, pillar: text, band, position, requirements: references, requires: ids, rationale: text, corrects }, ["op", "id", "title", "intent", "band"]),
    object({ op: { const: "update_initiative" }, id, title: text, intent: text, pillar: text, requirements: references, rationale: text, corrects }, ["op", "id"]),
    object({ op: { const: "place" }, id, band, position }, ["op", "id", "band"]),
    object({ op: { const: "set_requires" }, id, requires: ids }),
    object({ op: { const: "ship" }, id, afterGate: id }, ["op", "id"]),
    object({ op: { const: "record_legacy_ship" }, id }, ["op", "id"]),
    object({ op: { const: "supersede" }, id, by: id, reason: text }),
    object({ op: { const: "set_open_questions" }, questions: { type: "array", maxItems: 100, items: text } }),
    object({ op: { const: "replace_hand_written_projection" } }),
    object({ op: { const: "regenerate_markdown" } })
  ] } }
}, ["projectRoot", "expectedRevision", "operations"]);
function validateInput(schema, input) {
  try {
    assertInput(schema, input);
  } catch (error) {
    throw fail("validation_failed", `The roadmap arguments are invalid: ${describeErrors(error.errors)}`, { errors: error.errors });
  }
}
async function resolveRoadmap(projectRoot, createParent = false) {
  const config = await readWorkflowConfig(projectRoot);
  const paths = roadmapPaths(config);
  if (!paths) throw fail("invalid_config", "The workflow config disables the roadmap path.");
  const record = await locateRecord(projectRoot, { kind: "roadmap" });
  const inStore = await inArtifactStore(projectRoot, paths.projection);
  const projection = inStore ? { deltaPath: paths.projection } : await resolveArtifactPath(projectRoot, paths.projection, createParent, path.posix.basename(paths.projection));
  return { root: record.root, config, recordPath: record.path, target: record.target, projectionPath: projection.deltaPath, inStore, recordName: path.posix.basename(paths.record) };
}
function emptyRoadmap() {
  return { schemaVersion: 1, serves: "", initiatives: [], openQuestions: [], history: [] };
}
function validateRoadmap(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ["The roadmap record must be a JSON object."];
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (typeof raw.serves !== "string") errors.push("serves must be a string.");
  if (raw.workspaceName !== void 0 && workspaceNameProblem(raw.workspaceName)) errors.push(workspaceNameProblem(raw.workspaceName));
  if (!Array.isArray(raw.openQuestions) || raw.openQuestions.some((item) => typeof item !== "string")) errors.push("openQuestions must be an array of strings.");
  if (!Array.isArray(raw.history)) errors.push("history must be an array.");
  if (!Array.isArray(raw.initiatives)) return [...errors, "initiatives must be an array."];
  const known = /* @__PURE__ */ new Set();
  for (const [index, item] of raw.initiatives.entries()) {
    const field = `initiatives[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${field} must be an object.`);
      continue;
    }
    if (typeof item.id !== "string" || !SLUG_PATTERN.test(item.id)) errors.push(`${field}.id must use letters, digits, hyphens, or underscores.`);
    else if (known.has(item.id)) errors.push(`${field}.id duplicates ${item.id}.`);
    known.add(item.id);
    if (typeof item.title !== "string" || !item.title.trim()) errors.push(`${field}.title must be a non-empty string.`);
    if (typeof item.intent !== "string" || !item.intent.trim()) errors.push(`${field}.intent must be a non-empty string.`);
    if (!BANDS.includes(item.band)) errors.push(`${field}.band must be one of ${BANDS.join(", ")}.`);
    for (const key of ["requirements", "requires"]) if (!Array.isArray(item[key]) || item[key].some((value) => typeof value !== "string")) errors.push(`${field}.${key} must be an array of strings.`);
    if (item.decision !== null && !["shipped", "superseded"].includes(item.decision?.kind)) errors.push(`${field}.decision must be null, shipped, or superseded.`);
    else if (item.decision?.kind === "shipped") errors.push(...shippedDocumentErrors(item.decision, `${field}.decision`));
    if (item.corrects !== void 0 && (!item.corrects || typeof item.corrects !== "object" || typeof item.corrects.initiative !== "string" || !Array.isArray(item.corrects.slices) || !item.corrects.slices.length || item.corrects.slices.some((value) => typeof value !== "string"))) errors.push(`${field}.corrects must be { initiative, slices } with at least one slice.`);
  }
  for (const item of raw.initiatives) {
    for (const target of item.requires ?? []) {
      if (target === item.id) errors.push(`${item.id} cannot require itself.`);
      else if (!known.has(target)) errors.push(`${item.id} requires unknown initiative ${target}.`);
    }
    if (item.corrects && typeof item.corrects.initiative === "string") {
      if (item.corrects.initiative === item.id) errors.push(`${item.id} cannot correct itself.`);
      else if (!known.has(item.corrects.initiative)) errors.push(`${item.id} corrects unknown initiative ${item.corrects.initiative}.`);
    }
    if (item.decision?.kind === "superseded" && !known.has(item.decision.by)) errors.push(`${item.id} is superseded by unknown initiative ${item.decision.by}.`);
  }
  if (errors.length === 0) {
    const graph = new Map(raw.initiatives.map((item) => [item.id, item.requires]));
    const visiting = /* @__PURE__ */ new Set();
    const done = /* @__PURE__ */ new Set();
    const visit = (node) => {
      if (done.has(node)) return;
      if (visiting.has(node)) throw fail("invalid_roadmap", `Initiative requirements form a cycle through ${node}.`);
      visiting.add(node);
      graph.get(node).forEach(visit);
      visiting.delete(node);
      done.add(node);
    };
    try {
      graph.forEach((_, node) => visit(node));
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
}
function shippedDocumentErrors(decision, field) {
  const errors = [];
  if (decision.documents !== void 0 && (!Array.isArray(decision.documents) || decision.documents.some((item) => typeof item?.path !== "string" || !/^[0-9a-f]{64}$/.test(item?.sha256 ?? "")))) errors.push(`${field}.documents must be an array of { path, sha256 }.`);
  if (decision.documentsRecordedAt !== void 0 && typeof decision.documentsRecordedAt !== "string") errors.push(`${field}.documentsRecordedAt must be a string.`);
  if (decision.documentsFrom !== void 0 && !["ship", "first-read"].includes(decision.documentsFrom)) errors.push(`${field}.documentsFrom must be ship or first-read.`);
  return errors;
}
function serializeRoadmap(record) {
  return `${JSON.stringify(record, null, 2)}
`;
}
function mergeRoadmapRecord(versions) {
  try {
    const { base, local, upstream } = parseVersions(versions, emptyRoadmap);
    if ([base, local, upstream].some((record) => !record || typeof record !== "object" || Array.isArray(record) || !Array.isArray(record.initiatives) || !Array.isArray(record.history))) throw new MergeConflict("A version of the roadmap record has no initiatives or history list.");
    const byId = (record) => Object.fromEntries(record.initiatives.map((item) => [item?.id, item]));
    const ids2 = (record) => record.initiatives.map((item) => item?.id);
    const entries = mergeKeyed("Initiative", byId(base), byId(local), byId(upstream));
    const order = mergeOrder("The initiative order", ids2(base), ids2(local), ids2(upstream), new Set(Object.keys(entries)));
    const scalars = mergeScalars(base, local, upstream, ["initiatives", "history"]);
    const merged = {};
    for (const key of /* @__PURE__ */ new Set([...Object.keys(upstream), ...Object.keys(local), ...Object.keys(base)])) {
      if (key === "initiatives") merged.initiatives = order.map((id2) => entries[id2]);
      else if (key === "history") merged.history = mergeHistory(base.history, local.history, upstream.history, HISTORY_LIMIT);
      else if (Object.hasOwn(scalars, key)) merged[key] = scalars[key];
    }
    const errors = validateRoadmap(merged);
    if (errors.length) return { conflict: `The merged roadmap record is invalid: ${errors[0]}` };
    const contents = serializeRoadmap(merged);
    if (Buffer.byteLength(contents) > RECORD_MAX_BYTES) return { conflict: "The merged roadmap record exceeds 1 MiB." };
    return { contents };
  } catch (error) {
    return { conflict: error instanceof MergeConflict ? error.message : `The roadmap record versions could not be merged: ${error.message}` };
  }
}
async function loadRoadmap(resolved) {
  let contents;
  try {
    contents = await readStoreFileBytes(resolved.target, RECORD_MAX_BYTES);
  } catch (error) {
    if (error.tooLarge) return { exists: true, revision: oversizedRevision(error), record: null, valid: false, errors: [error.message] };
    throw error;
  }
  if (contents === null) return { exists: false, revision: null, record: null, valid: true, errors: [] };
  const revision = createHash("sha256").update(contents).digest("hex");
  let raw;
  try {
    raw = parseStoreJson(contents.toString("utf8"));
  } catch {
    return { exists: true, revision, record: null, valid: false, errors: ["The roadmap record must contain valid JSON."] };
  }
  const errors = validateRoadmap(raw);
  return { exists: true, revision, record: raw, valid: errors.length === 0, errors };
}
async function dependentsBlockers(projectRoot, config, initiative, record) {
  let declaration;
  try {
    declaration = readComponents(config);
  } catch (error) {
    if (error instanceof ComponentError) return { problem: error, scopes: [] };
    throw error;
  }
  const scopes = [];
  for (const scope of fitScopes(record)) {
    const dependents = scopeDependents(record, scope, declaration).map((component) => component.identity);
    if (!dependents.length) continue;
    const latest = await latestDependentsRun(projectRoot, initiative, scope).catch(() => null);
    const started = Date.parse(latest?.entry?.startedAt ?? "");
    if (latest && !Number.isNaN(started)) {
      const verified = await Promise.all(scopeLeaves(record, scope).map((leaf) => verifiedAt(projectRoot, initiative, leaf).catch(() => null)));
      if (verified.some((finished) => finished !== null && finished >= started)) {
        scopes.push({ scope, blocked: dependents, reason: "stale", run: latest.path });
        continue;
      }
    }
    const ran = new Set((Array.isArray(latest?.entry?.components) ? latest.entry.components : []).map((component) => component?.name));
    const red = new Set(Array.isArray(latest?.entry?.blocked) ? latest.entry.blocked : []);
    const blocked = dependents.filter((name) => !ran.has(name) || red.has(name));
    if (!blocked.length) continue;
    const reason = blocked.some((name) => ran.has(name) && red.has(name)) ? "failed" : "not_run";
    scopes.push({ scope, blocked, reason });
  }
  return { scopes };
}
const execute = promisify(execFile);
const SHIP_HISTORY_MAX = 1e3;
const SHIP_FETCH_TIMEOUT_MS = 12e4;
const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
async function gitOutput(root, args, options = {}) {
  try {
    return (await execute("git", args, { cwd: root, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options })).stdout;
  } catch {
    return null;
  }
}
async function defaultBranchHistory(root) {
  await gitOutput(root, ["fetch", "--quiet", "origin"], { timeout: SHIP_FETCH_TIMEOUT_MS });
  for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    const commit = (await gitOutput(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]))?.trim();
    if (!commit) continue;
    return (await gitOutput(root, ["rev-list", "--first-parent", `--max-count=${SHIP_HISTORY_MAX}`, "--end-of-options", commit]) ?? "").split("\n").filter(Boolean);
  }
  return [];
}
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
async function changesOf(root, commits, paths, firstParent) {
  const changes = /* @__PURE__ */ new Map();
  if (!commits.length || !paths.length) return changes;
  const running = execute("git", ["--literal-pathspecs", "diff-tree", "--stdin", "-r", "-m", ...firstParent ? ["--first-parent"] : [], "--raw", "-z", "--no-abbrev", "--no-renames", "--relative", "--", ...paths], { cwd: root, env: gitEnv(), maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  running.child.stdin.end(`${commits.join("\n")}
`);
  let output;
  try {
    output = (await running).stdout;
  } catch {
    return null;
  }
  let current = null;
  const fields = output.split("\0");
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at];
    if (!field) continue;
    if (field.startsWith(":")) {
      const object2 = field.split(" ")[3];
      changes.get(current)?.push({ path: fields[at + 1], blob: /^0+$/.test(object2 ?? "") ? null : object2 });
      at += 1;
    } else {
      current = field.trim().split(" ")[0];
      if (!changes.has(current)) changes.set(current, []);
    }
  }
  return changes;
}
async function shipCommit(root, commits, accepted) {
  const paths = [...accepted.keys()];
  if (!commits.length || !paths.length) return null;
  const oldest = commits.at(-1);
  const held = await objectsAt(root, oldest, paths);
  if (held === null) return null;
  const matches = () => paths.every((file) => accepted.get(file).has(held.get(file)));
  if (matches()) return oldest;
  const newer = commits.slice(0, -1).reverse();
  if (!newer.length) return null;
  const changes = await changesOf(root, newer, paths, true);
  if (changes === null) return null;
  for (const commit of newer) {
    for (const change of changes.get(commit) ?? []) if (held.has(change.path)) held.set(change.path, change.blob);
    if (matches()) return commit;
  }
  return null;
}
async function descendantBlobs(root, verified, paths) {
  const found = new Map(paths.map((file) => [file, /* @__PURE__ */ new Set()]));
  const tips = [...new Set((await gitOutput(root, ["for-each-ref", "--contains", verified, "--format=%(objectname)"]) ?? "").split("\n").filter((line) => COMMIT_PATTERN.test(line)))];
  if (!tips.length) return found;
  const commits = (await gitOutput(root, ["rev-list", "--ancestry-path", `--max-count=${SHIP_HISTORY_MAX}`, ...tips, "--not", verified]) ?? "").split("\n").filter(Boolean);
  const changes = await changesOf(root, commits, paths, false);
  for (const list of changes?.values() ?? []) for (const change of list) found.get(change.path)?.add(change.blob);
  return found;
}
async function commitsAfter(root, commits, verified) {
  if (!commits.length) return commits;
  const output = await gitOutput(root, ["rev-list", "--first-parent", `--max-count=${commits.length}`, commits[0], "--not", `${verified}^@`]);
  if (output === null) return commits;
  const count = output.split("\n").filter(Boolean).length;
  return commits.slice(0, count);
}
async function shippedSlices(root, initiative) {
  let loaded;
  try {
    ({ loaded } = await readInitiative(root, initiative));
  } catch {
    return {};
  }
  if (!loaded.valid || !loaded.analysis) return {};
  const slices = {};
  const runs = {};
  for (const slug of loaded.analysis.leaves) {
    if (loaded.analysis.slices[slug]?.status !== "done") continue;
    const entries = await listRecordEntries(root, { kind: "runs", initiative, slice: slug }).catch(() => []);
    const run = entries.filter((item) => item.entry?.kind === "verification" && item.entry.passed === true).at(-1)?.entry;
    if (!run) continue;
    runs[slug] = run;
    slices[slug] = { repository: run.checkout?.repository ?? null, verified: run.checkout?.head ?? null, shipped: null };
  }
  const own = Object.keys(slices).length ? await repositoryOf(root).catch(() => null) : null;
  const filesOf = (run) => Array.isArray(run.files) ? run.files.filter((file) => typeof file?.path === "string" && (file.blob === null || typeof file.blob === "string")) : [];
  const looked = Object.keys(slices).filter((slug) => own && slices[slug].repository === own && COMMIT_PATTERN.test(slices[slug].verified ?? "") && filesOf(runs[slug]).length);
  if (!looked.length) return slices;
  const commits = await defaultBranchHistory(root);
  for (const slug of looked) {
    const files = filesOf(runs[slug]);
    const paths = files.map((file) => file.path);
    const accepted = new Map(files.map((file) => [file.path, /* @__PURE__ */ new Set([file.blob])]));
    for (const [file, blobs] of await descendantBlobs(root, slices[slug].verified, paths)) for (const blob of blobs) accepted.get(file).add(blob);
    slices[slug].shipped = await shipCommit(root, await commitsAfter(root, commits, slices[slug].verified), accepted);
  }
  return slices;
}
const dependentsMessage = (scopes) => `The initiative cannot ship while the dependents of a finished scope are red or have not run: ${scopes.map((item) => `${item.scope} (${item.reason === "stale" ? `the run ${item.run} predates the scope's latest verified change` : item.reason === "failed" ? "failed or declined" : "not run"}: ${item.blocked.join(", ")})`).join("; ")}. Run verify_slice with dependents for each scope, and fix or allow what it reports.`;
const unlinkedMessage = (adrs) => `The initiative cannot ship while a Proposed ADR cites its requirements and no slice.md links it, since the ship would leave that ADR Proposed: ${adrs.map((adr) => `${adr.path} in scope ${adr.scope} (cites ${adr.requirements.join(", ")})`).join("; ")}. Link each ADR that the initiative's contract relies on from the slice.md that relies on it with update_artifact, so the person sees it at the correctness gate and the ship accepts it, then ask a new correctness gate and ship; an ADR of another initiative is linked from that initiative's slice.md.`;
const ambiguousMessage = (adrs, outcome) => `A link in a slice.md could name ADRs at the same path in two or more scopes, none of them the scope of that slice.md, so the ship cannot tell which one it accepts${outcome}: ${adrs.map((adr) => `${adr.path} in scopes ${adr.scopes.join(", ")}`).join("; ")}. Keep the ADR in one of those scopes, or keep the slice.md in the scope of the one it means, then ask a new correctness gate and ship.`;
const withoutGates = (work, exempt) => exempt.size ? { ...work, gates: work.gates.filter((gate) => !exempt.has(gate.id)) } : work;
async function withOpenWork(projectRoot, item, result, options = {}, exempt = /* @__PURE__ */ new Set()) {
  const found = await openWork(projectRoot, item.id, options).catch(() => null);
  const work = found && withoutGates(found, exempt);
  if (!work || !hasOpenWork(work)) return null;
  const { derived } = result;
  const diagnostic = { code: "open_work", message: openWorkMessage(item.id, work), ...work };
  return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, diagnostic] }, blocker: derived.readyToShip ? { open: work } : result.blocker };
}
function confirmingGates(config, state, ship) {
  if (ship) return new Set(ship.afterGate === void 0 ? [] : [ship.afterGate]);
  if (!hasStore(config) || !Array.isArray(state?.pending)) return /* @__PURE__ */ new Set();
  const newest = state.pending.filter((gate) => isGate(gate) && gate.kind === "correctness").reduce((latest, gate) => latest && String(latest.askedAt ?? "") > String(gate.askedAt ?? "") ? latest : gate, null);
  return new Set(newest ? [newest.id] : []);
}
async function deriveItem(projectRoot, config, item, ship = null) {
  const base = { id: item.id, band: item.band, state: "envisioned", readyToShip: false, progress: null, active: [], diagnostics: [] };
  const leaves = { leaves: true };
  if (item.decision?.kind === "shipped") return { derived: { ...base, band: "Shipped", state: "shipped" }, blocker: null };
  if (item.decision?.kind === "superseded") return { derived: { ...base, state: "superseded", supersededBy: item.decision.by }, blocker: leaves };
  let initiative;
  try {
    initiative = await readInitiative(projectRoot, item.id);
  } catch (error) {
    const result = { derived: { ...base, diagnostics: [{ code: error.code ?? "initiative_unreadable", message: error.message }] }, blocker: leaves };
    return await withOpenWork(projectRoot, item, result) ?? result;
  }
  const { loaded } = initiative;
  if (!loaded.exists) {
    const result = { derived: base, blocker: leaves };
    return await withOpenWork(projectRoot, item, result) ?? result;
  }
  if (!loaded.valid) {
    const result = { derived: { ...base, state: "planned", diagnostics: loaded.errors.map((message) => ({ code: "invalid_initiative", message })) }, blocker: leaves };
    return await withOpenWork(projectRoot, item, result) ?? result;
  }
  const analysis = loaded.analysis;
  const progress = { leaves: analysis.leaves.length, ...analysis.counts };
  let active = [];
  let state;
  try {
    state = await readCoordinationState({ projectRoot, initiative: item.id });
    active = state.state?.active ?? [];
  } catch (error) {
    base.diagnostics.push({ code: error.code ?? "state_unreadable", message: error.message });
  }
  const started = analysis.leaves.some((slug) => analysis.slices[slug].status !== "not-started") || active.length > 0;
  const derived = { ...base, state: started ? "in-progress" : "planned", readyToShip: analysis.complete[analysis.root] === true, progress, active, root: analysis.root };
  if (state) {
    const open = await withOpenWork(projectRoot, item, { derived, blocker: leaves }, { record: loaded.record, state }, confirmingGates(config, state.state, ship));
    if (open) return open;
  }
  const fixes = unfinishedFixes(loaded.record);
  if (fixes.length) return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, { code: "fixes_unfinished", message: unfinishedFixesMessage(item.id, fixes), fixes }] }, blocker: { fixes } };
  if (!derived.readyToShip) return { derived, blocker: leaves };
  const found = await dependentsBlockers(projectRoot, config, item.id, loaded.record);
  if (found.problem) return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, { code: found.problem.code, message: found.problem.message }] }, blocker: { problem: found.problem } };
  if (found.scopes.length) return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, { code: "dependents_blocked", message: dependentsMessage(found.scopes), scopes: found.scopes }] }, blocker: { scopes: found.scopes } };
  if (hasStore(config)) {
    const { plan } = await initiativePlan(projectRoot, item.id);
    const adrs = await unlinkedAdrs(projectRoot, plan, Array.isArray(item.requirements) ? item.requirements : []);
    if (adrs.length) return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, { code: "adr_unlinked", message: unlinkedMessage(adrs), adrs }] }, blocker: { unlinked: adrs } };
    if (!ship && plan !== null) {
      let ambiguous;
      try {
        ({ ambiguous } = await linkedAdrProblems(projectRoot, plan));
      } catch (error) {
        if (error?.code !== "artifact_too_large") throw error;
        const problem = { code: error.code, message: error.message, ...typeof error.path === "string" ? { path: error.path, scope: error.scope?.label ?? null } : {} };
        return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, problem] }, blocker: { linkProblem: problem } };
      }
      if (ambiguous.length) return { derived: { ...derived, readyToShip: false, diagnostics: [...derived.diagnostics, { code: "adr_ambiguous", message: ambiguousMessage(ambiguous, ""), adrs: ambiguous }] }, blocker: { ambiguous } };
    }
  }
  return { derived, blocker: null };
}
async function deriveInitiative(projectRoot, config, item) {
  return (await deriveItem(projectRoot, config, item)).derived;
}
function publicResult(resolved, loaded, derivedItems = null) {
  return {
    recordPath: resolved.recordPath,
    projectionPath: resolved.projectionPath,
    exists: loaded.exists,
    revision: loaded.revision,
    valid: loaded.valid,
    errors: loaded.errors,
    record: loaded.record,
    // Each initiative's recorded decision beside its id, so a shipped one's slices and their commits read without the whole record.
    initiatives: (loaded.valid && Array.isArray(loaded.record?.initiatives) ? loaded.record.initiatives : []).map((item) => ({ id: item.id, decision: item.decision })),
    ...derivedItems ? { derived: derivedItems } : {}
  };
}
async function readRoadmap(projectRoot) {
  const resolved = await resolveRoadmap(projectRoot);
  const loaded = await loadRoadmap(resolved);
  const derivedItems = loaded.valid && loaded.record ? await Promise.all(loaded.record.initiatives.map((item) => deriveInitiative(resolved.root, resolved.config, item))) : [];
  return { resolved, loaded, derived: derivedItems };
}
async function roadmapComponents(projectRoot, config) {
  const listed = listComponents(config);
  if (listsComponents(config)) return listed;
  const proposed = await proposeComponents(projectRoot, { rootName: listed.repository ?? "root" });
  if (proposed === null) return listed;
  const block = proposed.markdown.split("\n").slice(1, -1);
  let problem;
  try {
    readComponents({ ...config, lines: { ...config?.lines, Components: block } });
  } catch (error) {
    if (!(error instanceof ComponentError)) throw error;
    problem = { code: error.code, message: error.message };
  }
  return { ...listed, proposal: { ...proposed, ...problem ? { problem } : {} } };
}
async function readWorkspaceName(projectRoot) {
  try {
    const { bytes } = await readRecord(projectRoot, { kind: "roadmap" });
    if (!bytes) return null;
    const name = parseStoreJson(bytes.toString("utf8"))?.workspaceName;
    return typeof name === "string" && !workspaceNameProblem(name) ? name : null;
  } catch {
    return null;
  }
}
async function readStoreWorkspaceName(folder) {
  try {
    const file = path.join(folder, "roadmap.json");
    const info = await lstat(file);
    if (!info.isFile() || info.size > RECORD_MAX_BYTES) return null;
    const name = parseStoreJson(await readFile(file, "utf8"))?.workspaceName;
    return typeof name === "string" && !workspaceNameProblem(name) ? name : null;
  } catch {
    return null;
  }
}
async function getRoadmap(input) {
  validateInput(GET_ROADMAP_SCHEMA, input);
  let { resolved, loaded, derived } = await readRoadmap(input.projectRoot);
  const recorded = loaded.valid && loaded.record ? await recordEarlierShips(resolved.root, loaded.record.initiatives) : [];
  if (recorded.length) ({ resolved, loaded, derived } = await readRoadmap(input.projectRoot));
  const markedHistory = recorded.filter((item) => item.marked.length);
  return { ...publicResult(resolved, loaded, derived), components: await roadmapComponents(resolved.root, resolved.config), ...markedHistory.length ? { markedHistory } : {} };
}
function roadmapViewOf(bytes, recordName) {
  if (!bytes || bytes.length > RECORD_MAX_BYTES) return null;
  let raw;
  try {
    raw = parseStoreJson(bytes.toString("utf8"));
  } catch {
    return null;
  }
  return validateRoadmap(raw).length ? null : markdown(raw, recordName);
}
function markdown(record, recordName) {
  const lines = ["# Roadmap", "", generatedNotice(recordName), "Current progress is derived from initiative records, so read it through `get_roadmap` or the review browser.", ""];
  if (record.workspaceName) lines.push(`Workspace: ${record.workspaceName}`, "");
  if (record.serves) lines.push(`Serves: ${record.serves}`, "");
  const titles = new Map(record.initiatives.map((item) => [item.id, item.title]));
  const entry = (item) => {
    const parts = [`- **${item.title}** (\`${item.id}\`): ${item.intent}`];
    if (item.requires.length) parts.push(`Requires ${item.requires.map((target) => `\`${target}\``).join(", ")}.`);
    if (item.corrects) parts.push(`Corrects \`${item.corrects.initiative}\`: ${item.corrects.slices.map((slug) => `\`${slug}\``).join(", ")}.`);
    return parts.join(" ");
  };
  lines.push("## Initiative index", "");
  const open = record.initiatives.filter((item) => !item.decision);
  for (const name of BANDS) {
    const members = open.filter((item) => item.band === name);
    if (members.length) lines.push(`### ${name}`, "", ...members.map(entry), "");
  }
  const shipped = record.initiatives.filter((item) => item.decision?.kind === "shipped");
  const shippedOn = (decision) => decision.legacy === true ? `Shipped before Prism, recorded ${decision.at.slice(0, 10)}.` : `Shipped ${decision.at.slice(0, 10)}.`;
  if (shipped.length) lines.push("### Shipped", "", ...shipped.map((item) => `${entry(item)} ${shippedOn(item.decision)}`), "");
  const rationale = open.filter((item) => item.rationale && item.band !== "Parked");
  lines.push("## Sequencing rationale", "", ...rationale.length ? rationale.map((item) => `- **${item.title}**: ${item.rationale}`) : ["No sequencing rationale is recorded."], "");
  const parked = open.filter((item) => item.band === "Parked");
  if (parked.length) lines.push("## Parked context", "", ...parked.map((item) => `- **${item.title}**: ${item.rationale ?? "No reason is recorded."}`), "");
  const superseded = record.initiatives.filter((item) => item.decision?.kind === "superseded");
  if (superseded.length) lines.push("## Superseded context", "", ...superseded.map((item) => `- **${item.title}** was superseded by **${titles.get(item.decision.by)}**: ${item.decision.reason}`), "");
  lines.push("## Open questions", "", ...record.openQuestions.length ? record.openQuestions.map((question) => `- ${question}`) : ["No open questions are recorded."], "");
  lines.push("## Lifecycle", "", "`envisioned`, `planned`, and `in-progress` are derived from initiative records and coordination state.", "`shipped` and `superseded` are recorded decisions.", "");
  return `${lines.join("\n")}`;
}
function findInitiative(record, value) {
  const item = record.initiatives.find((candidate) => candidate.id === value);
  if (!item) throw fail("validation_failed", `The roadmap has no initiative ${value}.`);
  return item;
}
function insertInBand(record, item, targetBand, positionValue) {
  record.initiatives = record.initiatives.filter((candidate) => candidate !== item);
  item.band = targetBand;
  const members = record.initiatives.filter((candidate) => candidate.band === targetBand && !candidate.decision);
  const anchor = positionValue === void 0 || positionValue >= members.length ? null : members[positionValue];
  const index = anchor ? record.initiatives.indexOf(anchor) : (() => {
    const last = members.at(-1);
    return last ? record.initiatives.indexOf(last) + 1 : record.initiatives.length;
  })();
  record.initiatives.splice(index, 0, item);
}
function roadmapRequirements(resolved, references2) {
  return references2.map((reference) => {
    const normalized = normalizeRequirementReference(resolved.config.paths.requirements, reference);
    if (normalized.problem) throw fail("validation_failed", normalized.problem);
    return normalized.reference;
  });
}
const hasStore = (config) => (config.workspace?.store ?? null) !== null;
const isGate = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const HOW_TO_CONFIRM = "Ask the person with an update_coordination_state gateOperations ask of kind correctness, wait for the answer with wait_for_user_gate, and ship with afterGate set to that gate's id once the person approves it in the review browser.";
const unconfirmed = (reason, details) => fail("ship_unconfirmed", `${reason} ${HOW_TO_CONFIRM}`, details);
function changesText(changed) {
  const names = (repositories) => repositories.length ? repositories.join(", ") : "no repository";
  const adr = { added: "the ship would now also accept the ADR", changed: "the ADR", removed: "the ship would no longer accept the ADR" };
  const parts = changed.slice(0, 10).map((item) => item.slice !== void 0 ? `${item.slice} ${item.run === null ? "has no passing verification run" : `passed verification again in run ${item.run}`}` : item.folder !== void 0 ? `the links of the slice in ${item.folder} resolve in ${names(item.repositories)} rather than ${names(item.before)}` : item.kind === "adrs" ? `${adr[item.change]} ${item.path} in scope ${item.scope}${item.change === "changed" ? " was changed" : ""}` : `${item.path} in scope ${item.scope} was ${item.change}`);
  return `${parts.join("; ")}${changed.length > 10 ? `; and ${changed.length - 10} more` : ""}`;
}
async function confirmShip(projectRoot, initiative, afterGate, runs = null) {
  const refuse = (reason, details = {}) => unconfirmed(reason, { ...afterGate === void 0 ? {} : { afterGate }, ...details });
  if (afterGate === void 0) throw refuse(`With a record store, ship needs afterGate, a correctness gate of ${initiative} that the person approved in the review browser, since shipping accepts the initiative's Proposed ADRs.`);
  let state = null;
  try {
    state = (await readCoordinationState({ projectRoot, initiative })).state;
  } catch {
    state = null;
  }
  const gate = [...Array.isArray(state?.pending) ? state.pending : [], ...Array.isArray(state?.closed) ? state.closed : []].find((candidate) => isGate(candidate) && candidate.id === afterGate);
  if (!gate) throw refuse(`${afterGate} is no gate of the initiative ${initiative}, so nothing confirms the ship.`);
  if (gate.kind !== "correctness") throw refuse(`${afterGate} is a ${gate.kind} gate, and only a correctness gate confirms a ship.`);
  if (!isGate(gate.answer)) throw refuse(`The correctness gate ${afterGate} has no answer yet, so the initiative does not ship until the person approves it.`);
  if (gate.answer.via !== "browser" || gate.answer.choice !== "approve") {
    const note = typeof gate.answer.note === "string" && gate.answer.note ? `: ${gate.answer.note}` : "";
    throw refuse(`The person answered the correctness gate ${afterGate} with ${gate.answer.choice ?? "no choice"}${note}, so the initiative does not ship; address the answer and ask again.`);
  }
  if (runs === null) return gate;
  if (!isGate(gate.standing) || !["runs", "slices", "repositories", "adrs"].every((key) => Array.isArray(gate.standing[key]))) {
    throw refuse(`The correctness gate ${afterGate} records nothing of what the initiative stood at when it was asked, so it cannot confirm what the ship accepts; ask a new one.`);
  }
  const asked = new Map(gate.standing.runs.map((item) => [item.slice, item.run]));
  const changed = runs.filter((item) => !asked.has(item.slice) || asked.get(item.slice) !== item.run).map((item) => ({ slice: item.slice, run: item.run }));
  if (changed.length) throw refuse(`The correctness gate ${afterGate} was asked before what the ship accepts: since then ${changesText(changed)}, so the person has not confirmed the initiative as it stands; ask a new one.`, { changed });
  return gate;
}
async function acceptShippedAdrs(resolved, shipped, at) {
  const ships = shipped.filter((ship) => ship.plan !== null).map((ship) => {
    const verifiedBy = ship.runs.filter((item) => item.checkout?.head).map((item) => ({ slice: item.slice, repository: item.checkout.repository ?? null, commit: item.checkout.head }));
    return { plan: ship.plan, standing: ship.standing, ship: { gate: ship.gate, initiative: ship.initiative, at, verifiedBy } };
  });
  if (!ships.length) return [];
  const outcome = await acceptLinkedAdrs(resolved.root, ships);
  if (outcome.refused === "ship_unconfirmed") {
    throw unconfirmed(`The correctness gate ${outcome.gate} was asked before what the ship accepts: since then ${changesText(outcome.changed)}, so the person has not confirmed the initiative as it stands; ask a new one.`, { afterGate: outcome.gate, changed: outcome.changed });
  }
  if (outcome.refused === "adr_ambiguous") {
    throw fail("adr_ambiguous", ambiguousMessage(outcome.adrs, " and nothing changed"), { adrs: outcome.adrs });
  }
  if (outcome.refused === "adr_pending") {
    const named = outcome.adrs.map((adr) => `${adr.path} in scope ${adr.scope.label} (${adr.gates.join(", ")})`).join("; ");
    throw fail("adr_pending", `The ship would accept ADRs that wait on the person's answer to an approval, so nothing changed: ${named}. Wait for the person to answer each approval in the review browser, or withdraw it by asking again, then ship.`, { adrs: outcome.adrs });
  }
  return outcome.accepted;
}
async function checkedCorrects(resolved, record, operation) {
  const { initiative, slices } = operation.corrects;
  if (initiative === operation.id) throw fail("validation_failed", `Initiative ${operation.id} cannot correct itself.`);
  const target = record.initiatives.find((candidate) => candidate.id === initiative);
  if (!target) throw fail("validation_failed", `The roadmap has no initiative ${initiative} to correct.`);
  if (!entryShippedDecision(target)) throw fail("validation_failed", `Initiative ${initiative} has not shipped, so a fix to its done work is not a new initiative: report the defect on the done slice with update_initiative report_defect and design a fix slice inside ${initiative}.`);
  if (!slices.length) throw fail("validation_failed", `The corrects field must name at least one slice of ${initiative}.`);
  let held = {};
  try {
    const { loaded } = await readInitiative(resolved.root, initiative);
    if (loaded.exists && loaded.valid && loaded.record?.slices && typeof loaded.record.slices === "object") held = loaded.record.slices;
  } catch {
    held = {};
  }
  const unknown = slices.filter((slug) => !Object.hasOwn(held, slug));
  if (unknown.length) throw fail("validation_failed", `The shipped initiative ${initiative} has no recorded slice ${unknown.join(", ")}.`, { initiative, slices: unknown });
  return { initiative, slices: [...new Set(slices)] };
}
async function applyOperation(resolved, record, operation, actor, at, marks, shipped, notes) {
  if (operation.op === "update_initiative" || operation.op === "set_requires") {
    const shipped2 = entryShippedDecision(record.initiatives.find((candidate) => candidate.id === operation.id));
    if (shipped2) throw new ShippedHistoryError(operation.id, shipped2.at);
  }
  if (operation.requirements !== void 0 && (operation.op === "add_initiative" || operation.op === "update_initiative")) operation = { ...operation, requirements: roadmapRequirements(resolved, operation.requirements) };
  if (operation.corrects !== void 0 && (operation.op === "add_initiative" || operation.op === "update_initiative")) {
    if (operation.op === "update_initiative") findInitiative(record, operation.id);
    operation = { ...operation, corrects: await checkedCorrects(resolved, record, operation) };
  }
  switch (operation.op) {
    case "set_serves":
      record.serves = operation.serves;
      break;
    case "set_workspace_name": {
      const name = operation.name.trim().replace(/\s+/g, " ");
      if (!name) {
        delete record.workspaceName;
        break;
      }
      const problem = workspaceNameProblem(name);
      if (problem) throw fail("validation_failed", problem.replace("workspaceName", "The workspace name"));
      record.workspaceName = name;
      break;
    }
    case "add_initiative": {
      if (!SLUG_PATTERN.test(operation.id)) throw fail("validation_failed", "Initiative identifiers use letters, digits, hyphens, or underscores.");
      if (record.initiatives.some((item2) => item2.id === operation.id)) throw fail("validation_failed", `The roadmap already has initiative ${operation.id}.`);
      const item = { id: operation.id, title: operation.title, intent: operation.intent, ...operation.pillar ? { pillar: operation.pillar } : {}, band: operation.band, requirements: operation.requirements ?? [], requires: operation.requires ?? [], ...operation.rationale ? { rationale: operation.rationale } : {}, ...operation.corrects ? { corrects: operation.corrects } : {}, decision: null };
      insertInBand(record, item, operation.band, operation.position);
      break;
    }
    case "update_initiative": {
      const item = findInitiative(record, operation.id);
      for (const key of ["title", "intent", "pillar", "requirements", "rationale", "corrects"]) if (operation[key] !== void 0) item[key] = operation[key];
      break;
    }
    case "place": {
      const item = findInitiative(record, operation.id);
      if (item.decision) throw fail("validation_failed", "A shipped or superseded initiative keeps its place in history.");
      insertInBand(record, item, operation.band, operation.position);
      break;
    }
    case "set_requires":
      findInitiative(record, operation.id).requires = [...operation.requires];
      break;
    case "ship": {
      const item = findInitiative(record, operation.id);
      if (item.decision) throw fail("validation_failed", `Initiative ${item.id} already has a ${item.decision.kind} decision.`);
      if (operation.afterGate !== void 0) await confirmShip(resolved.root, item.id, operation.afterGate);
      const work = withoutGates(await openWork(resolved.root, item.id), confirmingGates(resolved.config, null, operation));
      if (hasOpenWork(work)) throw fail("open_work", openWorkMessage(item.id, work), work);
      const { derived, blocker } = await deriveItem(resolved.root, resolved.config, item, operation);
      if (blocker?.open) throw fail("open_work", openWorkMessage(item.id, blocker.open), blocker.open);
      if (blocker?.fixes) throw fail("fixes_unfinished", unfinishedFixesMessage(item.id, blocker.fixes), { fixes: blocker.fixes });
      if (blocker?.leaves) throw fail("gate_blocked", "Every leaf slice in the initiative record must be done before the initiative ships.", { state: derived.state, progress: derived.progress, diagnostics: derived.diagnostics });
      if (blocker?.problem) throw blocker.problem;
      if (blocker?.scopes) throw fail("dependents_blocked", dependentsMessage(blocker.scopes), { scopes: blocker.scopes });
      if (blocker?.unlinked) throw fail("adr_unlinked", unlinkedMessage(blocker.unlinked), { adrs: blocker.unlinked });
      if (hasStore(resolved.config)) {
        const { plan, runs } = await initiativePlan(resolved.root, item.id);
        const gate = await confirmShip(resolved.root, item.id, operation.afterGate, runs);
        shipped.push({ initiative: item.id, gate: operation.afterGate, plan, runs, standing: gate.standing });
      } else if (operation.afterGate !== void 0) await confirmShip(resolved.root, item.id, operation.afterGate);
      const { documents, problems } = await readSliceDocuments(resolved.root, item.id);
      const slices = await shippedSlices(resolved.root, item.id);
      item.decision = { kind: "shipped", at, actor, slices, ...operation.afterGate === void 0 ? {} : { gate: operation.afterGate }, documents: documentDigests(documents), documentsRecordedAt: at, documentsFrom: "ship" };
      notes.noShipCommit.push(...Object.keys(slices).filter((slug) => slices[slug].shipped === null));
      marks.push({ initiative: item.id, decision: item.decision, documents, problems });
      break;
    }
    case "record_legacy_ship": {
      const item = findInitiative(record, operation.id);
      if (!notes.creating) throw fail("validation_failed", `record_legacy_ship records shipped history only in the call that creates the roadmap record from a legacy roadmap; ship ${item.id} with ship instead.`);
      if (item.decision) throw fail("validation_failed", `Initiative ${item.id} already has a ${item.decision.kind} decision.`);
      let held = false;
      try {
        held = (await readInitiative(resolved.root, item.id)).loaded.exists;
      } catch {
        held = true;
      }
      if (held) throw fail("validation_failed", `Initiative ${item.id} has an initiative record, so its work is Prism's own and ships through ship and its gate, not as legacy history.`);
      item.decision = { kind: "shipped", at, actor, legacy: true, slices: {}, documents: [] };
      notes.legacyShips.push(item.id);
      break;
    }
    case "supersede": {
      const item = findInitiative(record, operation.id);
      if (item.decision) throw fail("validation_failed", `Initiative ${item.id} already has a ${item.decision.kind} decision.`);
      if (operation.by === operation.id) throw fail("validation_failed", "An initiative cannot supersede itself.");
      findInitiative(record, operation.by);
      item.decision = { kind: "superseded", by: operation.by, reason: operation.reason, at, actor };
      break;
    }
    case "set_open_questions":
      record.openQuestions = [...operation.questions];
      break;
    case "replace_hand_written_projection":
    case "regenerate_markdown":
      break;
    default:
      throw fail("validation_failed", `Unsupported operation ${operation.op}.`);
  }
}
async function updateRoadmap(input) {
  validateInput(UPDATE_ROADMAP_SCHEMA, input);
  await moveLegacyRecords(input.projectRoot);
  const resolved = await resolveRoadmap(input.projectRoot, true);
  const managed = [resolved.projectionPath].filter((file) => !resolved.inStore && path.posix.basename(file) === "roadmap.md");
  if (managed.length) await conservationStore.registerCoordinationOutputs(resolved.root, managed);
  await mkdir(path.dirname(resolved.target), { recursive: true });
  const shipping = [...new Set(input.operations.filter((operation) => operation.op === "ship" && SLUG_PATTERN.test(operation.id ?? "")).map((operation) => operation.id))].sort();
  const holdShipLocks = (index, action) => index === shipping.length ? action() : withInitiativeWriteLocks(resolved.root, shipping[index], () => holdShipLocks(index + 1, action));
  return holdShipLocks(0, () => withArtifactLock(resolved.target, () => withFileLock(resolved.target, async () => {
    const current = await loadRoadmap(resolved);
    if (current.revision !== input.expectedRevision) {
      throw fail(input.expectedRevision === "null" ? "invalid_revision" : "revision_conflict", revisionMismatch("roadmap record", input.expectedRevision, current.revision), { currentRevision: current.revision });
    }
    if (current.exists && !current.valid) throw fail("invalid_roadmap", "The existing roadmap record is invalid and was not changed.", { errors: current.errors });
    const record = current.record ? structuredClone(current.record) : emptyRoadmap();
    const at = (/* @__PURE__ */ new Date()).toISOString();
    const actor = input.actor ?? "agent";
    const notes = { noShipCommit: [], legacyShips: [], creating: !current.exists };
    const marks = [];
    const shipped = [];
    for (const operation of input.operations) await applyOperation(resolved, record, operation, actor, at, marks, shipped, notes);
    const errors = validateRoadmap(record);
    if (errors.length) throw fail("invalid_roadmap", `The proposed roadmap is invalid and was not written: ${errors[0]}`, { errors });
    const acceptedAdrs = await acceptShippedAdrs(resolved, shipped, at);
    for (const operation of input.operations.filter((candidate) => candidate.op === "ship" && candidate.afterGate !== void 0)) await closeShipGate(resolved.root, operation.id, operation.afterGate);
    const mutating = input.operations.filter((operation) => !["regenerate_markdown", "replace_hand_written_projection"].includes(operation.op));
    for (const operation of mutating) record.history.push({ actor, operation: operation.op, ...operation.id ? { id: operation.id } : {}, at });
    record.history = record.history.slice(-HISTORY_LIMIT);
    const contents = serializeRoadmap(record);
    if (mutating.length && contents !== ((await readStoreFileBytes(resolved.target, RECORD_MAX_BYTES).catch(() => null))?.toString("utf8") ?? null)) {
      await writeRecord(resolved.root, { kind: "roadmap" }, contents);
    }
    const projection = markdown(record, resolved.recordName);
    let projectionStale = false;
    try {
      const replace = input.operations.some((operation) => operation.op === "replace_hand_written_projection");
      projectionStale = !(await writeProjection(resolved.root, resolved.projectionPath, projection, resolved.recordName, { replace })).written;
    } catch {
      projectionStale = true;
    }
    const history = await markShipped(resolved.root, marks);
    const { loaded, derived } = await readRoadmap(input.projectRoot);
    const shipNotes = input.operations.some((operation) => operation.op === "ship") ? { noShipCommit: notes.noShipCommit } : {};
    const legacyNotes = notes.legacyShips.length ? { legacyShips: notes.legacyShips } : {};
    return { ...publicResult(resolved, loaded, derived), created: !current.exists, previousRevision: current.revision, projectionStale, ...shipped.length ? { acceptedAdrs } : {}, ...history, ...shipNotes, ...legacyNotes };
  }, fail)));
}
async function markShipped(root, marks) {
  if (!marks.length) return {};
  const historyMarks = [];
  const historyMarkProblems = [];
  for (const { initiative, decision, documents, problems } of marks) {
    const written = await writeHistoryMarks(root, initiative, decision, documents);
    historyMarks.push(...written.marked);
    historyMarkProblems.push(...problems, ...written.problems);
  }
  historyMarkProblems.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { historyMarks: historyMarks.sort(), historyMarkProblems };
}
const ROADMAP_TOOLS = [
  {
    name: "get_roadmap",
    description: "Read the MCP-managed roadmap record, initiatives with each id and its recorded decision, each initiative's derived lifecycle state, band, slice progress, active work, and readiness to ship, and the repository's components: its repository name, the declared components by identity <repository>/<component> with their folder, test command, and dependencies, the declaration's problem when it is invalid, and, when the configuration lists no component and a root workspace manifest (package.json, pnpm-workspace.yaml, Cargo.toml, or go.work) gives workspace patterns, a proposal of a ## Components block with its components, shared paths, skipped manifests, and problem. Reads never create files, and the proposal is never written; offer it to the person to commit. The one exception is a shipped entry whose decision has not recorded its slice documents: the read records them with documentsFrom first-read, writes the history mark into each, and lists them under markedHistory ({ initiative, marked }); a document in the checkout is to be committed apart from the task's changes, while one in the record store is shared by its sync and needs no commit. With a record store, recordStore names the store without credentials, its folder on this machine, sync (on or off), and lastSync ({ state, at } or null), since the record then lives in the store, not at recordPath in the checkout.",
    inputSchema: GET_ROADMAP_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "update_roadmap",
    description: "Apply revision-checked roadmap operations: set what the roadmap serves, set the workspace name that every checkout sharing the record store shows (one line of at most 64 characters, an empty name clears it), add or update initiatives, place them in Now, Next, Later, or Parked, set required initiatives, record ship or supersede decisions, and set open questions. add_initiative and update_initiative take corrects ({ initiative, slices }) for a fix to shipped work: the entry names the shipped initiative and each of its recorded slices whose work it corrects, the roadmap Markdown shows it, and the shipped initiative's shippedHistory lists the entry under laterFixes; corrects refuses with validation_failed an initiative that has not shipped (fix its done work inside it with update_initiative report_defect), an unknown initiative, the entry's own id, an empty slices list, and a slice the shipped initiative's record does not hold. A shipped initiative's entry keeps its title, intent, requirements, and required initiatives: update_initiative and set_requires naming it refuse with initiative_shipped, with its initiative and shippedAt. Ship refuses an existing decision with validation_failed, then refuses with ship_unconfirmed an afterGate that is not a correctness gate of the initiative that the person answered approve in the review browser, then refuses with open_work, listing gates ({ id, slice, question, answered }), claims ({ slice, label, activity, expiresAt }), and proposals (scope slugs), while the initiative has a pending user gate, answered or not, other than the correctness gate that the ship names in afterGate, a live slice claim, or a pending design proposal. Ship then refuses with fixes_unfinished, listing fixes ({ slice, defect, fix, status }), while a defect reported on a done slice has no fix slice or its fix slice is not done. Ship then requires every leaf slice to be done, refusing with gate_blocked first; it then reads the ## Components declaration, refusing an invalid one with its own code, and refuses with dependents_blocked, listing each scope with its blocked dependents and reason failed or not_run, while a finished scope has dependents without a passing dependents' run of every one of them, or reason stale with run naming the dependents' run's record path while that latest run started before a leaf of the scope last passed verification, as when a fix slice changed the scope after it. With a record store, ship then refuses with adr_unlinked, listing adrs ({ path, scope, requirements }), while a Proposed ADR of the workspace scope or of a repository of the initiative names one of the initiative's requirement files in a Markdown link and no slice.md of the initiative, nor of any other plan, links it, since the ship would leave it Proposed. With a record store, ship takes afterGate, the id of a correctness gate of the initiative that the person answered approve in the review browser and that was asked after each leaf slice's latest passing verification run and while every slice.md of the initiative, the repositories its links resolve in, and every ADR that ship would accept read as they do at ship, and is refused with ship_unconfirmed without one, naming what changed after an earlier gate was asked; it is refused with adr_ambiguous, naming the path and the scopes and changing nothing, where a link could name ADRs at the same path in two or more scopes none of which holds its slice.md, and with adr_pending, naming each ADR and its gate and changing nothing, while a linked Proposed ADR has an open approval; it then sets each ADR whose recorded status is Proposed and that a Markdown link in any slice.md of the initiative names, as CommonMark reads it, to Accepted, a link in a slice's slice.md naming an ADR of the workspace scope or of that slice's own repository and its components, whichever checkout ships, rewriting its Status: line and recording acceptance with the gate and verifiedBy, the slice, repository, and commit of each leaf slice's latest passing verification run, which get_artifact returns, and the result lists them under acceptedAdrs with path, scope, and verifiedBy, while a cited ADR with another recorded status stays as it is, and the ship closes the correctness gate it names. readyToShip in get_roadmap is true only when ship would succeed, except that with a record store the newest pending correctness gate, which the ship then names in afterGate, and an open approval of a linked ADR leave it true, while every other pending gate, an older correctness gate included, is open work, with a diagnostic saying why otherwise; asking a correctness gate closes each earlier one that the person answered. Ship records each slice document of the initiative in its decision as documents ({ path, sha256 } of its content without the history mark), with documentsRecordedAt and documentsFrom ship, writes the history mark into each, and lists the marked paths under historyMarks and each document it could not read or write under historyMarkProblems ({ path, reason }) without failing; with a record store the marked documents are store artifacts that its sync shares, so they need no commit. A ship fetches origin and records in the decision slices, { <slug>: { repository, verified, shipped } } for each done leaf slice with a passing verification run, verified that run's head commit and shipped the oldest of the 1000 newest first-parent commits of origin's default branch, after those the verified commit was built on, whose tree holds every file the run recorded at its blob or at a later blob that a commit of a checkout ref descending from the verified commit gives it, as a squash merge of a branch whose later commits changed the file leaves it, or null, and the result lists the slugs whose shipped is null under noShipCommit. record_legacy_ship records an initiative that shipped before Prism kept records as shipped without the ship gate, only in the call that creates the roadmap record, as a migration from a legacy roadmap does, and refuses with validation_failed in any later call, for an initiative with an initiative record, and for one that already has a decision: its decision has legacy true, no slices, no gate, and no documents, so no slice document is marked, the roadmap Markdown says it shipped before Prism, and the result lists its id under legacyShips. Every write regenerates the roadmap Markdown without overwriting a hand-written file.",
    inputSchema: UPDATE_ROADMAP_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];
export {
  BANDS,
  DISPLAY_BANDS,
  GET_ROADMAP_SCHEMA,
  ROADMAP_STATES,
  ROADMAP_TOOLS,
  RoadmapError,
  UPDATE_ROADMAP_SCHEMA,
  WORKSPACE_NAME_MAX,
  dependentsBlockers,
  deriveInitiative,
  getRoadmap,
  mergeRoadmapRecord,
  readRoadmap,
  readStoreWorkspaceName,
  readWorkspaceName,
  roadmapComponents,
  roadmapViewOf,
  updateRoadmap
};
