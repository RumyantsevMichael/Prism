// Run record builders shared by the run-totals tests; times are seconds after BASE.
export const BASE = Date.parse("2026-10-23T10:00:00.000Z");
export const SECOND = 1000;

// One record segment; times are seconds after BASE, and tokens are [input, cache-write, cache-read, output].
export function segment(target, { role, wall, from, to, tokens, tools }) {
  const exact = (value) => ({ value, coverage: "exact" });
  return {
    ...target,
    role,
    attribution: "exact",
    wallTimeMs: exact(wall * SECOND),
    activeTimeMs: exact((to - from) * SECOND),
    inputTokens: exact(tokens[0]),
    cacheWriteTokens: exact(tokens[1]),
    cacheReadTokens: exact(tokens[2]),
    outputTokens: exact(tokens[3]),
    toolCalls: exact(tools),
    activeIntervals: exact([[BASE + from * SECOND, BASE + to * SECOND]])
  };
}

// The run spans its active edges unless `span` gives its first and last event in seconds after BASE.
export function runRecord(runId, slice, segments, span = null) {
  const edges = span ? span.map((at) => BASE + at * SECOND) : segments.flatMap((part) => part.activeIntervals.value.flat());
  return {
    schemaVersion: 1,
    runId,
    host: "claude-code",
    initiative: "demo",
    slice,
    startedAt: new Date(Math.min(...edges)).toISOString(),
    endedAt: new Date(Math.max(...edges)).toISOString(),
    idleThresholdMs: 300000,
    segments
  };
}
