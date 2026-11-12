import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { listComponents } from "./components.mjs";
import { appendIndexHistory } from "./index-history.mjs";
import { readInitiativeWithClaims } from "./initiative.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { runGit } from "./record-store-sync.mjs";
import { REPOSITORY_NAME } from "./repository-names.mjs";
import { readRoadmap } from "./roadmap.mjs";
import { shippedActionReason, shippedDecision } from "./shipped-history.mjs";
import { INITIATIVE_SETTINGS, readCoordinationState, recordPersonAction } from "./state.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
import { checkoutLabel, readWorkspaceIdentity } from "../review/workspace-identity.mjs";
import { confirmLaunch } from "../session/launch-confirmation.mjs";
import { HOSTS } from "../session/launch-hosts.mjs";
import { LAUNCH_ID_PATTERN } from "../session/launch-records.mjs";
import {
  answerLaunchGate,
  hostAvailability,
  initiativeRunning,
  launchRunStatus,
  launchRunningMessage,
  LaunchError,
  listLaunches,
  resumeLaunch,
  resumeRefusal,
  startLaunch,
  stopLaunch
} from "../session/launched-sessions.mjs";

// The review app's actions: one registry of definitions that lists and applies every change a person makes to Prism records from a page.
// The module needs no HTTP, so any transport serves the same registry, and a new action joins by adding a definition below.

const GATE_ID = /^gate-[0-9a-f]{8,32}$/;
const TEXT_LIMIT = 200;
const NOTE_LIMIT = 4000;

export class ActionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code, message, details) => new ActionError(code, message, details);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const option = (value, label, consequence = null) => ({ value, label, consequence });

function field(name, kind, label, extra = {}) {
  return { name, kind, label, options: null, required: false, requiredWhen: null, maxLength: null, multiline: null, ...extra };
}

const choice = (name, label, options, extra = {}) => field(name, "choice", label, { options, ...extra });
const toggle = (name, label, off, on) => field(name, "toggle", label, { options: [option("off", "Off", off), option("on", "On", on)], required: true });
const text = (name, label, maxLength, extra = {}) => field(name, "text", label, { maxLength, multiline: false, ...extra });

// ---- Targets ----

/** A target reference read into its parts, or null when it is malformed. */
export function parseTarget(reference) {
  if (typeof reference !== "string") return null;
  let match = /^initiative:([^/]+)$/.exec(reference);
  if (match && SLUG_PATTERN.test(match[1])) return { kind: "initiative", reference, initiative: match[1] };
  match = /^slice:([^/]+)\/([^/]+)$/.exec(reference);
  if (match && SLUG_PATTERN.test(match[1]) && SLUG_PATTERN.test(match[2])) return { kind: "slice", reference, initiative: match[1], slice: match[2] };
  match = /^gate:([^/]+)\/([^/]+)$/.exec(reference);
  if (match && SLUG_PATTERN.test(match[1]) && GATE_ID.test(match[2])) return { kind: "gate", reference, initiative: match[1], gate: match[2] };
  match = /^launch:(.+)$/.exec(reference);
  if (match && LAUNCH_ID_PATTERN.test(match[1])) return { kind: "launch", reference, launch: match[1] };
  match = /^index:([^/]+)\/([^/]+)$/.exec(reference);
  if (match && REPOSITORY_NAME.test(match[1]) && REPOSITORY_NAME.test(match[2])) return { kind: "index", reference, identity: `${match[1]}/${match[2]}` };
  return null;
}

const unknownTarget = (reference) => fail("unknown_target", `No action target ${JSON.stringify(String(reference ?? ""))} exists on this page.`);

// The checkout's components as index targets: the root component first and the declared ones in declaration order.
async function indexComponents(projectRoot) {
  const config = await readWorkflowConfig(projectRoot);
  const listed = listComponents(config);
  const repository = listed.repository ?? "root";
  if (listed.problem || listed.declared.length === 0) return [{ identity: `${repository}/${repository}`, folder: "" }];
  return listed.declared.map((component) => ({ identity: component.component, folder: component.folder }));
}

