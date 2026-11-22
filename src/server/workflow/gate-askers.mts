import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readWorkspaceIdentity, workspaceLabel, hostLabel } from "../review/workspace-identity.mjs";
import type { SessionLink } from "../session/session-links.mjs";
import { readRecord, withRecordLock, writeRecord } from "./record-store.mjs";
import { parseStoreJson } from "./store-json.mjs";

// The asker of a gate: who asked it, recorded at ask time in a shared record of its own beside the gate, never as a field of the gate,
// because earlier releases refuse a gate record that holds a field they do not know.
// The shared record holds the harness, the machine, the checkout label, the cloud session link, and whether Prism launched the session,
// and the holds of the waits on the gate, one per wait; the harness session id stays in this machine's private file (see asker-sessions).

export const ASKER_FIELDS = ["harness", "machine", "checkout", "cloud", "launched", "askedAt"] as const;
const SCHEMA_VERSION = 1;
const HARNESS_LIMIT = 64;
const DEFAULT_HOLD_MS = 15 * 60 * 1000;

/** An initiative's gate, or an approval gate, which names the initiative it serves in named when it names one. */
export type GateTarget = { initiative: string; gate: string } | { initiative?: undefined; gate: string; named?: string | null };
/** What the asking tool call knows of its session: the harness label, the launch host, its session id, the cloud link, and the launch. */
export type AskerContext = { harness: string | null; host: string | null; sessionId: string | null; cloud: SessionLink | null; launch: string | null };

export const targetOf = (key: GateTarget) => (key.initiative === undefined ? `approval:${key.gate}` : `gate:${key.initiative}/${key.gate}`);
const recordKey = (key: GateTarget) => (key.initiative === undefined ? { kind: "asker", gate: key.gate } : { kind: "asker", initiative: key.initiative, gate: key.gate });

const askerCall = new AsyncLocalStorage<AskerContext>();
/** Run one tool call as the session that context describes, so each gate it asks records that session as its asker. */
export const withGateAsker = <T,>(context: AskerContext, run: () => T) => askerCall.run(context, run);

const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: any) => (typeof value === "string" && value ? value : null);

/** The hold lease: PRISM_GATE_HOLD_MS, a whole number from 1000 to 3600000, else 15 minutes; a hold is renewed at a third of it. */
export function holdLeaseMs(env = process.env) {
  const value = String(env.PRISM_GATE_HOLD_MS ?? "").trim();
  return /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 3600000 ? Number(value) : DEFAULT_HOLD_MS;
}

