// Run measures replay one execution's ordered run-statistics events, or every thread of a Codex session.
// Both functions are pure, so attribution replays the same events split by Prism target and role.

const RUN_MEASURES_IDLE_THRESHOLD_MS = 5 * 60 * 1000;

const COVERAGE_RANK = { exact: 3, approximate: 2, partial: 1, unavailable: 0 };
const TOKEN_KEYS = ["inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens"];
const SPAN_CLOSERS = new Set(["usage", "subagent_start", "subagent_stop", "session_end"]);
// Run boundaries carry no cost, so both replays skip them and existing rows and attribution keep their values.
const RUN_BOUNDARIES = new Set(["run_start", "run_end"]);
const RUN_QUIET_MS = 30 * 60 * 1000;
const RUN_MAX_QUIET_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_INTERVALS = 512;

function lowest(...coverages) {
  return coverages.reduce((current, next) => (COVERAGE_RANK[next] < COVERAGE_RANK[current] ? next : current), "exact");
}

function measure(value, coverage) {
  return coverage === "unavailable" || value === null
    ? { value: null, coverage: "unavailable" }
    : { value, coverage };
}

function time(event) {
  return Date.parse(event.occurredAt);
}

function costEvents(events) {
  return events.filter((event) => !RUN_BOUNDARIES.has(event.eventType));
}

function openToolSpan(events) {
  const open = new Set();
  for (const event of events) {
    if (!event.hashes.call) continue;
    if (event.eventType === "tool_start") open.add(event.hashes.call);
    if (event.eventType === "tool_end") open.delete(event.hashes.call);
  }
  return open.size > 0;
}

/**
 * Splits one run-statistics trace's ordered events into runs, each starting at a run_start.
 * Returns `[{ runId, events, closed }]`; events before the first run_start form a run with a null identifier.
 * `closed` is "sealed" (run_end), "ended" (a Claude session_end or subagent_stop of the trace's own execution),
 * "superseded" (a later run exists), "quiet" (at `at`, over 30 minutes after its last event with no tool running, or over
 * 24 hours), or null for an open run. A Codex session_end never closes a run, because it cannot prove every thread ended.
 */
export function splitRuns(events, { host, traceDigest = null, at = null } = {}) {
  const runs = [];
  let current = null;
  for (const event of events) {
    if (event.eventType === "run_start") {
      current = { runId: event.hashes.run ?? null, events: [event], closed: null };
      runs.push(current);
      continue;
    }
    if (current === null) {
      current = { runId: null, events: [], closed: null };
      runs.push(current);
    }
    current.events.push(event);
  }
  runs.forEach((run, index) => {
    const ownEnd = (event) => ["session_end", "subagent_stop"].includes(event.eventType) && event.hashes.execution === traceDigest;
    if (run.events.some((event) => event.eventType === "run_end")) run.closed = "sealed";
    else if (host === "claude-code" && traceDigest !== null && run.events.some(ownEnd)) run.closed = "ended";
    else if (index < runs.length - 1) run.closed = "superseded";
    else if (at !== null && run.events.length > 0) {
      const quiet = at - time(run.events.at(-1));
      if (quiet > RUN_MAX_QUIET_MS || (quiet > RUN_QUIET_MS && !openToolSpan(run.events))) run.closed = "quiet";
    }
  });
  return runs;
}

// Merges active intervals and keeps at most 512 by joining the closest neighbors, which makes the list approximate.
function mergeIntervals(intervals) {
  const merged = [];
  for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let coalesced = false;
  while (merged.length > MAX_ACTIVE_INTERVALS) {
    let closest = 0;
    for (let index = 1; index < merged.length - 1; index += 1) {
      if (merged[index + 1][0] - merged[index][1] < merged[closest + 1][0] - merged[closest][1]) closest = index;
    }
    merged.splice(closest, 2, [merged[closest][0], merged[closest + 1][1]]);
    coalesced = true;
  }
  return { intervals: merged, coalesced };
}

// Cumulative usage only grows, so the latest read has the most messages and then the largest total.
function laterUsage(left, right) {
  if (!left) return right;
  const count = (event) => event.counts.messageCount ?? 0;
  const total = (event) => TOKEN_KEYS.reduce((sum, key) => sum + (event.counts[key] ?? 0), 0);
  if (count(right) !== count(left)) return count(right) > count(left) ? right : left;
  return total(right) >= total(left) ? right : left;
}

