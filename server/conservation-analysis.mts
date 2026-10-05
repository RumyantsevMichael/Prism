import path from "node:path";
import { readConceptDeltaDocument } from "./concept-delta.mjs";
import { conservationStore, ConservationStore, conservationError, digest, canonical, withinScope } from "./conservation-store.mjs";
import { nativeSemanticRuntime } from "./native-semantic-runtime.mjs";
import { CODE_EXTENSIONS } from "../native-runtime/domains.mjs";
import type { NativeSource, PreparedIndex, SemanticRuntime } from "./repository-concept-types.mjs";
import type { Evidence, SnapshotEvidence, SearchReceipt, Reference, Resolution, ResolvedUnit, DeltaDocument, ComparisonEvidence, Measurement, Observation } from "./conservation-types.mjs";

type Analysis = Extract<Evidence, { kind: "analysis" }>;
interface Options { store?: ConservationStore; runtime?: SemanticRuntime }
const keyFor = (file: string, kind: string, selector: string) => canonical([file, kind, selector]);
export const ANALYSIS_VERSION = "conservation-metrics-v2";
export const COMPARISON_VERSION = "conservation-comparison-v3";
export function parsedUnitsForReference(units: ResolvedUnit[], target: ResolvedUnit, match: "exact" | "contained" = "exact") {
  if (target.kind === "file") return [];
  const matches = units.filter(unit => unit.kind !== "file" && unit.file === target.file
    && (match === "exact" ? unit.start === target.start && unit.end === target.end : unit.start >= target.start && unit.end <= target.end));
  // A container reference identifies its outer units, not each nested parser unit as a separate concept.
  return match === "exact" ? matches : matches.filter(unit => !matches.some(parent => parent.start <= unit.start && parent.end >= unit.end && (parent.start !== unit.start || parent.end !== unit.end)));
}
export async function retainAnalysis(projectRoot: string, snapshotId: string, prepared: PreparedIndex, store = conservationStore) {
  const record: Analysis = { kind: "analysis", schemaVersion: 1, project: (await store.location(projectRoot)).root, snapshotId,
    units: prepared.index.units, fileCoverage: prepared.index.syntaxCoverage || prepared.index.fileCoverage,
    diagnostics: prepared.index.diagnostics, tokenCounts: prepared.index.tokenCounts || {}, structureCounts: prepared.index.structureCounts || {},
    versions: { extractor: prepared.index.chunkerVersion, graph: "1.6.0", model: prepared.modelIdentity, tokenizer: prepared.modelIdentity, spans: "utf16-offset-v1", metrics: ANALYSIS_VERSION } };
  const id = await store.put(projectRoot, record);
  await store.link(projectRoot, snapshotId, id);
  return record;
}
export async function prepareAnalysis(projectRoot: string, snapshotId: string, options: Options = {}) {
  const store = options.store || conservationStore, existing = await store.analysis(projectRoot, snapshotId);
  if (existing?.versions.extractor === "concepts-4-exact-fragments" && existing.versions.metrics === ANALYSIS_VERSION) return { status: "ready" as const, analysis: existing };
  const runtime = options.runtime || nativeSemanticRuntime, source = await store.source(projectRoot, snapshotId);
  const prepared = await runtime.prepare(source);
  if (prepared.status === "preparing") return { status: "preparing" as const, preparationId: prepared.preparationId };
  if (!prepared.prepared) return { status: "degraded" as const, diagnostics: prepared.diagnostics, analysis: null };
  return { status: "ready" as const, analysis: await retainAnalysis(projectRoot, snapshotId, prepared.prepared, store) };
}

