// Generated from src/server/workflow/change-notices.mts by scripts/native-build/compile.mjs.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { prepareDirectory, reviewAppDirectory } from "../review/review-app-discovery.mjs";
import { actionEffect } from "./actions.mjs";
import { withArtifactLock, withFileLock, writeAtomically } from "./artifact-store.mjs";
import { MAIN_AGENT } from "./call-agent.mjs";
import { claimHolder } from "./slice-claims.mjs";
import { readCoordinationState } from "./state.mjs";
import { parseStoreJson } from "./store-json.mjs";
const NOTICE_FOLDER = "person-change-notices";
const ENTRY_ID = /^[0-9a-f]{32}$/;
const NOTICE_HEADING = "The person changed this initiative in the review app since this session last read it:";
function noticeDirectory(env = process.env) {
  return path.join(reviewAppDirectory(env), NOTICE_FOLDER);
}
function noticeFile(directory, session, projectRoot, initiative) {
  return path.join(directory, `${createHash("sha256").update(`${session}\0${path.resolve(projectRoot)}\0${initiative}`, "utf8").digest("hex").slice(0, 32)}.json`);
}
function readWaits(value, now) {
  return (Array.isArray(value) ? value : []).filter((wait) => typeof wait?.id === "string" && Array.isArray(wait.gates) && Number.isFinite(wait.until) && wait.until > now).map((wait) => ({ id: wait.id, gates: wait.gates.filter((id) => typeof id === "string"), until: wait.until, answers: Array.isArray(wait.answers) ? wait.answers.filter((id) => typeof id === "string") : [] }));
}
async function readNotice(file) {
  try {
    const value = parseStoreJson(await readFile(file, "utf8"));
    return {
      shown: Array.isArray(value?.shown) ? value.shown.filter((id) => typeof id === "string") : null,
      coordinator: typeof value?.coordinator === "string" && value.coordinator ? value.coordinator : MAIN_AGENT,
      waits: readWaits(value?.waits, Date.now()),
      asked: Array.isArray(value?.asked) ? value.asked.filter((id) => typeof id === "string") : []
    };
  } catch {
    return { shown: null, coordinator: MAIN_AGENT, waits: [], asked: [] };
  }
}
const wellFormed = (state) => (Array.isArray(state?.history) ? state.history : []).filter((entry) => typeof entry?.id === "string" && ENTRY_ID.test(entry.id));
const recordText = ({ shown, coordinator, waits, asked }) => `${JSON.stringify({ shown, coordinator, ...waits.length ? { waits } : {}, ...asked.length ? { asked } : {} })}
`;
async function withNotice({ projectRoot, initiative, session, directory }, step) {
  await prepareDirectory(directory);
  const file = noticeFile(directory, session, projectRoot, initiative);
  return withArtifactLock(file, () => withFileLock(file, async () => {
    const record = await readNotice(file);
    const read = await readCoordinationState({ projectRoot, initiative });
    const state = read.valid ? read.state ?? {} : null;
    const history = state ? wellFormed(state) : [];
    const { result, shown = record.shown, coordinator = record.coordinator, waits = record.waits, asked = record.asked } = await step(record, history, state);
    let kept = shown;
    if (state) {
      const ids = history.map((entry) => entry.id);
      kept = shown === null ? ids : ids.filter((id) => shown.includes(id));
    }
    const pending = state && new Set((Array.isArray(state.pending) ? state.pending : []).map((gate) => gate?.id));
    const next = recordText({ shown: kept, coordinator, waits, asked: pending ? asked.filter((id) => pending.has(id)) : asked });
    if (next !== recordText(record)) await writeAtomically(file, next, { mode: 384 });
    return result;
  }, void 0, { renew: true, abandonWhenUnrenewed: true }));
}
const heldTargets = (initiative, waits, except = null) => new Set(waits.filter((wait) => wait.id !== except).flatMap((wait) => [...wait.gates.map((id) => `gate:${initiative}/${id}`), ...wait.answers]));
const isHeld = (entry, held) => entry.action === "gate.answer" && (held.has(entry.target) || held.has(entry.id));
async function takePersonChanges({ projectRoot, initiative, agent = MAIN_AGENT, coordinates = false, session = claimHolder(), directory = noticeDirectory() }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history) => {
    const coordinator = coordinates ? agent : record.coordinator;
    if (record.shown === null || coordinator !== agent) return { result: [], coordinator };
    const held = heldTargets(initiative, record.waits);
    const changes = history.filter((entry) => !record.shown.includes(entry.id) && !isHeld(entry, held));
    return { result: changes, shown: [...record.shown, ...changes.map((entry) => entry.id)], coordinator };
  });
}
async function rememberAskedGates({ projectRoot, initiative, gateIds, session = claimHolder(), directory = noticeDirectory() }) {
  if (!gateIds.length) return;
  await withNotice({ projectRoot, initiative, session, directory }, (record) => ({ result: null, asked: [.../* @__PURE__ */ new Set([...record.asked, ...gateIds])] }));
}
async function askedGates({ projectRoot, initiative, session, directory = noticeDirectory() }) {
  return (await readNotice(noticeFile(directory, session, projectRoot, initiative))).asked;
}
async function startGateWait({ projectRoot, initiative, agent = MAIN_AGENT, session = claimHolder(), directory = noticeDirectory() }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history, state) => ({
    result: { coordinates: record.coordinator === agent, known: state ? history.map((entry) => entry.id) : record.shown }
  }));
}
async function gateWaitStep({ projectRoot, initiative, session = claimHolder(), directory = noticeDirectory(), waitId, gateIds, until }, decide) {
  return withNotice({ projectRoot, initiative, session, directory }, (record, history, state) => {
    const own = record.waits.find((wait) => wait.id === waitId);
    const others = record.waits.filter((wait) => wait.id !== waitId);
    const holding = { id: waitId, gates: own?.gates ?? [], until, answers: own?.answers ?? [] };
    if (!state) return { result: decide(null, [], null, null).result, waits: [...others, holding] };
    const shown = record.shown ?? history.map((entry) => entry.id);
    const pending = new Set((Array.isArray(state.pending) ? state.pending : []).map((gate) => gate?.id));
    holding.gates = gateIds.filter((id) => pending.has(id));
    const { result, answers = [], changes = [] } = decide(state, history, new Set(shown), heldTargets(initiative, others));
    const targets = new Set(answers.map((id) => `gate:${initiative}/${id}`));
    const found = history.filter((entry) => entry.action === "gate.answer" && targets.has(entry.target) && !shown.includes(entry.id)).map((entry) => entry.id);
    holding.answers = [.../* @__PURE__ */ new Set([...holding.answers, ...found])];
    if (changes.length) return { result, shown: [...shown, ...changes.map((entry) => entry.id)], waits: others };
    return { result, shown, waits: [...others, holding] };
  });
}
async function endGateWait({ projectRoot, initiative, session = claimHolder(), directory = noticeDirectory(), waitId, cancelled = false, hold = null }) {
  return withNotice({ projectRoot, initiative, session, directory }, (record) => {
    const own = record.waits.find((wait) => wait.id === waitId);
    if (!own) return { result: null };
    const others = record.waits.filter((wait) => wait.id !== waitId);
    if (hold !== null) return { result: null, waits: [...others, { ...own, until: hold }] };
    const shown = record.shown === null || cancelled ? record.shown : [...record.shown, ...own.answers.filter((id) => !record.shown.includes(id))];
    return { result: null, shown, waits: others };
  });
}
const UNSAFE = /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const noticeString = (value) => value.replace(UNSAFE, (character) => character === "\\" ? "\\\\" : `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const UNSAFE_JSON = /[\u007f-\u009f\u2028\u2029]/g;
function noticeValue(value) {
  if (typeof value === "string") return noticeString(value);
  return (JSON.stringify(value) ?? "null").replace(UNSAFE_JSON, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function authorText(by) {
  const name = typeof by?.name === "string" && by.name ? noticeString(by.name) : null;
  const email = typeof by?.email === "string" && by.email ? `<${noticeString(by.email)}>` : null;
  const who = [name, email].filter(Boolean).join(" ") || "an unknown person";
  return `${who}${typeof by?.checkout === "string" && by.checkout ? ` (${noticeString(by.checkout)})` : ""}`;
}
function personChangesText(entries) {
  return [NOTICE_HEADING, ...entries.map((entry) => {
    const effect = actionEffect(entry.action);
    return `- ${noticeValue(entry.action)} on ${noticeValue(entry.target)}: ${noticeValue(entry.before)} -> ${noticeValue(entry.after)}.${effect ? ` ${effect}` : ""} Changed by ${authorText(entry.by)}.`;
  })].join("\n");
}
const KEPT_SETTINGS_HEADING = "The person set these settings in the review app, so Prism kept their values:";
function keptSettingsText(kept) {
  return [KEPT_SETTINGS_HEADING, ...kept.map((item) => `- ${noticeString(String(item.setting))}: kept ${noticeValue(item.kept)}, requested ${noticeValue(item.requested)}.`)].join("\n");
}
export {
  KEPT_SETTINGS_HEADING,
  NOTICE_FOLDER,
  NOTICE_HEADING,
  askedGates,
  authorText,
  endGateWait,
  gateWaitStep,
  keptSettingsText,
  noticeDirectory,
  noticeString,
  noticeValue,
  personChangesText,
  rememberAskedGates,
  startGateWait,
  takePersonChanges
};