// Token state of one thread: its latest usage and whether a later usage-unavailable gap leaves it cut short.
function threadTokens(events) {
  let latest = null;
  for (const event of events) {
    if (event.eventType === "usage") latest = laterUsage(latest, event);
  }
  const lastUsageIndex = events.findLastIndex((event) => event.eventType === "usage");
  const cutShort = events.some((event, index) => (
    event.eventType === "coverage_gap"
    && event.gapReason === "usage-unavailable"
    && index > lastUsageIndex
  ));
  return { latest, complete: latest !== null && !cutShort };
}

function toolSpans(events) {
  const starts = new Map();
  const ends = new Map();
  for (const event of events) {
    const call = event.hashes.call;
    if (!call) continue;
    if (event.eventType === "tool_start" && !starts.has(call)) starts.set(call, time(event));
    if (event.eventType === "tool_end" && !ends.has(call)) ends.set(call, time(event));
  }
  const spans = [];
  let unmatched = false;
  for (const [call, start] of starts) {
    if (ends.has(call)) {
      spans.push({ start, end: Math.max(start, ends.get(call)) });
      continue;
    }
    // A span without its end closes at the next usage, link, or end event of the execution.
    unmatched = true;
    const closer = events.find((event) => SPAN_CLOSERS.has(event.eventType) && time(event) > start);
    if (closer) spans.push({ start, end: time(closer) });
  }
  for (const call of ends.keys()) {
    if (!starts.has(call)) unmatched = true;
  }
  return { spans, unmatched, callCount: new Set([...starts.keys(), ...ends.keys()]).size };
}

// Each interval between consecutive events counts as active unless it exceeds the idle threshold with no tool running;
// `onActive` receives every active interval's start and length, so attribution splits the same decisions by segment.
function activeTime(events, spans, onActive = () => {}) {
  let total = 0;
  for (let index = 1; index < events.length; index += 1) {
    const from = time(events[index - 1]);
    const to = time(events[index]);
    const interval = Math.max(0, to - from);
    const toolRunning = spans.some((span) => span.start <= from && span.end >= to);
    if (interval <= RUN_MEASURES_IDLE_THRESHOLD_MS || toolRunning) {
      total += interval;
      onActive(from, interval);
    }
  }
  return total;
}

/**
 * Computes one row of run measures from ordered run-statistics events.
 * `host` is "claude-code" or "codex"; `ended` names the event type that ends the execution, or null when no end is provable.
 * A Codex row combines every thread of the session, keyed by each event's execution hash.
 */
export function summarizeRunMeasures(events, { host, ended = null, limitReached = false } = {}) {
  const ordered = costEvents(events).sort((left, right) => time(left) - time(right));
  const incomplete = limitReached || ordered.some((event) => (
    event.eventType === "coverage_gap" && event.gapReason !== "usage-unavailable"
  ));
  const ceiling = incomplete ? "partial" : "exact";
  const unavailableRow = (coverage) => ({
    firstObservedAt: null,
    lastObservedAt: null,
    ended: false,
    idleThresholdMs: RUN_MEASURES_IDLE_THRESHOLD_MS,
    wallTimeMs: measure(null, coverage),
    activeTimeMs: measure(null, coverage),
    ...Object.fromEntries(TOKEN_KEYS.map((key) => [key, measure(null, "unavailable")])),
    toolCalls: measure(null, coverage)
  });
  if (ordered.length === 0) return unavailableRow("unavailable");

  const first = time(ordered[0]);
  const last = time(ordered.at(-1));
  const { spans, unmatched, callCount } = toolSpans(ordered);

  const threads = new Map();
  for (const event of ordered) {
    const key = host === "codex" ? event.hashes.execution ?? "" : "";
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(event);
  }
  const tokenStates = [...threads.values()].map(threadTokens);
  const counted = tokenStates.filter((state) => state.latest !== null);
  const complete = tokenStates.filter((state) => state.complete);
  let tokenCoverage = complete.length === tokenStates.length
    ? "exact"
    : counted.length > 0 ? "partial" : "unavailable";
  tokenCoverage = lowest(tokenCoverage, ceiling);
  const tokens = Object.fromEntries(TOKEN_KEYS.map((key) => {
    if (host === "codex" && key === "cacheWriteTokens") return [key, measure(null, "unavailable")];
    if (counted.length === 0) return [key, measure(null, "unavailable")];
    const value = counted.reduce((sum, state) => sum + (state.latest.counts[key] ?? 0), 0);
    return [key, measure(value, tokenCoverage)];
  }));

  return {
    firstObservedAt: ordered[0].occurredAt,
    lastObservedAt: ordered.at(-1).occurredAt,
    ended: ended !== null && ordered.some((event) => event.eventType === ended),
    idleThresholdMs: RUN_MEASURES_IDLE_THRESHOLD_MS,
    wallTimeMs: measure(last - first, ceiling),
    activeTimeMs: measure(activeTime(ordered, spans), lowest(ceiling, unmatched ? "partial" : "exact")),
    ...tokens,
    toolCalls: measure(callCount, ceiling)
  };
}