export async function sourceUnits(projectRoot: string, snapshot: SnapshotEvidence, analysis: Analysis | null, store = conservationStore): Promise<ResolvedUnit[]> {
  const units: ResolvedUnit[] = [];
  for (const file of snapshot.files) {
    const bytes = await store.bytes(projectRoot, file), text = file.kind === "source" ? bytes.toString("utf8") : null;
    units.push({ key: keyFor(file.file, "file", ""), file: file.file, kind: "file", selector: "", start: 0, end: text?.length ?? file.bytes, hash: digest(canonical([file.hash, file.kind, file.mode, file.target])), public: null });
    if (text === null) continue;
    for (const unit of analysis?.units.filter(unit => unit.file === file.file && unit.kind !== "file") || []) {
      if (!unit.span) continue;
      if (unit.span.start < 0 || unit.span.end > text.length || unit.span.end <= unit.span.start) throw conservationError("evidence_missing", "A retained parser span is outside its source.", { file: file.file });
      const hash = digest(text.slice(unit.span.start, unit.span.end));
      if (unit.contentHash !== hash || unit.sourceHash !== file.hash) throw conservationError("evidence_missing", "A retained parser unit does not match its source.", { file: file.file });
      units.push({ key: keyFor(file.file, unit.kind, unit.selector || unit.name), file: file.file, kind: unit.kind, selector: unit.selector || unit.name,
        ...unit.span, hash, public: unit.isExported === true || unit.visibility === "public" ? true : unit.isExported === false || ["private", "protected", "internal"].includes(unit.visibility || "") ? false : null });
    }
  }
  return units;
}
export async function resolveReference(projectRoot: string, snapshot: SnapshotEvidence, reference: Reference, analysis: Analysis | null, store = conservationStore): Promise<Resolution> {
  const file = snapshot.files.find(file => file.file === reference.path);
  if (!file) return { status: snapshot.omissions.some(item => item.file === reference.path) ? "unsupported" : "missing", reference, units: [] };
  const all = (await sourceUnits(projectRoot, { ...snapshot, files: [file] }, analysis, store)), selector = reference.selector;
  if (selector === undefined) return { status: "resolved", reference, units: [all[0]] };
  if (typeof selector === "string") return { status: "unsupported", reference, units: [], reason: "Select a typed reference or supply an explicit manual check for the legacy selector." };
  if (file.kind !== "source") return { status: "unsupported", reference, units: [], reason: "The target has no text parser." };
  const text = (await store.bytes(projectRoot, file)).toString("utf8");
  let units: ResolvedUnit[];
  if (selector.type === "span") {
    if (selector.sourceHash !== file.hash || selector.end > text.length || selector.end <= selector.start) return { status: "unsupported", reference, units: [], reason: "The exact source span does not match this snapshot." };
    units = [{ key: keyFor(file.file, "span", `${selector.start}:${selector.end}`), file: file.file, kind: "span", selector: `${selector.start}:${selector.end}`, start: selector.start, end: selector.end, hash: digest(text.slice(selector.start, selector.end)), public: null }];
  } else if (selector.type === "text") {
    units = [];
    if (!selector.value) return { status: "missing", reference, units: [] };
    for (let offset = text.indexOf(selector.value); offset >= 0; offset = text.indexOf(selector.value, offset + 1)) units.push({ key: keyFor(file.file, "text", selector.value), file: file.file, kind: "text", selector: selector.value,
      start: offset, end: offset + selector.value.length, hash: digest(selector.value), public: null });
  } else {
    if (!analysis?.fileCoverage[file.file]) return { status: "unsupported", reference, units: [], reason: "The required structural extraction is unavailable." };
    const candidates = analysis.units.filter(unit => unit.file === file.file && (unit.selector === selector.value || unit.name === selector.value || unit.qualifiedName === selector.value)
      && (selector.type === "heading" ? unit.kind === "heading" : ["json-pointer", "yaml-key"].includes(selector.type) ? unit.kind === "configuration-key" : unit.domain === "code"));
    units = candidates.flatMap(candidate => all.filter(unit => unit.key === keyFor(candidate.file, candidate.kind, candidate.selector || candidate.name)));
    if (candidates.length && !units.length) return { status: "unsupported", reference, units: [], reason: "The parser did not preserve an exact source span." };
  }
  return { status: units.length === 1 ? "resolved" : units.length ? "ambiguous" : "missing", reference, units };
}

