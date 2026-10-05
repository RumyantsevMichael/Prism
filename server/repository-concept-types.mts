export type Domain = "code" | "instruction" | "documentation" | "configuration";
export interface SourceRange { startLine: number; endLine: number }
export interface SourceFile { file: string; absolutePath: string; content: string; hash: string }
export interface SourceSnapshot { root: string; sourceFingerprint: string; commit: string; files: SourceFile[]; filesByPath: Map<string, SourceFile>; complete: boolean }
export interface Diagnostic { code: string; message: string; file?: string; count?: number; denied?: { path: string; write: boolean }[]; recovery?: string }
export interface Concept { id: string; file: string; kind: string; name: string; selector?: string; domain?: Domain; range: SourceRange; sourceHash?: string; rangeComplete: boolean; qualifiedName?: string; signature?: string; docstring?: string; depth?: number; span?: { start: number; end: number }; contentHash?: string; isExported?: boolean; visibility?: string }
export interface Relationship { source: string; target: string; kind: string; provenance?: string; line?: number; column?: number; metadata?: Record<string, unknown> }
export interface Fragment extends Concept { parentId: string; sourceStart: number; sourceEnd: number; prefixLength: number; text: string; embeddingKey?: string; embedding?: number[] }
export interface SearchResult extends Concept { parentId?: string; sourceStart?: number; sourceEnd?: number; fusedScore?: number; fusedRank: number; lexicalScore: number | null; cosineSimilarity: number | null; excerpt: string }
export interface SearchFilters { domains?: Domain[]; paths?: string[]; kinds?: string[] }
export interface Counts { files: number; concepts: number; fragments: number; reusedEmbeddings: number; newEmbeddings: number }
export interface IndexMetadata { schemaVersion: 1; chunkerVersion: string; modelIdentity: string; snapshot: string; units: Concept[]; edges: Relationship[]; fileCoverage: Record<string, boolean>; syntaxCoverage?: Record<string, boolean>; diagnostics: Diagnostic[]; counts: Counts; structureComplete: boolean; assetIdentity?: string; tokenCounts?: Record<string, number>; structureCounts?: Record<string, Record<string, number>>; resources: { rssBytes: number; peakRssBytes: number; indexMilliseconds?: number } }
export interface ConceptIndex extends IndexMetadata { chunks: Fragment[] }
export interface RuntimeAssets { runtime: string; modelDirectory: string; modelIdentity: string; assetIdentity: string }
export interface PreparedIndex extends RuntimeAssets { index: IndexMetadata; indexPath: string; revision: string }
export interface Preparation { status: "preparing" | "ready" | "degraded"; preparationId: string; snapshot: string; diagnostics: Diagnostic[]; prepared?: PreparedIndex }
export interface Progress { phase: string; current?: number; total?: number; file?: string }
export interface BuildArguments { mirror: string; files: Pick<SourceFile, "file" | "hash">[]; snapshot: string; modelDirectory: string; modelIdentity: string; previousEmbeddings?: Record<string, number[]> }
export interface SearchArguments { query: string; filters?: SearchFilters; limit: number; mode?: "lexical"; snapshot: string; modelDirectory: string; modelIdentity: string; indexPath: string }
export type WorkerRequest = { id: number; method: "build"; args: BuildArguments } | { id: number; method: "search"; args: SearchArguments };
export interface WorkerMethods { build: { input: BuildArguments; output: ConceptIndex }; search: { input: SearchArguments; output: SearchResult[] } }
export interface SearchHints { files?: string[]; symbols?: string[]; concepts?: string[]; expectedModifiedFiles?: string[] }
export interface SearchHit { node: Concept; score: number; reasons: string[]; retrievalScores?: Pick<SearchResult, "cosineSimilarity" | "lexicalScore" | "fusedRank"> }
export interface RetrievalEvidence { hits: SearchHit[]; retrievalCoverage: number | null; unresolvedConcepts: string[]; unresolvedRequired: { kind: string; value: string }[]; requiredEvidenceComplete: boolean; estimateEligible: boolean; diagnostics: Diagnostic[]; retrievalPlan: unknown }
export interface Neighbor { node: Concept; from?: string; relationship: string; score: number; provenance?: string }
export interface StructuralEvidence { neighbors: Neighbor[]; graphCoverage: number | null; estimateEligible: boolean; diagnostics: Diagnostic[] }
export interface ProviderDescription { name: string; commit: string; sourceFingerprint: string; snapshotIdentity: { scheme: string; commit: string; fingerprint: string }; capabilities: Record<string, boolean> }
export interface NativeSource {
  snapshot(): Promise<SourceSnapshot>;
  describe(): Promise<ProviderDescription>;
  search(task: string, hints?: SearchHints, options?: { topK?: number; budget?: string; filters?: SearchFilters }): Promise<RetrievalEvidence>;
  neighbors(): Promise<StructuralEvidence>;
  read(range: { file: string; range: SourceRange }): Promise<{ content: string; rendered: string; range: SourceRange; rangeComplete: boolean }>;
  validateSourceRange(range: { file: string; range: SourceRange }): Promise<{ file: string; range: SourceRange }>;
  verifySnapshot(): Promise<unknown>;
}
export interface SemanticRuntime {
  prepare(source: NativeSource, expectedSnapshot?: string, waitMs?: number): Promise<Preparation>;
  search(prepared: PreparedIndex, source: NativeSource, query: string, filters: SearchFilters | undefined, limit: number): Promise<SearchResult[]>;
}