const MEASURE_KEYS = ["wallTimeMs", "activeTimeMs", ...TOKEN_KEYS, "toolCalls"];
const DECLARING_ROLES = new Set(["coordinator", "delivery", "reviewer"]);

function sliceKey(call) {
  return `${call.initiative}\0${call.slice}`;
}

// Sums one measure over parts: an unavailable part keeps the known sum partial, and only all-unavailable parts are unavailable.
function sumMeasures(parts) {
  const known = parts.filter((part) => part.coverage !== "unavailable");
  if (known.length === 0) return measure(null, "unavailable");
  const coverage = lowest(...known.map((part) => part.coverage), known.length < parts.length ? "partial" : "exact");
  return measure(known.reduce((sum, part) => sum + part.value, 0), coverage);
}

function emptyAccumulator() {
  return { ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, 0])), intervals: [] };
}

// One segment per prism_call of an agent, opened at the call's tool_start, with its resolved role, target, and attribution;
// a prism_call without target facts adds a partial continuation segment.
function agentSegments(events, { root, codex }) {
  const starts = new Map();
  for (const event of events) {
    if (event.eventType === "tool_start" && event.hashes.call && !starts.has(event.hashes.call)) {
      starts.set(event.hashes.call, time(event));
    }
  }
  const boundaries = events
    .filter((event) => event.eventType === "prism_call" && Object.hasOwn(event, "prismCall"))
    .map((event) => ({ boundary: starts.get(event.hashes.call) ?? time(event), call: event.prismCall ?? null }));
  const calls = boundaries.filter(({ call }) => call !== null);

  // A slice-naming call interleaves with an earlier different slice that is still active, or with any earlier slice when
  // active slices are unknown or the earlier slice belongs to another initiative; initiative-only calls neither trigger nor join.
  const interleaved = new Set();
  const named = [];
  for (const { call } of calls) {
    if (!call.namesSlice) continue;
    for (const prior of named) {
      if (sliceKey(prior) === sliceKey(call)) continue;
      if (call.activeSlices === null || prior.initiative !== call.initiative || call.activeSlices.includes(prior.slice)) {
        interleaved.add(sliceKey(call));
        interleaved.add(sliceKey(prior));
      }
    }
    named.push(call);
  }

  const segments = calls.map(({ boundary, call }, index) => {
    const declared = (candidate) => DECLARING_ROLES.has(candidate.call.role) && sliceKey(candidate.call) === sliceKey(call);
    const earlier = calls.slice(0, index).findLast(declared);
    const later = calls.slice(index + 1).find(declared);
    let role = call.role;
    let attribution = "exact";
    if (!DECLARING_ROLES.has(role)) {
      role = earlier?.call.role ?? later?.call.role ?? null;
      if (role === null) {
        role = root ? "coordinator" : "delivery";
        attribution = "approximate";
      }
    }
    const base = { initiative: call.initiative, slice: call.slice };
    let target;
    if (call.facts === "partial") {
      target = { ...base, kind: "slice" };
      attribution = lowest(attribution, "partial");
    } else if (call.openWave && (role === "reviewer" || role === "coordinator")) {
      target = { ...base, kind: "wave", wave: call.openWave };
    } else if (call.designRun !== null) {
      target = { ...base, kind: "design-run", designRun: call.designRun };
    } else {
      target = { ...base, kind: "slice" };
    }
    if (call.namesSlice && interleaved.has(sliceKey(call))) attribution = lowest(attribution, "approximate");
    if (codex) attribution = lowest(attribution, "partial");
    return { boundary, target, role, attribution, projectRoot: call.projectRoot ?? null };
  }).sort((left, right) => left.boundary - right.boundary);

  // A call whose target could not be collected continues the agent's current target and role at partial attribution,
  // or leaves the following cost unattributed and partial before the agent's first segment.
  const gaps = boundaries.filter(({ call }) => call === null).map(({ boundary }) => {
    const current = segments[segmentIndexAt(segments, boundary)] ?? null;
    return current === null
      ? { boundary, target: null, role: null, attribution: "partial", projectRoot: null }
      : {
        boundary,
        target: current.target,
        role: current.role,
        attribution: lowest(current.attribution, "partial"),
        projectRoot: current.projectRoot
      };
  });
  return [...segments, ...gaps].sort((left, right) => left.boundary - right.boundary);
}