export async function assessDeltaReadiness(projectRoot: string, document: DeltaDocument, store = conservationStore) {
  const diagnostics: { code: string; message: string; id?: string; blocking?: boolean }[] = [];
  const add = (code: string, message: string, id?: string, blocking = true) => diagnostics.push({ code, message, ...(id ? { id } : {}), blocking });
  if (!document.baselineId) { add("baseline_missing", "Capture and bind the original source baseline."); return diagnostics; }
  let baseline: SnapshotEvidence;
  try { baseline = await store.get<SnapshotEvidence>(projectRoot, document.baselineId, "snapshot"); }
  catch { add("evidence_missing", "The retained baseline is missing or corrupt."); return diagnostics; }
  if (!baseline.complete && (baseline.unknownOmissions !== false || baseline.omissions.some(item => withinScope(item.file, document.scope)))) add("evidence_missing", "The source inventory is incomplete; capture all affected source before acceptance.");
  const analysis = await store.analysis(projectRoot, document.baselineId);
  if (document.concepts.length && !document.requirements?.length) add("requirements_missing", "Bind the governing requirement references.");
  for (const entry of document.concepts) {
    for (const reference of entry.before) {
      const resolved = await resolveReference(projectRoot, baseline, reference, analysis, store);
      if (resolved.status === "missing") add("baseline_reference_missing", "An existing concept is absent from the original baseline.", entry.id);
      else if (resolved.status !== "resolved") add("reference_review_required", "The baseline reference needs a typed selector or an explicit review check.", entry.id, false);
    }
    if (entry.action !== "ADD") continue;
    for (const reference of entry.after) {
      const existing = await resolveReference(projectRoot, baseline, reference, analysis, store);
      if (existing.status === "resolved" || existing.status === "ambiguous") add("addition_already_exists", "An ADD target already exists in the baseline; use MODIFY or REPLACE.", entry.id);
    }
    const evidence = entry.reuseEvidence;
    if (!evidence?.receiptIds?.length) { add("semantic_receipt_missing", "ADD requires a completed native semantic search against the original baseline.", entry.id); continue; }
    if (!entry.requirements?.length) add("addition_requirements_missing", "An addition needs requirement-linked justification.", entry.id);
    if (entry.requirements?.some(reference => !document.requirements?.some(bound => bound.path === reference.path && (bound.selector === undefined || canonical(bound) === canonical(reference))))) add("addition_requirements_unbound", "Addition requirements must belong to the governing requirement set.", entry.id);
    const known = new Set<string>();
    let count = 0;
    for (const receiptId of evidence.receiptIds) {
      let receipt: SearchReceipt;
      try { receipt = await store.get<SearchReceipt>(projectRoot, receiptId, "search"); }
      catch { add("evidence_missing", "An addition search receipt is missing or corrupt.", entry.id); continue; }
      if (receipt.snapshotId !== document.baselineId || receipt.status !== "ready" || !receipt.capabilities.semanticSearch || !receipt.modelIdentity || !receipt.indexRevision) add("semantic_receipt_invalid", "The addition receipt must contain native semantic results from the bound baseline.", entry.id);
      for (const candidate of receipt.candidates) {
        const key = `${receiptId}:${candidate.id}`; known.add(key); count++;
        const disposition = evidence.candidates.find(item => item.receiptId === receiptId && item.candidateId === candidate.id);
        const selector = disposition?.reference.selector;
        const matches = disposition?.reference.path === candidate.file && (candidate.span
          ? typeof selector === "object" && selector.type === "span" && selector.start === candidate.span.start && selector.end === candidate.span.end && selector.sourceHash === candidate.sourceHash
          : selector === (candidate.selector || candidate.name));
        if (!matches) add("candidate_disposition_missing", "Record each returned candidate with its exact receipt source reference.", entry.id);
      }
    }
    for (const candidate of evidence.candidates) if (!known.has(`${candidate.receiptId}:${candidate.candidateId}`)) add("candidate_not_in_receipt", "A disposition must identify a returned search candidate.", entry.id);
    if (!count && !evidence.emptyResultReason?.trim()) add("empty_search_explanation_missing", "Explain the empty semantic search result.", entry.id);
  }
  return diagnostics;
}

