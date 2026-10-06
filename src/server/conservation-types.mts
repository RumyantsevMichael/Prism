import type { Concept, Diagnostic } from "./repository-concept-types.mjs";

export type Selector = string | { type: "symbol" | "heading" | "text" | "json-pointer" | "yaml-key"; value: string }
  | { type: "span"; start: number; end: number; sourceHash: string };
export interface Reference { path: string; selector?: Selector }
export interface InventoryEntry { file: string; kind: "source" | "opaque" | "symlink"; hash: string; bytes: number; mode: number; target?: string }
export interface SnapshotEvidence {
  kind: "snapshot"; schemaVersion: 1; project: string; commit: string; fingerprint: string; capturePolicy: "conservation-source-v1";
  files: InventoryEntry[]; exclusions: string[]; omissions: { file: string; reason: string }[]; complete: boolean; unknownOmissions?: boolean; diagnostics: Diagnostic[];
}
export interface SearchReceipt {
  kind: "search"; schemaVersion: 1; project: string; snapshotId: string | null; snapshot: string; query: string;
  filters: unknown; limit: number; status: string; capabilities: Record<string, boolean>; modelIdentity: string | null;
  indexRevision: string | null; versions: Record<string, string>; coverage: unknown; diagnostics: Diagnostic[];
  candidates: (Concept & { excerpt: string; cosineSimilarity: number | null; lexicalScore: number | null; fusedRank: number })[];
}
export interface GrowthJustification { dimensions: string[]; conceptIds: string[]; requirements: Reference[]; reason: string }
export interface AdditionEvidence {
  method?: string; receiptIds?: string[]; candidates: { reference: Reference; candidateId?: string; receiptId?: string; disposition: "REUSE" | "REJECT" | "PARTIAL"; reason: string }[];
  justification: string; emptyResultReason?: string;
}
export interface DeltaEntry {
  id: string; kind: string; label: string; action: "KEEP" | "MODIFY" | "REPLACE" | "DELETE" | "ADD";
  before: Reference[]; after: Reference[]; reason: string; requirements?: Reference[]; reuseEvidence?: AdditionEvidence;
}
export interface DeltaDocument {
  schemaVersion: 1 | 2; scope: string[]; concepts: DeltaEntry[]; baselineId?: string;
  requirements?: Reference[]; growthJustifications?: GrowthJustification[];
  growthThresholds?: { dimension: string; maximumIncrease: number }[];
  expectedGrowth?: { dimension: string; increase: number | null; reason: string }[];
}
export interface ResolvedUnit { key: string; file: string; kind: string; selector: string; start: number; end: number; hash: string; public: boolean | null }
export interface Resolution { status: "resolved" | "missing" | "ambiguous" | "unsupported"; reference: Reference; units: ResolvedUnit[]; reason?: string }
export interface Measurement { dimension: string; before: number | null; after: number | null; increase: number | null; provenance: "computed" | "declared"; reason?: string }
export interface Observation { id: string; code: string; severity: "failure" | "review_required"; file?: string; conceptId?: string; side?: "before" | "after"; unit?: ResolvedUnit; message: string }
export interface ComparisonEvidence {
  kind: "comparison"; schemaVersion: 1; project: string; deltaPath: string; deltaRevision: string; baselineId: string; resultSnapshotId: string;
  scope: string[]; requirements: { reference: Reference; hash: string | null }[]; versions: Record<string, string>;
  analysisIds: { before: string | null; after: string | null };
  observations: Observation[]; measurements: Measurement[]; growth: { id: string; dimension: string; increase: number; threshold: number }[];
  units: { before: ResolvedUnit[]; after: ResolvedUnit[] }; diagnostics: Diagnostic[];
}
export type Evidence = SnapshotEvidence | SearchReceipt | ComparisonEvidence | { kind: "migration"; schemaVersion: 1; project: string; artifactPath: string; revision: string; lines: string[] } | { kind: "analysis"; schemaVersion: 1; project: string; snapshotId: string; units: Concept[]; fileCoverage: Record<string, boolean>; diagnostics: Diagnostic[]; tokenCounts: Record<string, number>; structureCounts: Record<string, Record<string, number>>; versions: Record<string, string> };
