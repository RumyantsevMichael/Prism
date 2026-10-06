// Generated from src/server/conservation/conservation-tools.mts by scripts/native-build/compile.mjs.
import { assertInput } from "../workflow/artifact-schema.mjs";
import { conservationStore, conservationError } from "./conservation-store.mjs";
import { compareConceptDelta } from "./conservation-analysis.mjs";
import { GET_REVIEW_SCHEMA, UPDATE_REVIEW_SCHEMA, CHECK_REVIEW_GATE_SCHEMA, getReview, updateReview, checkReviewGate } from "../review/review-ledger.mjs";
import { objectSchema as obj, textField as str, hashField } from "./conservation-schema.mjs";
const captureSchema = obj({ projectRoot: str, deltaPath: str }, ["projectRoot"]);
const evidenceSchema = obj({ projectRoot: str, evidenceId: hashField, section: { enum: ["files", "omissions", "diagnostics", "candidates", "observations", "measurements", "growth", "unitsBefore", "unitsAfter", "units", "requirements", "lines"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["projectRoot", "evidenceId"]);
const compareSchema = obj({ projectRoot: str, deltaPath: str, expectedRevision: hashField, baselineId: hashField, resultSnapshotId: hashField });
const annotations = (readOnlyHint, openWorldHint = false) => ({ readOnlyHint, destructiveHint: false, idempotentHint: readOnlyHint, openWorldHint });
const CONSERVATION_TOOLS = [
  { name: "capture_repository_snapshot", description: "Retain immutable source evidence before edits, including dirty, untracked, opaque and symlink identities. Pass deltaPath to register exact slice evidence outputs before creating them. Returns the baseline or result snapshot identity.", inputSchema: captureSchema, annotations: annotations(false) },
  { name: "get_conservation_evidence", description: "Read an immutable snapshot, search receipt, comparison, or analysis in bounded pages. Evidence IDs bind every page without revision drift.", inputSchema: evidenceSchema, annotations: annotations(true) },
  { name: "compare_concept_delta", description: "Compare an exact concept plan with retained B and A/F snapshots. Prepare native extraction automatically and retain immutable observed facts and measurements. Similarity never proves equivalence.", inputSchema: compareSchema, annotations: annotations(false, true) },
  { name: "get_review", description: "Read the authoritative MCP review ledger and report stale Markdown projections. Page findings, waves, assessments, conflicts, migration history or operation history.", inputSchema: GET_REVIEW_SCHEMA, annotations: annotations(true) },
  { name: "update_review", description: "Apply typed revision-checked review operations. Enforce finding ownership, independent verification, lane evidence and acceptance prerequisites. JSON commits survive Markdown projection failures.", inputSchema: UPDATE_REVIEW_SCHEMA, annotations: annotations(false) },
  { name: "check_review_gate", description: "Explain current implementation-entry or completion prerequisites using the same validator as review acceptance and coordination mutations. Verifies live source against accepted evidence.", inputSchema: CHECK_REVIEW_GATE_SCHEMA, annotations: annotations(false) }
];
async function callConservationTool(name, input) {
  const tool = CONSERVATION_TOOLS.find((tool2) => tool2.name === name);
  if (!tool) throw conservationError("validation_failed", "Unknown conservation tool.");
  assertInput(tool.inputSchema, input);
  if (name === "get_review") return getReview(input);
  if (name === "update_review") return updateReview(input);
  if (name === "check_review_gate") return checkReviewGate(input);
  if (name === "compare_concept_delta") return compareConceptDelta(input);
  const projectRoot = input.projectRoot;
  if (name === "capture_repository_snapshot") {
    const { snapshotId, snapshot } = await conservationStore.capture(projectRoot, input.deltaPath);
    return {
      snapshotId,
      fingerprint: snapshot.fingerprint,
      commit: snapshot.commit,
      capturePolicy: snapshot.capturePolicy,
      complete: snapshot.complete,
      counts: { files: snapshot.files.length, bytes: snapshot.files.reduce((sum, file) => sum + file.bytes, 0), omissions: snapshot.omissions.length },
      diagnostics: snapshot.diagnostics.slice(0, 20),
      totalDiagnostics: snapshot.diagnostics.length
    };
  }
  const evidence = await conservationStore.get(projectRoot, input.evidenceId);
  const section = input.section || { snapshot: "files", search: "candidates", comparison: "observations", analysis: "units", migration: "lines" }[evidence.kind];
  const record = evidence;
  const values = section === "unitsBefore" || section === "unitsAfter" ? record.units?.[section === "unitsBefore" ? "before" : "after"] : record[section];
  if (!Array.isArray(values)) throw conservationError("validation_failed", "The requested section is not present in this evidence kind.");
  const offset = input.offset || 0, limit = input.limit || 50;
  const metadata = Object.fromEntries(Object.entries(record).filter(([key, value]) => !Array.isArray(value) && !["units", "fileCoverage", "tokenCounts", "structureCounts", "project"].includes(key)));
  return { evidenceId: input.evidenceId, ...metadata, section, entries: values.slice(offset, offset + limit), totalCount: values.length, nextOffset: offset + limit < values.length ? offset + limit : null };
}
export {
  CONSERVATION_TOOLS,
  callConservationTool
};