/** The targets of a kind on a checkout's page: { targets }, which only the index kind lists. */
export async function listActionTargets({ projectRoot, kind }) {
  if (kind !== "index") throw fail("unknown_target", "Only index targets are listed.");
  return { targets: (await indexComponents(projectRoot)).map((component) => `index:${component.identity}`) };
}

async function initiativeExists(projectRoot, initiative, record) {
  if (record) return true;
  const roadmap = await readRoadmap(projectRoot).catch(() => null);
  return Boolean(roadmap?.loaded?.record?.initiatives?.some((item) => item.id === initiative));
}

// Reads what a target's actions need: the initiative's coordination state and record, or the index component, and refuses a target that does not exist.
async function readTarget(projectRoot, parsed, indexer, state = undefined, env = process.env) {
  if (parsed.kind === "launch") {
    // A launched session is a target while this machine lists it for the page's checkout.
    const view = (await listLaunches({ projectRoot, env })).launches.find((item) => item.id === parsed.launch);
    if (!view) throw unknownTarget(parsed.reference);
    const status = await launchRunStatus({ id: parsed.launch, env });
    const resumeReason = status === "running" ? "The session is running." : await resumeRefusal({ id: parsed.launch, env });
    // A shipped initiative's state is history, so its launched sessions' actions are unavailable as every other action on it.
    const shipped = await shippedDecision(projectRoot, view.initiative).catch(() => null);
    return { ...parsed, view, initiative: view.initiative, running: status === "running", resumeReason, shipped };
  }
  if (parsed.kind === "index") {
    const component = (await indexComponents(projectRoot)).find((item) => item.identity === parsed.identity);
    if (!component) throw unknownTarget(parsed.reference);
    const status = await Promise.resolve(indexer.status(projectRoot, component)).catch(() => null);
    return { ...parsed, component, indexState: status?.state ?? null };
  }
  const coordination = state ?? await readCoordinationState({ projectRoot, initiative: parsed.initiative }).then((read) => ({ exists: read.exists, revision: read.revision, state: read.state, valid: read.valid }));
  const { loaded } = await readInitiativeWithClaims(projectRoot, parsed.initiative).catch(() => ({ loaded: { exists: false, record: null } }));
  const record = loaded.exists ? loaded.record : null;
  // A shipped initiative's state is history, so its decision makes every action on it unavailable.
  const shipped = await shippedDecision(projectRoot, parsed.initiative).catch(() => null);
  const context = { ...parsed, coordination, record, shipped, initiativeTarget: `initiative:${parsed.initiative}` };
  if (parsed.kind === "initiative" && !(await initiativeExists(projectRoot, parsed.initiative, record))) throw unknownTarget(parsed.reference);
  if (parsed.kind === "initiative") {
    context.hosts = await hostAvailability({ env });
    context.launchRunning = await initiativeRunning({ projectRoot, initiative: parsed.initiative, env });
  }
  if (parsed.kind === "slice" && !(record?.slices && Object.hasOwn(record.slices, parsed.slice))) throw unknownTarget(parsed.reference);
  if (parsed.kind === "gate") {
    const gate = (coordination.state?.pending ?? []).find((item) => isRecord(item) && item.id === parsed.gate);
    if (!gate) throw unknownTarget(parsed.reference);
    context.gateRecord = gate;
  }
  return context;
}

// ---- Definitions ----

const settingsOf = (context) => (context.coordination.valid ? context.coordination.state?.settings : null) ?? {};