async function measurements(projectRoot: string, before: SnapshotEvidence, after: SnapshotEvidence, a: Analysis | null, b: Analysis | null, document: DeltaDocument, store: ConservationStore): Promise<Measurement[]> {
  const selected = (snapshot: SnapshotEvidence) => snapshot.files.filter(file => withinScope(file.file, document.scope));
  const left = selected(before), right = selected(after), values: Measurement[] = [];
  const add = (dimension: string, first: number | null, second: number | null, provenance: Measurement["provenance"] = "computed", reason?: string) => values.push({ dimension, before: first, after: second, increase: first === null || second === null ? null : second - first, provenance, ...(reason ? { reason } : {}) });
  add("source.files", left.length, right.length);
  add("source.bytes", left.reduce((sum, file) => sum + file.bytes, 0), right.reduce((sum, file) => sum + file.bytes, 0));
  const lines = async (files: typeof left, nonblank: boolean) => {
    let count = 0;
    for (const file of files) if (file.kind === "source") {
      const segments = (await store.bytes(projectRoot, file)).toString().match(/[^\n]*\n|[^\n]+$/g) || [];
      count += nonblank ? segments.filter(line => line.trim()).length : segments.length;
    }
    return count;
  };
  add("source.lines", await lines(left, false), await lines(right, false));
  add("source.nonblankLines", await lines(left, true), await lines(right, true));
  const codeCount = (files: typeof left, analysis: Analysis | null, kinds?: string[]) => {
    const code = files.filter(file => CODE_EXTENSIONS.has(path.extname(file.file).toLowerCase()));
    if (!code.length) return 0;
    if (!analysis || code.some(file => !analysis.fileCoverage[file.file])) return null;
    const units = analysis.units.filter(unit => code.some(file => file.file === unit.file) && (kinds ? kinds.includes(unit.kind) : !["file", "import", "parameter"].includes(unit.kind)));
    if (!kinds && units.some(unit => unit.isExported === undefined && unit.visibility === undefined)) return null;
    return kinds ? units.length : units.filter(unit => unit.isExported === true || unit.visibility === "public").length;
  };
  for (const [metric, kinds] of [["functions", ["function"]], ["methods", ["method"]], ["classes", ["class"]], ["interfaces", ["interface"]], ["types", ["type", "type_alias", "enum", "struct"]]] as [string, string[]][]) add(`code.${metric}`, codeCount(left, a, kinds), codeCount(right, b, kinds));
  add("code.publicDeclarations", codeCount(left, a), codeCount(right, b));
  const publicBefore = (await sourceUnits(projectRoot, before, a, store)).filter(unit => withinScope(unit.file, document.scope) && unit.public === true);
  const publicAfter = (await sourceUnits(projectRoot, after, b, store)).filter(unit => withinScope(unit.file, document.scope) && unit.public === true);
  add("code.publicDeclarationsAdded", 0, codeCount(left, a) === null || codeCount(right, b) === null ? null : publicAfter.filter(unit => !publicBefore.some(old => old.key === unit.key)).length);
  const structuredCount = (files: typeof left, analysis: Analysis | null, metric: string, extensions: string[]) => {
    const targets = files.filter(file => extensions.includes(path.extname(file.file).toLowerCase()));
    if (targets.some(file => !analysis?.fileCoverage[file.file] || analysis.structureCounts[file.file]?.[metric] === undefined)) return null;
    return targets.reduce((sum, file) => sum + (analysis?.structureCounts[file.file]?.[metric] || 0), 0);
  };
  for (const metric of ["sections", "paragraphs", "listItems", "links"]) add(`text.${metric}`, structuredCount(left, a, metric, [".md", ".markdown"]), structuredCount(right, b, metric, [".md", ".markdown"]));
  add("configuration.keys", structuredCount(left, a, "configurationKeys", [".json", ".jsonc", ".yaml", ".yml"]), structuredCount(right, b, "configurationKeys", [".json", ".jsonc", ".yaml", ".yml"]));
  add("configuration.references", structuredCount(left, a, "configurationReferences", [".json", ".jsonc", ".yaml", ".yml"]), structuredCount(right, b, "configurationReferences", [".json", ".jsonc", ".yaml", ".yml"]));
  const tokenCount = (files: typeof left, analysis: Analysis | null) => {
    const targets = files.filter(file => file.kind === "source" && !CODE_EXTENSIONS.has(path.extname(file.file).toLowerCase()));
    return targets.some(file => analysis?.tokenCounts[file.file] === undefined) ? null : targets.reduce((sum, file) => sum + analysis!.tokenCounts[file.file], 0);
  };
  add("text.tokens", tokenCount(left, a), tokenCount(right, b));
  for (const kind of ["rule", "exception", "prohibition", "example"]) {
    const count = async (snapshot: SnapshotEvidence, analysis: Analysis | null, side: "before" | "after") => {
      const refs = document.concepts.filter(entry => entry.kind === kind).flatMap(entry => entry[side]);
      const selected = new Set<string>();
      for (const ref of refs) { const result = await resolveReference(projectRoot, snapshot, ref, analysis, store); if (result.status !== "resolved") return null; selected.add(canonical(ref)); }
      return selected.size;
    };
    add(`identified.${kind}s`, await count(before, a, "before"), await count(after, b, "after"), "declared", "Counts cover explicitly identified obligations and need independent coverage review.");
  }
  for (const action of ["ADD", "DELETE"] as const) add(`planned.${action.toLowerCase()}`, 0, document.concepts.filter(entry => entry.action === action).length, "declared");
  add("planned.consolidations", 0, document.concepts.filter(entry => entry.action === "REPLACE" && entry.before.length > entry.after.length).length, "declared");
  add("planned.splits", 0, document.concepts.filter(entry => entry.action === "REPLACE" && entry.before.length < entry.after.length).length, "declared");
  return values;
}