function segmentIndexAt(segments, at) {
  return segments.findLastIndex((segment) => segment.boundary <= at);
}

/**
 * Splits executions' wall time, active time, tokens, and tool calls by Prism target and role.
 * Each execution is `{ kind, digest, events, contextEvents, ceiling }`; a Codex execution holds every thread, replayed as one
 * agent per execution hash, whose root thread hashes to `sessionDigest`. Optional `contextEvents`, the execution's events
 * before `events`, only place segments, so the target current at the first counted event carries into it, and a target
 * whose segments all end by that event gets no entry.
 * Cost before an agent's first segment is unattributed, except that a Claude subagent inherits the root segment current at
 * its start link.
 * `counted`, when given, names the execution digests whose cost is returned; the others only provide context.
 * An item may instead be a replay `{ executions, counted }`, replayed with only its own executions as context and summed
 * into the same result, so each run keeps exactly the context it is replayed with.
 * Each target entry also carries the call's `projectRoot` (null for the hook's project) and its merged `activeIntervals`.
 */
export function attributeRunCost(executions, { host, sessionDigest = null, counted = null } = {}) {
  const isReplay = (item) => Array.isArray(item.executions);
  const replays = [{ executions: executions.filter((item) => !isReplay(item)), counted }, ...executions.filter(isReplay)];
  const codex = host === "codex";
  const entries = new Map();
  const unattributed = Object.fromEntries(MEASURE_KEYS.map((key) => [key, []]));

  const addPiece = (owner, accumulator, rowMeasures) => {
    const parts = owner === null || owner.target === null ? unattributed : (() => {
      const key = JSON.stringify([owner.projectRoot ?? null, owner.target, owner.role]);
      if (!entries.has(key)) {
        entries.set(key, {
          projectRoot: owner.projectRoot ?? null,
          target: owner.target,
          role: owner.role,
          attributions: [],
          intervals: [],
          parts: Object.fromEntries(MEASURE_KEYS.map((name) => [name, []]))
        });
      }
      const entry = entries.get(key);
      entry.attributions.push(owner.attribution);
      entry.intervals.push(...accumulator.intervals);
      return entry.parts;
    })();
    const attribution = owner === null ? (codex ? "partial" : "exact") : owner.attribution;
    for (const key of MEASURE_KEYS) {
      parts[key].push(measure(accumulator[key], lowest(rowMeasures[key].coverage, attribution)));
    }
  };

  for (const { executions, counted = null } of replays) {
    const rootExecution = executions.find((execution) => execution.kind === "root") ?? null;
    const ordered = [...executions].sort((left, right) => (left.kind === "root" ? 0 : 1) - (right.kind === "root" ? 0 : 1));
    let rootSegments = [];
    for (const execution of ordered) {
      const events = costEvents(execution.events ?? []).sort((left, right) => time(left) - time(right));
      const row = summarizeRunMeasures(events, { host, limitReached: (execution.ceiling ?? "exact") !== "exact" });
      const included = counted === null || counted.has(execution.digest);
      if (events.length === 0) {
        if (included) addPiece(null, emptyAccumulator(), row);
        continue;
      }
      const byAgent = (list) => {
        const grouped = new Map();
        for (const event of list) {
          const key = codex ? event.hashes.execution ?? "" : execution.digest;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(event);
        }
        return grouped;
      };
      const agents = byAgent(events);
      const context = byAgent(costEvents(execution.contextEvents ?? []));
      const seenCalls = new Set();
      for (const [agentKey, agentEvents] of agents) {
        const root = codex ? agentKey === sessionDigest : execution.kind === "root";
        const placed = [...(context.get(agentKey) ?? []), ...agentEvents].sort((left, right) => time(left) - time(right));
        const segments = agentSegments(placed, { root, codex });
        if (!codex && execution === rootExecution) rootSegments = segments;

        // A Claude subagent's cost before its own first Prism call belongs to the root segment current at its start link.
        let inherited = null;
        if (!codex && execution.kind !== "root") {
          const isLink = (event) => event.eventType === "subagent_start";
          const link = costEvents(rootExecution?.events ?? []).find((event) => isLink(event) && event.hashes.execution === execution.digest)
            ?? agentEvents.find(isLink);
          const index = link ? segmentIndexAt(rootSegments, time(link)) : -1;
          inherited = index === -1 ? null : rootSegments[index];
        }

        const accumulators = segments.map(emptyAccumulator);
        const before = emptyAccumulator();
        const at = (when) => {
          const index = segmentIndexAt(segments, when);
          return index === -1 ? before : accumulators[index];
        };
        const first = time(agentEvents[0]);
        const last = time(agentEvents.at(-1));
        before.wallTimeMs = Math.max(0, (segments[0]?.boundary ?? last) - first);
        segments.forEach((segment, index) => {
          accumulators[index].wallTimeMs = Math.max(0, (segments[index + 1]?.boundary ?? last) - Math.max(segment.boundary, first));
        });
        activeTime(agentEvents, toolSpans(agentEvents).spans, (from, interval) => {
          const accumulator = at(from);
          accumulator.activeTimeMs += interval;
          if (interval > 0) accumulator.intervals.push([from, from + interval]);
        });
        for (const event of agentEvents) {
          const call = event.hashes.call;
          if (!call || !["tool_start", "tool_end"].includes(event.eventType) || seenCalls.has(call)) continue;
          seenCalls.add(call);
          at(time(event)).toolCalls += 1;
        }
        // Token deltas between consecutive usage reads of the agent go to the segment containing each read's time.
        let previous = null;
        for (const event of agentEvents) {
          if (event.eventType !== "usage") continue;
          const current = laterUsage(previous, event);
          const accumulator = at(time(event));
          for (const key of TOKEN_KEYS) {
            accumulator[key] += (current.counts[key] ?? 0) - (previous?.counts[key] ?? 0);
          }
          previous = current;
        }

        if (!included) continue;
        // A piece holds no counted cost when context placed it before the agent's first counted event and a later segment
        // starts by then, so no counted event, active interval, token read, tool call, or wall time falls in it; such a piece
        // adds no target entry, while the unattributed bucket keeps its zero part.
        const current = segmentIndexAt(segments, first);
        const add = (owner, accumulator, index) => {
          const empty = index < current && segments[Math.max(index, 0)].boundary < first;
          if (!empty || owner?.target == null) addPiece(owner, accumulator, row);
        };
        add(inherited, before, -1);
        // A subagent whose before piece goes to the inherited target still observed its unattributed cost, which is zero.
        if (inherited?.target != null) addPiece(null, emptyAccumulator(), row);
        segments.forEach((segment, index) => add(segment, accumulators[index], index));
      }
    }
  }

  const targets = [...entries.values()].map((entry) => {
    const activeTimeMs = sumMeasures(entry.parts.activeTimeMs);
    const { intervals, coalesced } = mergeIntervals(entry.intervals);
    return {
      target: entry.target,
      role: entry.role,
      attribution: lowest(...entry.attributions),
      ...Object.fromEntries(MEASURE_KEYS.map((key) => [key, sumMeasures(entry.parts[key])])),
      projectRoot: entry.projectRoot,
      activeIntervals: measure(activeTimeMs.coverage === "unavailable" ? null : intervals, lowest(activeTimeMs.coverage, coalesced ? "approximate" : "exact"))
    };
  });
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  targets.sort((left, right) => compare(left.target.initiative, right.target.initiative)
    || compare(left.target.slice, right.target.slice)
    || compare(left.target.kind, right.target.kind)
    || compare(left.target.wave ?? "", right.target.wave ?? "")
    || (left.target.designRun ?? 0) - (right.target.designRun ?? 0)
    || compare(left.role, right.role)
    || compare(left.projectRoot ?? "", right.projectRoot ?? ""));
  return {
    targets,
    unattributed: Object.fromEntries(MEASURE_KEYS.map((key) => [key, sumMeasures(unattributed[key])]))
  };
}