/** A shared asker record as written, or null when it is missing or does not parse. */
async function readShared(projectRoot: string, key: GateTarget) {
  try {
    const { bytes } = await readRecord(projectRoot, recordKey(key));
    if (bytes === null) return null;
    const value = parseStoreJson(bytes);
    return isRecord(value) && value.schemaVersion === SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

/** The holds of a shared record whose lease has not lapsed, by holder: each wait on the gate keeps its own, so one wait's end leaves another's. */
function liveHolds(record: any, now = Date.now()): Record<string, { until: string; renewedAt: string }> {
  if (!isRecord(record?.holds)) return {};
  return Object.fromEntries(Object.entries(record.holds).filter(([, hold]: [string, any]) => isRecord(hold) && typeof hold.until === "string" && Date.parse(hold.until) > now)) as any;
}

/** The asker of a gate as its card reads it: known only for a record that names when it was asked; a missing or broken record reads unknown. */
export async function readGateAsker(projectRoot: string, key: GateTarget, now = Date.now()) {
  const record = await readShared(projectRoot, key);
  const known = typeof record?.askedAt === "string" && typeof record.machine === "string";
  return {
    known,
    harness: known ? text(record!.harness)?.slice(0, HARNESS_LIMIT) ?? null : null,
    machine: known ? text(record!.machine) : null,
    checkout: known ? text(record!.checkout) : null,
    cloud: known && isRecord(record!.cloud) && typeof record!.cloud.id === "string",
    launched: known && record!.launched === true,
    askedAt: known ? record!.askedAt as string : null,
    held: Object.values(liveHolds(record, now)).length > 0
  };
}

/**
 * Records the current tool call's session as the asker of each gate: the shared record beside each gate, and the session id in this
 * machine's private file. A call outside a tool call, which names no session, records nothing, and a failure never fails the ask.
 */
export async function recordGateAskers(projectRoot: string, keys: GateTarget[]) {
  const context = askerCall.getStore();
  if (!context || !keys.length) return;
  try {
    const checkout = workspaceLabel(await readWorkspaceIdentity(projectRoot));
    const askedAt = new Date().toISOString();
    const shared = { harness: context.harness, machine: hostLabel(), checkout, cloud: context.cloud ? { kind: context.cloud.kind, id: context.cloud.id } : null, launched: context.launch !== null, askedAt };
    for (const key of keys) {
      await withRecordLock(projectRoot, recordKey(key), async () => {
        const previous = await readShared(projectRoot, key);
        await writeRecord(projectRoot, recordKey(key), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...shared, holds: liveHolds(previous) }, null, 2)}\n`);
      });
    }
    const { keepAskerSessions } = await import("../session/asker-sessions.mjs");
    const sessionId = context.host === "claude-code" || context.host === "codex" ? context.sessionId : null;
    // Each target keeps the initiative its own gate names: an initiative's gate its initiative, an approval gate the one it serves or none.
    const byInitiative = new Map<string | null, string[]>();
    for (const key of keys) {
      const initiative = key.initiative ?? (typeof key.named === "string" ? key.named : null);
      byInitiative.set(initiative, [...(byInitiative.get(initiative) ?? []), targetOf(key)]);
    }
    for (const [initiative, targets] of byInitiative) await keepAskerSessions(targets, { host: context.host, sessionId, launch: context.launch, checkout: projectRoot, initiative, askedAt });
  } catch {
    // The gate then reads as asked by an unknown session.
  }
}

// Writes this holder's hold, or clears it, in a gate's shared record, leaving the live holds of other waits and dropping lapsed ones;
// a gate without a record gets one whose asker fields are null.
async function setHold(projectRoot: string, key: GateTarget, holder: string, until: number | null) {
  await withRecordLock(projectRoot, recordKey(key), async () => {
    const previous = await readShared(projectRoot, key);
    const holds = liveHolds(previous);
    if (until === null && !(holder in holds)) return;
    if (until === null) delete holds[holder];
    else holds[holder] = { until: new Date(until).toISOString(), renewedAt: new Date().toISOString() };
    const asker = previous ?? Object.fromEntries(ASKER_FIELDS.map((field) => [field, field === "launched" ? false : null]));
    const { schemaVersion: _, hold: __, holds: ___, ...fields } = asker;
    await writeRecord(projectRoot, recordKey(key), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...fields, holds }, null, 2)}\n`);
  });
}

/**
 * Holds gates for a wait in their shared asker records with a lease that lapses unless renewed, renewing it at a third of the lease,
 * and returns release, which stops renewing and clears this wait's hold, leaving another wait's. A hold that cannot be written leaves the wait as it is.
 */
export function holdGates(projectRoot: string, keys: GateTarget[], { leaseMs = holdLeaseMs() }: { leaseMs?: number } = {}) {
  const holder = randomBytes(8).toString("hex");
  const renew = () => Promise.all(keys.map((key) => setHold(projectRoot, key, holder, Date.now() + leaseMs).catch(() => {})));
  let pending: Promise<unknown> = renew();
  const timer = setInterval(() => { pending = pending.then(renew); }, Math.max(1, Math.floor(leaseMs / 3)));
  timer.unref?.();
  let released: Promise<void> | null = null;
  return {
    ready: pending,
    release: () => released ??= (async () => {
      clearInterval(timer);
      await pending.catch(() => {});
      await Promise.all(keys.map((key) => setHold(projectRoot, key, holder, null).catch(() => {})));
    })()
  };
}
