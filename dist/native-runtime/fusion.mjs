// Generated from src/native-runtime/fusion.mts by scripts/native-build/compile.mjs.
const IDENTIFIER = /[A-Za-z\d][_-][A-Za-z\d]|[a-z\d][A-Z]|\b[A-Z\d]{3,}\b|["'`]/;
const fusionWeights = (query) => ({ lexicalScore: IDENTIFIER.test(query) ? 0.5 : 0.25, cosineSimilarity: 1 });
const FUSION_OFFSET = 60;
export {
  FUSION_OFFSET,
  fusionWeights
};