export async function compareConceptDelta(input: { projectRoot: string; deltaPath: string; expectedRevision: string; baselineId: string; resultSnapshotId: string }, options: Options = {}) {
  const store = options.store || conservationStore;
  const loaded = await readConceptDeltaDocument(input.projectRoot, input.deltaPath, input.expectedRevision), document = loaded.document as DeltaDocument;
  if (document.schemaVersion !== 2 || document.baselineId !== input.baselineId) throw conservationError("validation_failed", "The comparison must use the delta's original baseline.");
  const before = await store.get<SnapshotEvidence>(input.projectRoot, input.baselineId, "snapshot"), after = await store.get<SnapshotEvidence>(input.projectRoot, input.resultSnapshotId, "snapshot");
  const preparedA = await prepareAnalysis(input.projectRoot, input.baselineId, options);
  if (preparedA.status === "preparing") return preparedA;
  const preparedB = input.baselineId === input.resultSnapshotId ? preparedA : await prepareAnalysis(input.projectRoot, input.resultSnapshotId, options);
  if (preparedB.status === "preparing") return preparedB;
  const a = preparedA.analysis || null, b = preparedB.analysis || null;
  if (a && b && canonical(a.versions) !== canonical(b.versions)) throw conservationError("evidence_missing", "Both measurements require the same parser and tokenizer versions.");
  const observations: Observation[] = [];
  const observe = (code: string, severity: Observation["severity"], message: string, fields: Partial<Observation> = {}) => {
    const record = { code, severity, message, ...fields };
    observations.push({ ...record, id: digest(canonical(record)) });
  };
  const excluded = after.exclusions.filter(file => !before.files.some(entry => entry.file === file));
  const left = (await sourceUnits(input.projectRoot, before, a, store)).filter(unit => !excluded.includes(unit.file)), right = (await sourceUnits(input.projectRoot, after, b, store)).filter(unit => !excluded.includes(unit.file));
  const sourceRefs: { id: string; side: "before" | "after"; action: string; unit: ResolvedUnit }[] = [];
  for (const entry of document.concepts) {
    const sides = { before: [] as Resolution[], after: [] as Resolution[] };
    for (const side of ["before", "after"] as const) for (const reference of entry[side]) {
      const resolved = await resolveReference(input.projectRoot, side === "before" ? before : after, reference, side === "before" ? a : b, store);
      sides[side].push(resolved);
      if (resolved.status !== "resolved") observe(resolved.status === "missing" ? "missing_target" : "reference_unknown", resolved.status === "missing" ? "failure" : "review_required", `The ${side} reference is ${resolved.status}.`, { file: reference.path, conceptId: entry.id, side });
      for (const unit of resolved.units) sourceRefs.push({ id: entry.id, side, action: entry.action, unit });
    }
    if (entry.action === "KEEP" && sides.before.every(item => item.status === "resolved") && sides.after.every(item => item.status === "resolved")
      && canonical(sides.before.flatMap(item => item.units.map(unit => [unit.hash, unit.public]))) !== canonical(sides.after.flatMap(item => item.units.map(unit => [unit.hash, unit.public])))) observe("keep_changed", "failure", "A KEEP target changed.", { conceptId: entry.id });
    if (entry.action === "MODIFY" && [...entry.before, ...entry.after].some(reference => typeof reference.selector === "object" && reference.selector.type === "span")) {
      const identities = (side: "before" | "after") => sides[side].flatMap(result => result.units.map(span => { const matches = parsedUnitsForReference(side === "before" ? left : right, span); return matches.length === 1 ? matches[0].key : undefined; }));
      const previous = identities("before"), current = identities("after");
      if (previous.length && current.length && previous.every(Boolean) && current.every(Boolean)) {
        if (canonical([...previous].sort()) !== canonical([...current].sort())) observe("modify_identity_changed", "failure", "A MODIFY span changes a known concept identity; use an explicit replacement or addition.", { conceptId: entry.id });
      } else observe("modify_identity_unknown", "review_required", "The parser cannot establish identity across these MODIFY spans; review the exact bound source.", { conceptId: entry.id });
    }
    if (entry.action === "ADD") for (const [index, reference] of entry.after.entries()) {
      const identities = sides.after[index].units.flatMap(unit => parsedUnitsForReference(right, unit, "contained"));
      const existing = await resolveReference(input.projectRoot, before, reference, a, store);
      if (identities.some(identity => left.some(unit => unit.key === identity.key)) || ["resolved", "ambiguous"].includes(existing.status)) observe("addition_already_exists", "failure", "An ADD target already exists in the baseline; use MODIFY or REPLACE.", { file: reference.path, conceptId: entry.id });
      else if (existing.status === "unsupported" && (!identities.length || before.files.some(file => file.file === reference.path) && !a?.fileCoverage[reference.path])) observe("addition_identity_unknown", "review_required", "The baseline identity of this ADD target needs an explicit review check.", { file: reference.path, conceptId: entry.id });
    }
    if (["DELETE", "REPLACE"].includes(entry.action)) for (const [index, reference] of entry.before.entries()) {
      if (entry.after.some(target => canonical(target) === canonical(reference))) continue;
      const destinations = entry.action === "REPLACE" ? sides.after.flatMap(result => result.units.flatMap(unit => parsedUnitsForReference(right, unit, "contained"))) : [];
      const originals = sides.before[index].units.flatMap(unit => parsedUnitsForReference(left, unit, "contained"));
      const identities = originals.filter(identity => !destinations.some(destination => destination.key === identity.key));
      if (originals.length && !identities.length) continue;
      if (identities.length) {
        const retained = right.find(unit => identities.some(identity => identity.key === unit.key));
        if (retained) { observe("retained_source", "failure", "A deletion or obsolete replacement identity remains, regardless of content changes.", { file: reference.path, conceptId: entry.id, unit: retained }); continue; }
        if (!after.files.some(file => file.file === reference.path) || b?.fileCoverage[reference.path]) continue;
      }
      let remaining = await resolveReference(input.projectRoot, after, reference, b, store);
      if (typeof reference.selector === "object" && reference.selector.type === "span" && remaining.status === "unsupported") {
        const original = before.files.find(file => file.file === reference.path);
        if (original?.kind === "source" && original.hash === reference.selector.sourceHash) {
          const text = (await store.bytes(input.projectRoot, original)).toString("utf8").slice(reference.selector.start, reference.selector.end);
          if (text) remaining = await resolveReference(input.projectRoot, after, { path: reference.path, selector: { type: "text", value: text } }, b, store);
        }
      }
      if (remaining.status === "resolved") observe("retained_source", "failure", "A deletion or obsolete replacement source remains.", { file: reference.path, conceptId: entry.id });
      else if (remaining.status !== "missing" || after.files.some(file => file.file === reference.path) && (identities.length || typeof reference.selector === "object" && reference.selector.type === "span")) observe("deletion_unknown", "review_required", "The source removal needs an explicit review check.", { file: reference.path, conceptId: entry.id });
    }
  }
  const changedPaths = new Set([...before.files, ...after.files].map(file => file.file).filter(file => !excluded.includes(file)
    && canonical(before.files.find(item => item.file === file)) !== canonical(after.files.find(item => item.file === file))));
  for (const file of changedPaths) {
    if (!withinScope(file, document.scope)) { observe("outside_scope", "failure", "A source change is outside the accepted scope.", { file }); continue; }
    const currentFile = after.files.find(item => item.file === file) || before.files.find(item => item.file === file)!;
    if (currentFile.kind !== "source" || (before.files.some(item => item.file === file) && !a?.fileCoverage[file]) || (after.files.some(item => item.file === file) && !b?.fileCoverage[file])) observe("structure_unknown", "review_required", "Structural coverage needs an explicit manual check.", { file });
    const changed = [...left.map(unit => ({ unit, side: "before" as const, other: right })), ...right.map(unit => ({ unit, side: "after" as const, other: left }))]
      .filter(({ unit, other }) => unit.file === file && !other.some(candidate => candidate.key === unit.key && candidate.hash === unit.hash && candidate.public === unit.public));
    for (const { unit, side, other } of changed) {
      const created = side === "after" && !other.some(candidate => candidate.key === unit.key && (unit.public !== true || candidate.public === true));
      const exact = sourceRefs.some(ref => ref.side === side && ref.unit.file === file && ref.unit.start === unit.start && ref.unit.end === unit.end
        && !(created && unit.public === true && ref.action === "MODIFY"));
      const covered = sourceRefs.some(ref => ref.side === side && ref.action !== "KEEP" && ref.unit.file === file && ref.unit.start <= unit.start && ref.unit.end >= unit.end);
      if (unit.kind === "file" && currentFile.kind === "source") continue;
      if (exact || (covered && !created)) continue;
      observe(created && unit.public === true ? "undeclared_public_concept" : "unclassified_unit", created && unit.public === true ? "failure" : "review_required",
        created && unit.public === true ? "A new public declaration requires an explicit concept transition." : "Attribute the changed unit to a planned concept or revise the plan.", { file, unit });
    }
    // Compare source outside changed parser units as well: parsed children never hide edits in gaps.
    const residual = async (snapshot: SnapshotEvidence, side: "before" | "after") => {
      const source = snapshot.files.find(item => item.file === file);
      if (!source || source.kind !== "source") return "";
      const text = (await store.bytes(input.projectRoot, source)).toString("utf8");
      const spans = [...changed.filter(item => item.side === side && item.unit.kind !== "file").map(item => item.unit), ...sourceRefs.filter(ref => ref.side === side && ref.unit.file === file && ref.action !== "KEEP").map(ref => ref.unit)].sort((x, y) => x.start - y.start);
      let result = "", end = 0;
      for (const span of spans) { if (span.start > end) result += text.slice(end, span.start); end = Math.max(end, span.end); }
      return result + text.slice(end);
    };
    if (await residual(before, "before") !== await residual(after, "after")) observe("unclassified_unit", "review_required", "Changed source outside parsed or planned spans needs an explicit attribution.", { file, unit: (right.find(unit => unit.file === file && unit.kind === "file") || left.find(unit => unit.file === file && unit.kind === "file")) });
    const original = before.files.find(item => item.file === file), final = after.files.find(item => item.file === file);
    if (original && final && (original.mode !== final.mode || original.kind !== final.kind) && !sourceRefs.some(ref => ref.unit.file === file && ref.unit.kind === "file" && ref.action !== "KEEP")) observe("unclassified_unit", "review_required", "Attribute the file kind or mode change to a planned concept.", { file, unit: right.find(unit => unit.file === file && unit.kind === "file") });
  }
  for (const snapshot of [before, after]) if (!snapshot.complete && (snapshot.unknownOmissions !== false || snapshot.omissions.some(item => withinScope(item.file, document.scope)))) observe("source_inventory_incomplete", "failure", "The affected source inventory is incomplete.");
  const measured = await measurements(input.projectRoot, before, after, a, b, document, store);
  for (const metric of measured.filter(item => item.increase === null)) observe("measurement_unknown", "review_required", `The ${metric.dimension} measurement is unsupported and needs a scoped review check.`);
  const growth = measured.filter(item => !item.dimension.startsWith("planned.") && item.increase !== null && item.increase > 0)
    .map(item => ({ id: digest(`${item.dimension}:${input.baselineId}:${input.resultSnapshotId}`), dimension: item.dimension, increase: item.increase!, threshold: document.growthThresholds?.find(rule => rule.dimension === item.dimension)?.maximumIncrease || 0 }));
  const requirements = [];
  const requiredReferences = [...new Map([...(document.requirements || []), ...document.concepts.flatMap(entry => entry.requirements || []), ...(document.growthJustifications || []).flatMap(item => item.requirements)].map(reference => [canonical(reference), reference])).values()];
  for (const reference of requiredReferences) {
    const result = await resolveReference(input.projectRoot, after, reference, b, store);
    requirements.push({ reference, hash: result.status === "resolved" ? result.units[0].hash : null });
    if (result.status === "missing") observe("requirement_missing", "failure", "A governing requirement is absent from the result.", { file: reference.path });
    else if (result.status !== "resolved") observe("requirement_unknown", "review_required", "The governing requirement needs an explicit review check.", { file: reference.path });
  }
  const evidence: ComparisonEvidence = { kind: "comparison", schemaVersion: 1, project: before.project, deltaPath: input.deltaPath, deltaRevision: input.expectedRevision,
    baselineId: input.baselineId, resultSnapshotId: input.resultSnapshotId, scope: document.scope, requirements,
    analysisIds: { before: a ? await store.put(input.projectRoot, a) : null, after: b ? await store.put(input.projectRoot, b) : null },
    versions: { ...(a?.versions || { metrics: ANALYSIS_VERSION, structure: "unavailable" }), comparison: COMPARISON_VERSION }, observations: [...new Map(observations.map(item => [item.id, item])).values()],
    measurements: measured, growth, units: { before: left.filter(unit => withinScope(unit.file, document.scope)), after: right.filter(unit => withinScope(unit.file, document.scope)) },
    diagnostics: [...before.diagnostics, ...after.diagnostics, ...(a?.diagnostics || []), ...(b?.diagnostics || [])] };
  const comparisonId = await store.put(input.projectRoot, evidence);
  return { status: "ready", comparisonId, baselineId: input.baselineId, resultSnapshotId: input.resultSnapshotId,
    observations: evidence.observations.slice(0, 50), totalObservations: evidence.observations.length, measurements: measured, growth, nextOffset: evidence.observations.length > 50 ? 50 : null };
}