function setting({ name, label, fields, effect, confirm = null, value, after = (values) => values.value, ignores = () => [] }) {
  return {
    id: `initiative.${name}`,
    kinds: ["initiative", "slice"],
    label,
    group: "Initiative settings",
    effect,
    target: (context) => context.initiativeTarget,
    fields: () => fields,
    value,
    context: () => null,
    recommended: () => null,
    confirm: () => confirm,
    revision: (context) => context.coordination.revision,
    unavailable: () => null,
    ignores,
    after,
    change: (context, after) => ({ setting: { name, value: after } })
  };
}

const NEXT_CHILD = "Applies to child sessions started after the change.";
const autonomyOf = (context) => settingsOf(context).autonomy ?? "conservative";
const modelsOf = (context) => {
  const stored = settingsOf(context).models;
  return stored === undefined || stored === "defaults" ? "host defaults" : stored;
};
const whenCustom = { field: "mode", values: ["custom"] };

const SETTING_DEFINITIONS = [
  setting({
    name: "autonomy",
    label: "Autonomy",
    fields: [choice("value", "Autonomy", [option("conservative", "Conservative"), option("broad", "Broad"), option("full", "Full")], { required: true })],
    effect: "Decides which later gates wait for you; a gate already open keeps waiting for you.",
    confirm: { field: "value", values: ["full"], message: "Agents will accept every design and resolve internal decisions without you." },
    value: autonomyOf
  }),
  setting({
    name: "commit",
    label: "Commit",
    fields: [toggle("value", "Commit", "Agents leave their changes uncommitted.", "Agents commit their changes to Git history.")],
    effect: NEXT_CHILD,
    confirm: { field: "value", values: ["on"], message: "Agents will commit their changes to Git history." },
    value: (context) => settingsOf(context).commit ?? (autonomyOf(context) === "full" ? "on" : "off")
  }),
  setting({
    name: "push",
    label: "Push",
    fields: [toggle("value", "Push", "Finished slices stay on this machine.", "Agents push finished slices beyond this machine.")],
    effect: NEXT_CHILD,
    confirm: { field: "value", values: ["on"], message: "Agents will push finished slices beyond this machine." },
    value: (context) => settingsOf(context).push ?? "off"
  }),
  setting({
    name: "continuation",
    label: "Continuation",
    fields: [choice("value", "Continuation", [option("auto", "Automatic"), option("stepwise", "Stepwise")], { required: true })],
    effect: "Applies when the slice in progress finishes.",
    value: (context) => settingsOf(context).continuation ?? "auto"
  }),
  setting({
    name: "review",
    label: "Review",
    fields: [choice("value", "Review", [option("marked", "Marked slices"), option("recommended", "Recommended slices"), option("all", "All slices")], { required: true })],
    effect: "Sets the review mark of slices whose design is not yet accepted.",
    value: (context) => settingsOf(context).review ?? "marked"
  }),
  setting({
    name: "models",
    label: "Models",
    fields: [
      choice("mode", "Models", [option("host defaults", "Host defaults"), option("custom", "Custom")], { required: true }),
      text("delivery", "Delivery model", TEXT_LIMIT, { requiredWhen: whenCustom }),
      text("review", "Review model", TEXT_LIMIT, { requiredWhen: whenCustom }),
      text("securityReview", "Security review model", TEXT_LIMIT, { requiredWhen: whenCustom }),
      text("examples", "Examples model", TEXT_LIMIT)
    ],
    effect: NEXT_CHILD,
    value: modelsOf,
    // Host defaults store no model names, so the text fields are neither checked nor kept.
    ignores: (values) => values.mode === "host defaults" ? ["delivery", "review", "securityReview", "examples"] : [],
    after: (values) => values.mode === "host defaults"
      ? "host defaults"
      : { delivery: values.delivery, review: values.review, securityReview: values.securityReview, ...(values.examples === null ? {} : { examples: values.examples }) }
  })
];

// Only the settings that coordination state accepts have actions, so a setting Prism retires loses its action with it.
const SETTING_ACTIONS = SETTING_DEFINITIONS.filter((definition) => INITIATIVE_SETTINGS.includes(definition.id.slice("initiative.".length)));

