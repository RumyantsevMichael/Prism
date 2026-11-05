import { randomBytes } from "node:crypto";
import { listComponents } from "./components.mjs";
import { appendIndexHistory } from "./index-history.mjs";
import { readInitiativeWithClaims } from "./initiative.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { runGit } from "./record-store-sync.mjs";
import { REPOSITORY_NAME } from "./repository-names.mjs";
import { readRoadmap } from "./roadmap.mjs";
import { isLive } from "./slice-claims.mjs";
import { readCoordinationState, recordPersonAction } from "./state.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
import { checkoutLabel, readWorkspaceIdentity } from "../review/workspace-identity.mjs";

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
const option = (value, label) => ({ value, label });

function field(name, kind, label, extra = {}) {
  return { name, kind, label, options: null, required: false, requiredWhen: null, maxLength: null, multiline: null, ...extra };
}

const choice = (name, label, options, extra = {}) => field(name, "choice", label, { options, ...extra });
const toggle = (name, label) => field(name, "toggle", label, { options: [option("off", "Off"), option("on", "On")], required: true });
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
async function readTarget(projectRoot, parsed, indexer, state = undefined) {
  if (parsed.kind === "index") {
    const component = (await indexComponents(projectRoot)).find((item) => item.identity === parsed.identity);
    if (!component) throw unknownTarget(parsed.reference);
    const status = await Promise.resolve(indexer.status(projectRoot, component)).catch(() => null);
    return { ...parsed, component, indexState: status?.state ?? null };
  }
  const coordination = state ?? await readCoordinationState({ projectRoot, initiative: parsed.initiative }).then((read) => ({ exists: read.exists, revision: read.revision, state: read.state, valid: read.valid }));
  const { loaded } = await readInitiativeWithClaims(projectRoot, parsed.initiative).catch(() => ({ loaded: { exists: false, record: null } }));
  const record = loaded.exists ? loaded.record : null;
  const context = { ...parsed, coordination, record, initiativeTarget: `initiative:${parsed.initiative}` };
  if (parsed.kind === "initiative" && !(await initiativeExists(projectRoot, parsed.initiative, record))) throw unknownTarget(parsed.reference);
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

// Work has started once a slice left not-started, a slice holds a live claim, or the coordination state lists active work, as this checkout's records show them.
function workStarted(context) {
  const slices = Object.values(context.record?.slices ?? {});
  if (slices.some((slice) => slice?.status !== "not-started" || (slice?.claim && isLive(slice.claim)))) return true;
  return (context.coordination.state?.active ?? []).length > 0;
}

function setting({ name, label, fields, effect, confirm = null, value, after = (values) => values.value, unavailable = () => null }) {
  return {
    id: `initiative.${name}`,
    kinds: ["initiative", "slice"],
    label,
    group: "Initiative settings",
    effect,
    target: (context) => context.initiativeTarget,
    fields: () => fields,
    value,
    confirm: () => confirm,
    revision: (context) => context.coordination.revision,
    unavailable,
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

const SETTING_ACTIONS = [
  setting({
    name: "autonomy",
    label: "Autonomy",
    fields: [choice("value", "Autonomy", [option("conservative", "Conservative"), option("broad", "Broad"), option("full", "Full")], { required: true })],
    effect: "Decides which later gates wait for you; a gate already open keeps waiting for you.",
    confirm: { field: "value", values: ["full"], message: "Agents will accept every design and resolve internal decisions without you." },
    value: autonomyOf
  }),
  setting({
    name: "agentFlow",
    label: "Agent flow",
    fields: [choice("value", "Agent flow", [option("multi", "Multi-agent"), option("mono", "Single agent")], { required: true })],
    effect: "Applies when work on the initiative starts.",
    value: (context) => settingsOf(context).agentFlow ?? "multi",
    unavailable: (context) => workStarted(context) ? "Agent flow is fixed once work on the initiative starts." : null
  }),
  setting({
    name: "commit",
    label: "Commit",
    fields: [toggle("value", "Commit")],
    effect: NEXT_CHILD,
    confirm: { field: "value", values: ["on"], message: "Agents will commit their changes to Git history." },
    value: (context) => settingsOf(context).commit ?? (autonomyOf(context) === "full" ? "on" : "off")
  }),
  setting({
    name: "push",
    label: "Push",
    fields: [toggle("value", "Push")],
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
    after: (values) => values.mode === "host defaults"
      ? "host defaults"
      : { delivery: values.delivery, review: values.review, securityReview: values.securityReview, ...(values.examples === null ? {} : { examples: values.examples }) }
  })
];

// A gate's answer fields follow its kind: a review approves or asks for changes with a reason, a decision picks an option or explains, and assistance is done.
function gateFields(gate) {
  const note = (extra) => text("note", "Note", NOTE_LIMIT, { multiline: true, ...extra });
  if (gate.kind === "visual-review" || gate.kind === "correctness") {
    return [choice("choice", "Answer", [option("approve", "Approve"), option("request-changes", "Request changes")], { required: true }), note({ requiredWhen: { field: "choice", values: ["request-changes"] } })];
  }
  if (gate.kind === "decision" && Array.isArray(gate.options) && gate.options.length) {
    return [choice("choice", "Answer", gate.options.map((item) => option(item.id, item.label))), note({ requiredWhen: { field: "choice", values: [null] } })];
  }
  if (gate.kind === "decision") return [note({ required: true })];
  return [choice("choice", "Answer", [option("done", "Done")], { required: true }), note()];
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
  confirm: () => null,
  revision: () => null,
  unavailable: (context) => context.indexState === "preparing" ? "An index build is already running." : null,
  after: () => "started"
};

/** Every action, in listing order; a later action joins by adding its definition here. */
const ACTIONS = [...SETTING_ACTIONS, GATE_ANSWER, INDEX_REBUILD];

function view(definition, context) {
  const reason = definition.unavailable(context);
  return {
    id: definition.id,
    label: definition.label,
    group: definition.group,
    target: definition.target(context),
    value: definition.value(context),
    fields: definition.fields(context),
    effect: definition.effect,
    available: reason === null,
    reason,
    confirm: definition.confirm(context),
    revision: definition.revision(context)
  };
}

const definitionsFor = (kind) => ACTIONS.filter((definition) => definition.kinds.includes(kind));

// ---- The default indexer ----

/** Prism's own indexer, which prepares one index for the whole checkout and so serves it as every component's index. */
export const prismIndexer = Object.freeze({
  async status(projectRoot) {
    const [{ readIndexingStatus }, { nativeSemanticRuntime }] = await Promise.all([import("../repository-intelligence/index-status.mjs"), import("../repository-intelligence/native-semantic-runtime.mjs")]);
    return readIndexingStatus(projectRoot, [nativeSemanticRuntime.directory]);
  },
  async rebuild(projectRoot) {
    const { startIndexRebuild } = await import("../repository-intelligence/background-preparation.mjs");
    void startIndexRebuild(projectRoot);
  }
});

// ---- Listing ----

/** The actions that apply to a target: { target, actions }, available or not. */
export async function listActions({ projectRoot, target, indexer = prismIndexer }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const context = await readTarget(projectRoot, parsed, indexer);
  return { target, actions: definitionsFor(parsed.kind).map((definition) => view(definition, context)) };
}

// ---- Input ----

const optionValues = (item) => item.options.map((entry) => entry.value);
const invalid = (name, accepted, message) => fail("invalid_input", message, { field: name, accepted });

// Reads an input against the fields: every value is a listed option, a text within its limit, or empty as null, and every required field is filled.
function readInput(fields, input) {
  if (!isRecord(input)) throw invalid(null, `The input maps field names to values: ${fields.map((item) => item.name).join(", ") || "none"}.`, "The input must be an object of field values.");
  const names = new Set(fields.map((item) => item.name));
  for (const name of Object.keys(input)) {
    if (!names.has(name)) throw invalid(name, fields.length ? `The action has no field ${name}; its fields are ${fields.map((item) => item.name).join(", ")}.` : `The action has no field ${name}; it takes no fields.`, `The action has no field ${name}.`);
  }
  const values = {};
  for (const item of fields) {
    const raw = input[item.name];
    if (item.kind === "text") {
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
  const values = readInput(current.fields, input);
  const after = definition.after(values, context);
  if (current.value !== null && JSON.stringify(after) === JSON.stringify(current.value)) return null;
  if (current.confirm && current.confirm.values.includes(values[current.confirm.field] ?? null) && confirmed !== true) {
    throw fail("confirmation_required", current.confirm.message, { confirm: current.confirm });
  }
  return { current, after };
}

/** Applies one action to a target: { applied, actions }, where applied is the history entry or null for an unchanged value, and actions the target's listing after it. */
export async function applyAction({ projectRoot, target, action, input, revision, confirmed, via = "review-app", indexer = prismIndexer }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const definition = definitionsFor(parsed.kind).find((item) => item.id === action);
  const read = await readTarget(projectRoot, parsed, indexer);
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
  return { applied, actions: (await listActions({ projectRoot, target, indexer })).actions };
}