const TOTAL_SUM_KEYS = [["summedActiveTimeMs", "activeTimeMs"], ...TOKEN_KEYS.map((key) => [key, key]), ["toolCalls", "toolCalls"]];

// The length of the union of intervals, without the 512-interval cap, so overlapping work counts once.
function unionLength(intervals) {
  let total = 0;
  let end = -Infinity;
  for (const [start, stop] of [...intervals].sort((left, right) => left[0] - right[0])) {
    if (stop <= end) continue;
    total += stop - Math.max(start, end);
    end = stop;
  }
  return total;
}

// A known value whose coverage is the lowest of the known parts, partial when any part is unavailable, and unavailable
// when no part is known.
function knownOf(value, coverages, missing) {
  if (coverages.length === 0) return measure(null, "unavailable");
  return measure(value, lowest(...coverages, missing ? "partial" : "exact"));
}

/**
 * Totals run-record segments read from shared run records.
 * Each part is `{ runId, segment, startedAt, endedAt }`, with the record's run times for a slice-level total, or without
 * the times for a wave or design-run total, whose wall time then spans its active-interval edges and is at best approximate.
 * A part `{ unavailable: true }` stands for an unreadable key or an invalid entry and lowers every measure's coverage.
 * Wall time is the calendar span of the parts, elapsed active time the union of their active intervals, and summed active
 * time, tokens, and tool calls add every segment's measure; with no parts, runs is 0 and exact and the rest unavailable.
 */