// A gate's answer fields follow its kind: a review approves or asks for changes with a reason, a decision picks an option or explains, and assistance is done.
function gateFields(gate) {
  const note = (extra) => text("note", "Note", NOTE_LIMIT, { multiline: true, ...extra });
  if (gate.kind === "visual-review" || gate.kind === "correctness") {
    return [choice("choice", "Answer", [option("approve", "Approve"), option("request-changes", "Request changes")], { required: true }), note({ requiredWhen: { field: "choice", values: ["request-changes"] } })];
  }
  if (gate.kind === "decision" && Array.isArray(gate.options) && gate.options.length) {
    return [choice("choice", "Answer", gate.options.map((item) => option(item.id, item.label, typeof item.consequence === "string" ? item.consequence : null))), note({ requiredWhen: { field: "choice", values: [null] } })];
  }
  if (gate.kind === "decision") return [note({ required: true })];
  return [choice("choice", "Answer", [option("done", "Done")], { required: true }), note()];
}

// A gate's recommendation as the page shows it: the recommended option, or null when it names none, and why.
function gateRecommendation(gate) {
  const recommended = gate.recommended;
  if (!isRecord(recommended) || typeof recommended.reason !== "string") return null;
  return { value: typeof recommended.option === "string" ? recommended.option : null, reason: recommended.reason };
}

const GATE_ANSWER = {
  id: "gate.answer",
  kinds: ["gate"],
  label: "Answer",
  group: "Question",
  effect: "Records your answer, and the agent waiting on the question resumes with it.",
  target: (context) => context.reference,
  fields: (context) => gateFields(context.gateRecord),
  value: () => null,
  context: (context) => typeof context.gateRecord.context === "string" && context.gateRecord.context ? context.gateRecord.context : null,
  recommended: (context) => gateRecommendation(context.gateRecord),
  confirm: () => null,
  revision: (context) => context.coordination.revision,
  unavailable: (context) => context.gateRecord.answer ? "The question already has an answer." : null,
  after: (values) => ({ choice: values.choice ?? null, note: values.note ?? null }),
  change: (context, after) => ({ answer: { id: context.gate, choice: after.choice, note: after.note } })
};

const INDEX_REBUILD = {
  id: "index.rebuild",
  kinds: ["index"],
  label: "Rebuild index",
  group: "Index",
  effect: "Starts a new build of this component's index now; searches use the current index until it finishes.",
  target: (context) => context.reference,
  fields: () => [],
  value: () => null,
  context: () => null,
  recommended: () => null,
  confirm: () => null,
  revision: () => null,
  unavailable: (context) => context.indexState === "preparing" ? "An index build is already running." : null,
  after: () => "started"
};

// Launched sessions: a launch per host on an initiative, and stop and resume on each launched session. Each runs through its own step
// after the common checks, the launch and the person's resume behind the confirmation outside the page, and is recorded only once it took effect.
const LAUNCH_GROUP = "Launched session";
const launchBase = {
  group: LAUNCH_GROUP,
  fields: () => [],
  value: () => null,
  context: () => null,
  recommended: () => null,
  confirm: () => null,
  revision: () => null
};

const LAUNCH_ACTIONS = HOSTS.map(({ host, label }) => ({
  ...launchBase,
  id: `launch.${host}`,
  kinds: ["initiative"],
  label: `Launch with ${label}`,
  effect: `Starts a headless ${label} session on this computer that runs the orchestrate skill for this initiative; you confirm it outside the browser unless you confirmed in the last 30 minutes.`,
  target: (context) => context.initiativeTarget,
  unavailable: (context) => {
    const availability = context.hosts.find((item) => item.host === host);
    if (!availability?.available) return availability?.reason ?? `${label} was not found.`;
    return context.launchRunning ? launchRunningMessage(context.initiative) : null;
  },
  after: () => null,
  async launch({ projectRoot, context, env }) {
    const checkout = await realpath(projectRoot);
    await confirmLaunch({ initiative: context.initiative, host, checkout, env });
    const { launch } = await startLaunch({ projectRoot: checkout, initiative: context.initiative, host, env });
    return { launch, after: { launch: launch.id, host }, initiative: context.initiative, started: launch.id };
  }
}));

