// The weights of reciprocal rank fusion, shared by the runtime that ranks one index and the server that ranks several together.
// Lexical matches on common words rank long files above precise semantic matches.
// Identifier-like queries keep more lexical weight, because rare exact tokens blur in dense vectors.
const IDENTIFIER = /[A-Za-z\d][_-][A-Za-z\d]|[a-z\d][A-Z]|\b[A-Z\d]{3,}\b|["'`]/;

/** The weight of each evidence for a query: lexical evidence weighs 0.5 for a query that looks like an identifier and 0.25 otherwise. */
export const fusionWeights = (query: string) => ({ lexicalScore: IDENTIFIER.test(query) ? 0.5 : 0.25, cosineSimilarity: 1 });

/** The offset of reciprocal rank fusion: a result at rank r adds weight / (FUSION_OFFSET + r). */
export const FUSION_OFFSET = 60;
