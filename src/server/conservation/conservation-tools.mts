import { assertInput } from "../workflow/artifact-schema.mjs";
import { conservationStore, conservationError } from "./conservation-store.mjs";
import { compareChangeMap } from "./conservation-analysis.mjs";
import { GET_REVIEW_SCHEMA, UPDATE_REVIEW_SCHEMA, CHECK_REVIEW_GATE_SCHEMA, getReview, updateReview, checkReviewGate } from "../review/review-ledger.mjs";
import { objectSchema as obj, textField as str, hashField } from "./conservation-schema.mjs";
const captureSchema = obj({ projectRoot: str, deltaPath: str }, ["projectRoot"]);
const evidenceSchema = obj({ projectRoot: str, evidenceId: hashField, section: { enum: ["files", "omissions", "diagnostics", "candidates", "observations", "measurements", "growth", "unitsBefore", "unitsAfter", "units", "requirements", "lines", "groups", "modules", "delegatingClasses", "containers", "shapes"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["projectRoot", "evidenceId"]);
const compareSchema = obj({ projectRoot: str, deltaPath: str, expectedRevision: hashField, baselineId: hashField, resultSnapshotId: hashField });
const annotations = (readOnlyHint: boolean, openWorldHint = false) => ({ readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint });
export const CONSERVATION_TOOLS = [
  { name: "capture_repository_snapshot", description: "Retain immutable source evidence before edits, including dirty, untracked, opaque and symlink identities. Pass deltaPath to register exact slice evidence outputs before creating them. Returns the baseline or result snapshot identity.", inputSchema: captureSchema, annotations: annotations(false) },
  { name: "get_conservation_evidence", description: "Read an immutable snapshot, search receipt, repository analysis receipt, comparison, or analysis in bounded pages. Evidence IDs bind every page without revision drift.", inputSchema: evidenceSchema, annotations: annotations(true) },
  { name: "compare_change_map", description: "Compare an exact change map revision with retained B and A/F snapshots. Prepare native extraction automatically and retain immutable observed facts and measurements. Similarity never proves equivalence.", inputSchema: compareSchema, annotations: annotations(false, true) },
  { name: "get_review", description: "Read the authoritative MCP review ledger and report stale Markdown projections. Page findings, waves, assessments, conflicts, migration history or operation history.", inputSchema: GET_REVIEW_SCHEMA, annotations: annotations(true) },
  { name: "update_review", description: "Apply typed revision-checked review operations. Enforce finding ownership, independent verification, lane evidence and acceptance prerequisites. JSON commits survive Markdown projection failures.", inputSchema: UPDATE_REVIEW_SCHEMA, annotations: annotations(false) },
  { name: "check_review_gate", description: "Explain current implementation-entry or completion prerequisites using the same validator as review acceptance and coordination mutations. Verifies live source against accepted evidence. For an unaccepted wave, lists the files each lane must re-review since the previous wave of its mode, assessments that carry_assessments can reuse, and a ready-to-fill assessment skeleton.", inputSchema: CHECK_REVIEW_GATE_SCHEMA, annotations: annotations(false) }
];
export async function callConservationTool(name: string, input: Record<string, unknown>) {
  const tool = CONSERVATION_TOOLS.find(tool => tool.name === name);
  if (!tool) throw conservationError("validation_failed", "Unknown conservation tool.");
  assertInput(tool.inputSchema, input);
  if (name === "get_review") return getReview(input as unknown as Parameters<typeof getReview>[0]);
  if (name === "update_review") return updateReview(input as unknown as Parameters<typeof updateReview>[0]);
  if (name === "check_review_gate") return checkReviewGate(input as unknown as Parameters<typeof checkReviewGate>[0]);
  if (name === "compare_change_map") return compareChangeMap(input as unknown as Parameters<typeof compareChangeMap>[0]);
  const projectRoot = input.projectRoot as string;
  if (name === "capture_repository_snapshot") {
    const { snapshotId, snapshot } = await conservationStore.capture(projectRoot, input.deltaPath as string | undefined);
    return { snapshotId, fingerprint: snapshot.fingerprint, commit: snapshot.commit, capturePolicy: snapshot.capturePolicy, complete: snapshot.complete,
      counts: { files: snapshot.files.length, bytes: snapshot.files.reduce((sum, file) => sum + file.bytes, 0), omissions: snapshot.omissions.length }, diagnostics: snapshot.diagnostics.slice(0, 20), totalDiagnostics: snapshot.diagnostics.length };
  }
  const evidence = await conservationStore.get(projectRoot, input.evidenceId as string);
  const results = evidence.kind === "repository-analysis" ? ({ report_module_interfaces: "modules", report_cohesion_clusters: "containers", report_complex_units: "units" } as Record<string, string>)[evidence.tool] || "groups" : undefined;
  const section = (input.section || ({ snapshot: "files", search: "candidates", comparison: "observations", analysis: "units", migration: "lines", "repository-analysis": results } as Record<string, string | undefined>)[evidence.kind]) as string;
  const record = evidence as unknown as Record<string, unknown>;
  const values = section === "unitsBefore" || section === "unitsAfter" ? (record.units as Record<string, unknown> | undefined)?.[section === "unitsBefore" ? "before" : "after"] : record[section];
  if (!Array.isArray(values)) {
    const sections = [...Object.keys(record).filter(key => Array.isArray(record[key])), ...(record.units && !Array.isArray(record.units) ? ["unitsBefore", "unitsAfter"] : [])];
    throw conservationError("validation_failed", `The ${evidence.kind} evidence has no section ${section}. Its sections are ${sections.join(", ") || "none"}.`);
  }
  const offset = input.offset as number || 0, limit = input.limit as number || 50;
  const metadata = Object.fromEntries(Object.entries(record).filter(([key, value]) => !Array.isArray(value) && !["units", "fileCoverage", "tokenCounts", "structureCounts", "project"].includes(key)));
  return { evidenceId: input.evidenceId, ...metadata, section, entries: values.slice(offset, offset + limit), totalCount: values.length, nextOffset: offset + limit < values.length ? offset + limit : null };
}