const LAUNCH_STOP = {
  ...launchBase,
  id: "launch.stop",
  kinds: ["launch"],
  label: "Stop",
  effect: "Interrupts the host's turn as the host's own Stop button does, and ends the host process if it still runs after the grace period.",
  target: (context) => context.reference,
  unavailable: (context) => (context.running ? null : "The session is not running."),
  after: () => null,
  async launch({ context, env }) {
    const launch = await stopLaunch({ id: context.launch, env });
    return { launch, after: "stopped", initiative: context.initiative, started: null };
  }
};

const LAUNCH_RESUME = {
  ...launchBase,
  id: "launch.resume",
  kinds: ["launch"],
  label: "Resume",
  effect: "Starts the host session again headless; you confirm it outside the browser unless you confirmed in the last 30 minutes.",
  target: (context) => context.reference,
  unavailable: (context) => context.resumeReason,
  after: () => null,
  async launch({ context, env }) {
    await confirmLaunch({ initiative: context.view.initiative, host: context.view.host, checkout: context.view.checkout, env });
    const launch = await resumeLaunch({ id: context.launch, env, cause: "person" });
    return { launch, after: { launch: launch.id, run: launch.runs }, initiative: context.initiative, started: null };
  }
};

/** Every action, in listing order; a later action joins by adding its definition here. */
const ACTIONS = [...SETTING_ACTIONS, ...LAUNCH_ACTIONS, GATE_ANSWER, INDEX_REBUILD, LAUNCH_STOP, LAUNCH_RESUME];

/** The sentence on when an action's change takes effect, or null for an action the registry does not define. */
export const actionEffect = (id) => ACTIONS.find((definition) => definition.id === id)?.effect ?? null;

function view(definition, context) {
  const reason = context.shipped ? shippedActionReason(context.shipped) : definition.unavailable(context);
  return {
    id: definition.id,
    label: definition.label,
    group: definition.group,
    target: definition.target(context),
    value: definition.value(context),
    fields: definition.fields(context),
    effect: definition.effect,
    context: definition.context(context),
    recommended: definition.recommended(context),
    available: reason === null,
    reason,
    confirm: definition.confirm(context),
    revision: definition.revision(context)
  };
}

const definitionsFor = (kind) => ACTIONS.filter((definition) => definition.kinds.includes(kind));

// ---- The default indexer ----

/** One component's indexing status from a checkout's index status: its own entry with declared components, or the status itself without them. */
export function componentIndexingStatus(status, component) {
  if (!Array.isArray(status?.components)) return status;
  return { state: status.components.find((entry) => entry.component === component?.identity)?.state ?? "none" };
}

/**
 * Prism's own indexer, which serves each component's own index: in a repository that declares components, a component's state is its entry in the
 * index status, or none while it has neither an index nor a preparation, and without declared components the root component's state is the status's own.
 */
export const prismIndexer = Object.freeze({
  async status(projectRoot, component) {
    const [{ readIndexingStatus }, { nativeSemanticRuntime }] = await Promise.all([import("../repository-intelligence/index-status.mjs"), import("../repository-intelligence/native-semantic-runtime.mjs")]);
    return componentIndexingStatus(await readIndexingStatus(projectRoot, [nativeSemanticRuntime.directory]), component);
  },
  async rebuild(projectRoot, component) {
    const { startIndexRebuild } = await import("../repository-intelligence/background-preparation.mjs");
    void startIndexRebuild(projectRoot, { component: { identity: component.identity, folder: component.folder } });
  }
});