export function totalRunSegments(parts) {
  const segments = parts.filter((part) => !part.unavailable);
  const missing = segments.length < parts.length;
  const runIds = new Set(segments.map((part) => part.runId));
  const runs = parts.length === 0 ? measure(0, "exact") : knownOf(runIds.size, segments.length > 0 ? ["exact"] : [], missing);

  const starts = [];
  const ends = [];
  const wallCoverages = [];
  let wallMissing = missing;
  const intervals = [];
  const intervalCoverages = [];
  let intervalsMissing = missing;
  for (const { segment, startedAt, endedAt } of segments) {
    const known = segment.activeIntervals.coverage !== "unavailable";
    if (known) {
      intervals.push(...segment.activeIntervals.value);
      intervalCoverages.push(segment.activeIntervals.coverage);
    } else intervalsMissing = true;
    if (segment.wallTimeMs.coverage === "unavailable") wallMissing = true;
    else wallCoverages.push(segment.wallTimeMs.coverage);
    if (startedAt !== undefined && endedAt !== undefined) {
      starts.push(Date.parse(startedAt));
      ends.push(Date.parse(endedAt));
    } else if (known && segment.activeIntervals.value.length > 0) {
      starts.push(Math.min(...segment.activeIntervals.value.map((pair) => pair[0])));
      ends.push(Math.max(...segment.activeIntervals.value.map((pair) => pair[1])));
      wallCoverages.push(lowest(segment.activeIntervals.coverage, "approximate"));
    } else wallMissing = true;
  }
  const wallTimeMs = starts.length === 0
    ? measure(null, "unavailable")
    : knownOf(Math.max(...ends) - Math.min(...starts), wallCoverages, wallMissing);

  const placeholders = parts.filter((part) => part.unavailable).map(() => measure(null, "unavailable"));
  return {
    runs,
    wallTimeMs,
    elapsedActiveTimeMs: knownOf(unionLength(intervals), intervalCoverages, intervalsMissing),
    ...Object.fromEntries(TOTAL_SUM_KEYS.map(([name, key]) => [
      name,
      parts.length === 0 ? measure(null, "unavailable") : sumMeasures([...segments.map((part) => part.segment[key]), ...placeholders])
    ])),
    idleThresholdMs: RUN_MEASURES_IDLE_THRESHOLD_MS
  };
}
