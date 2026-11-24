// Generated from src/server/workflow/gate-askers.mts by scripts/native-build/compile.mjs.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readWorkspaceIdentity, workspaceLabel, hostLabel } from "../review/workspace-identity.mjs";
import { readRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { parseStoreJson } from "./store-json.mjs";
const ASKER_FIELDS = ["harness", "machine", "checkout", "cloud", "launched", "askedAt"];
const SCHEMA_VERSION = 1;
const HARNESS_LIMIT = 64;
const DEFAULT_HOLD_MS = 15 * 60 * 1e3;
const targetOf = (key) => key.initiative === void 0 ? `approval:${key.gate}` : `gate:${key.initiative}/${key.gate}`;
const recordKey = (key) => key.initiative === void 0 ? { kind: "asker", gate: key.gate } : { kind: "asker", initiative: key.initiative, gate: key.gate };
const askerCall = new AsyncLocalStorage();
const withGateAsker = (context, run) => askerCall.run(context, run);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value ? value : null;
function holdLeaseMs(env = process.env) {
  const value = String(env.PRISM_GATE_HOLD_MS ?? "").trim();
  return /^\d+$/.test(value) && Number(value) >= 1e3 && Number(value) <= 36e5 ? Number(value) : DEFAULT_HOLD_MS;
}
async function readShared(projectRoot, key) {
  try {
    const { bytes } = await readRecord(projectRoot, recordKey(key));
    if (bytes === null) return null;
    const value = parseStoreJson(bytes);
    return isRecord(value) && value.schemaVersion === SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}
function liveHolds(record, now = Date.now()) {
  if (!isRecord(record?.holds)) return {};
  return Object.fromEntries(Object.entries(record.holds).filter(([, hold]) => isRecord(hold) && typeof hold.until === "string" && Date.parse(hold.until) > now));
}
async function readGateAsker(projectRoot, key, now = Date.now()) {
  const record = await readShared(projectRoot, key);
  const known = typeof record?.askedAt === "string" && typeof record.machine === "string";
  return {
    known,
    harness: known ? text(record.harness)?.slice(0, HARNESS_LIMIT) ?? null : null,
    machine: known ? text(record.machine) : null,
    checkout: known ? text(record.checkout) : null,
    cloud: known && isRecord(record.cloud) && typeof record.cloud.id === "string",
    // The cloud session's cse id, which a wake names; the shared record keeps it as the only session id it holds.
    cloudSession: known && isRecord(record.cloud) && typeof record.cloud.id === "string" ? record.cloud.id : null,
    launched: known && record.launched === true,
    askedAt: known ? record.askedAt : null,
    held: Object.values(liveHolds(record, now)).length > 0
  };
}
async function recordGateAskers(projectRoot, keys) {
  const context = askerCall.getStore();
  if (!context || !keys.length) return;
  try {
    const checkout = workspaceLabel(await readWorkspaceIdentity(projectRoot));
    const askedAt = (/* @__PURE__ */ new Date()).toISOString();
    const shared = { harness: context.harness, machine: hostLabel(), checkout, cloud: context.cloud ? { kind: context.cloud.kind, id: context.cloud.id } : null, launched: context.launch !== null, askedAt };
    for (const key of keys) {
      await withRecordLock(projectRoot, recordKey(key), async () => {
        const previous = await readShared(projectRoot, key);
        await writeRecord(projectRoot, recordKey(key), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...shared, holds: liveHolds(previous) }, null, 2)}
`);
      });
    }
    const { keepAskerSessions } = await import("../session/asker-sessions.mjs");
    const sessionId = context.host === "claude-code" || context.host === "codex" ? context.sessionId : null;
    const byInitiative = /* @__PURE__ */ new Map();
    for (const key of keys) {
      const initiative = key.initiative ?? (typeof key.named === "string" ? key.named : null);
      byInitiative.set(initiative, [...byInitiative.get(initiative) ?? [], targetOf(key)]);
    }
    for (const [initiative, targets] of byInitiative) await keepAskerSessions(targets, { host: context.host, sessionId, launch: context.launch, checkout: projectRoot, initiative, askedAt });
  } catch {
  }
}
async function setHold(projectRoot, key, holder, until) {
  await withRecordLock(projectRoot, recordKey(key), async () => {
    const previous = await readShared(projectRoot, key);
    const holds = liveHolds(previous);
    if (until === null && !(holder in holds)) return;
    if (until === null) delete holds[holder];
    else holds[holder] = { until: new Date(until).toISOString(), renewedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const asker = previous ?? Object.fromEntries(ASKER_FIELDS.map((field) => [field, field === "launched" ? false : null]));
    const { schemaVersion: _, hold: __, holds: ___, ...fields } = asker;
    await writeRecord(projectRoot, recordKey(key), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...fields, holds }, null, 2)}
`);
  });
}
function holdGates(projectRoot, keys, { leaseMs = holdLeaseMs() } = {}) {
  const holder = randomBytes(8).toString("hex");
  const renew = () => Promise.all(keys.map((key) => setHold(projectRoot, key, holder, Date.now() + leaseMs).catch(() => {
  })));
  let pending = renew();
  const timer = setInterval(() => {
    pending = pending.then(renew);
  }, Math.max(1, Math.floor(leaseMs / 3)));
  timer.unref?.();
  let released = null;
  return {
    ready: pending,
    release: () => released ??= (async () => {
      clearInterval(timer);
      await pending.catch(() => {
      });
      await Promise.all(keys.map((key) => setHold(projectRoot, key, holder, null).catch(() => {
      })));
    })()
  };
}
export {
  ASKER_FIELDS,
  holdGates,
  holdLeaseMs,
  readGateAsker,
  recordGateAskers,
  targetOf,
  withGateAsker
};