// ---- Listing ----

/** The actions that apply to a target: { target, actions }, available or not. */
export async function listActions({ projectRoot, target, indexer = prismIndexer, env = process.env }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const context = await readTarget(projectRoot, parsed, indexer, undefined, env);
  return { target, actions: definitionsFor(parsed.kind).map((definition) => view(definition, context)) };
}

// ---- Input ----

const optionValues = (item) => item.options.map((entry) => entry.value);
const invalid = (name, accepted, message) => fail("invalid_input", message, { field: name, accepted });

// Reads an input against the fields: every value is a listed option, a text within its limit, or empty as null, and every required field is filled.
// The options are read first, so a field that the chosen options make irrelevant is read as null without a check.
function readInput(fields, input, ignores = () => []) {
  if (!isRecord(input)) throw invalid(null, `The input maps field names to values: ${fields.map((item) => item.name).join(", ") || "none"}.`, "The input must be an object of field values.");
  const names = new Set(fields.map((item) => item.name));
  for (const name of Object.keys(input)) {
    if (!names.has(name)) throw invalid(name, fields.length ? `The action has no field ${name}; its fields are ${fields.map((item) => item.name).join(", ")}.` : `The action has no field ${name}; it takes no fields.`, `The action has no field ${name}.`);
  }
  const values = {};
  const ordered = [...fields.filter((item) => item.kind !== "text"), ...fields.filter((item) => item.kind === "text")];
  let ignored = null;
  for (const item of ordered) {
    const raw = input[item.name];
    if (item.kind === "text") {
      ignored ??= new Set(ignores(values));
      if (ignored.has(item.name)) {
        values[item.name] = null;
        continue;
      }
      const accepted = `Text of at most ${item.maxLength} characters.`;
      if (raw !== undefined && raw !== null && typeof raw !== "string") throw invalid(item.name, accepted, `${item.label} must be text.`);
      if (typeof raw === "string" && raw.length > item.maxLength) throw invalid(item.name, accepted, `${item.label} takes at most ${item.maxLength} characters.`);
      values[item.name] = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    } else {
      if (raw === undefined || raw === null || raw === "") {
        values[item.name] = null;
      } else if (typeof raw !== "string" || !optionValues(item).includes(raw)) {
        throw invalid(item.name, optionValues(item), `${item.label} must be one of ${optionValues(item).join(", ")}.`);
      } else {
        values[item.name] = raw;
      }
    }
  }
  for (const item of fields) {
    const when = item.requiredWhen;
    const required = item.required || (when !== null && when.values.includes(values[when.field] ?? null));
    if (required && values[item.name] === null) {
      throw invalid(item.name, item.kind === "text" ? `Fill in ${item.label}.` : optionValues(item), `Fill in ${item.label}.`);
    }
  }
  return values;
}

// ---- Applying ----

// Two values are the same when they hold the same data, whatever order an object's keys were stored in.
function sameValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
  }
  return left === right;
}

// The author is what the applying checkout's Git configuration claims, with the checkout's label on this host; nothing checks it.
async function authorOf(projectRoot) {
  const read = async (key) => {
    const result = await runGit(projectRoot, ["config", key]);
    const value = result.ok ? result.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return value || null;
  };
  const [name, email, identity] = await Promise.all([read("user.name"), read("user.email"), readWorkspaceIdentity(projectRoot)]);
  return { name, email, checkout: checkoutLabel(identity).slice(0, 400) };
}

// Checks one request against a target read: the action, the revision, availability, the input, and confirmation, in that order.
// It answers null for an input equal to the current value, and otherwise the definition, its view, and the value to set.
function check(definition, context, { revision, input, confirmed }) {
  const current = view(definition, context);
  if ((revision ?? null) !== current.revision) throw fail("stale_revision", "The record changed since the page read it.", { current });
  if (!current.available) throw fail("action_unavailable", current.reason, { reason: current.reason, current });
  const values = readInput(current.fields, input, definition.ignores ?? (() => []));
  const after = definition.after(values, context);
  if (current.value !== null && sameValue(after, current.value)) return null;
  if (current.confirm && current.confirm.values.includes(values[current.confirm.field] ?? null) && confirmed !== true) {
    throw fail("confirmation_required", current.confirm.message, { confirm: current.confirm });
  }
  return { current, after };
}

/** Applies one action to a target: { applied, actions }, where applied is the history entry or null for an unchanged value, and actions the target's listing after it. */
export async function applyAction({ projectRoot, target, action, input, revision, confirmed, via = "review-app", indexer = prismIndexer, env = process.env }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const definition = definitionsFor(parsed.kind).find((item) => item.id === action);
  const read = await readTarget(projectRoot, parsed, indexer, undefined, env);
  if (!definition) throw fail("unknown_action", `The target ${target} has no action ${JSON.stringify(String(action ?? ""))}.`);
  const request = { revision, input, confirmed };
  const entryOf = async (checked, context) => ({
    id: randomBytes(16).toString("hex"),
    action: definition.id,
    target: checked.current.target,
    before: checked.current.value,
    after: checked.after,
    at: new Date().toISOString(),
    by: await authorOf(projectRoot),
    via: typeof via === "string" && via ? via : "review-app"
  });
  if (definition.launch) return applyLaunchAction({ projectRoot, definition, context: read, request, entryOf, env, target, indexer });
  let applied = null;
  if (parsed.kind === "index") {
    const checked = check(definition, read, request);
    if (checked) {
      applied = await entryOf(checked, read);
      await indexer.rebuild(projectRoot, read.component);
      await appendIndexHistory(projectRoot, applied);
    }
  } else {
    // The checks repeat under the state lock on the state it holds, so a change that lands between the read above and the write is never overwritten.
    const written = await recordPersonAction({ projectRoot, initiative: parsed.initiative, prepare: async (coordination) => {
      const context = await readTarget(projectRoot, parsed, indexer, coordination);
      const checked = check(definition, context, request);
      if (!checked) return null;
      const entry = await entryOf(checked, context);
      return { entry, ...definition.change(context, checked.after) };
    } });
    applied = written.entry;
  }
  const actions = (await listActions({ projectRoot, target, indexer, env })).actions;
  // An answer to a gate that a launched session of this machine asked is recorded for that session, which it may resume.
  if (parsed.kind === "gate") {
    const launch = applied ? await answerLaunchGate({ projectRoot, initiative: parsed.initiative, gate: parsed.gate, entry: applied.id, env }).catch(() => null) : null;
    return { applied, actions, launch };
  }
  return { applied, actions };
}

// A launched session's refusal answers as an action refusal with its own code and message.
const launchRefusal = (error) => (error instanceof LaunchError ? fail(error.code, error.message) : error);

// Applies a launch, stop, or resume: the common checks, then the action's own step, which confirms outside the page where it starts a
// session, and only once that took effect the history entry, which names the launch id and never the host session id.
async function applyLaunchAction({ projectRoot, definition, context, request, entryOf, env, target, indexer }) {
  const checked = check(definition, context, request);
  let outcome;
  try {
    outcome = await definition.launch({ projectRoot, context, env });
  } catch (error) {
    throw launchRefusal(error);
  }
  const entry = await entryOf({ ...checked, after: outcome.after }, context);
  try {
    await recordPersonAction({ projectRoot, initiative: outcome.initiative, prepare: async () => ({ entry }) });
  } catch (error) {
    // A launch that cannot be recorded does not stay started.
    if (outcome.started) await stopLaunch({ id: outcome.started, env }).catch(() => {});
    throw error;
  }
  return { applied: entry, actions: (await listActions({ projectRoot, target, indexer, env })).actions, launch: outcome.launch };
}
