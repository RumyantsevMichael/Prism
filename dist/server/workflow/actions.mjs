import { randomBytes } from "node:crypto";
import os from "node:os";
import { listComponents } from "./components.mjs";
import { appendIndexHistory } from "./index-history.mjs";
import { readInitiativeWithClaims } from "./initiative.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { runGit } from "./record-store-sync.mjs";
import { REPOSITORY_NAME } from "./repository-names.mjs";
import { readRoadmap } from "./roadmap.mjs";
import { INITIATIVE_SETTINGS, readCoordinationState, recordPersonAction } from "./state.mjs";
import { ambiguousApprovalMessage, answerArtifactApproval, commentOnArtifact, pendingApprovalGates, storeArtifactTarget } from "./store-artifacts.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
import { checkoutLabel, readWorkspaceIdentity } from "../review/workspace-identity.mjs";

// The review app's actions: one registry of definitions that lists and applies every change a person makes to Prism records from a page.
// The module needs no HTTP, so any transport serves the same registry, and a new action joins by adding a definition below.

const GATE_ID = /^gate-[0-9a-f]{8,32}$/;
const APPROVAL_ID = /^approval-[0-9a-f]{8,32}$/;
const TEXT_LIMIT = 200;
const NOTE_LIMIT = 4000;
// A scope label is workspace, a repository name, or <repository>/<component>, and neither a label nor an artifact path holds a ":".
const SCOPE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const LINE_LIMIT = 16;

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
  match = /^approval:(.+)$/.exec(reference);
  if (match && APPROVAL_ID.test(match[1])) return { kind: "approval", reference, gate: match[1] };
  match = /^artifact:([^:]+):([^:]+)$/.exec(reference);
  if (match && SCOPE_LABEL.test(match[1])) return { kind: "artifact", reference, scope: match[1], path: match[2] };
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

// A store that cannot be used refuses an approval target with its own code and message, as an artifact read is refused, and the review app answers it as unavailable.
const storeRefusal = (error) => fail(error.code, error.message, { unavailable: true });
const storeRefused = (error) => error?.name === "ArtifactError" && typeof error.code === "string";

// The pending approval gates of the requirements and ADRs that the checkout sees whose id is the given one; a project without a store has none.
// More than one names no single gate: a copied status record or a move between scopes that stopped halfway leaves such a copy.
async function pendingApprovals(projectRoot, id) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  const gates = await pendingApprovalGates(projectRoot).catch((error) => {
    if (error?.code === "store_not_configured") return [];
    throw storeRefused(error) ? storeRefusal(error) : error;
  });
  return gates.filter((gate) => gate.id === id);
}

// The store artifact that an artifact target names, as { path, scope, kind, version }, or null; a project without a store holds none.
async function seenArtifact(projectRoot, parsed) {
  return storeArtifactTarget(projectRoot, parsed.scope, parsed.path).catch((error) => {
    throw storeRefused(error) ? storeRefusal(error) : error;
  });
}

// Reads what a target's actions need: the initiative's coordination state and record, the index component, the approval gate, or the store artifact, and refuses a target that does not exist.
async function readTarget(projectRoot, parsed, indexer, state = undefined) {
  if (parsed.kind === "artifact") {
    const artifact = await seenArtifact(projectRoot, parsed);
    if (!artifact) throw unknownTarget(parsed.reference);
    return { ...parsed, artifact };
  }
  if (parsed.kind === "approval") {
    // An approval gate lives in its artifact's status record in the store, so an answered or replaced one is no target.
    const gates = await pendingApprovals(projectRoot, parsed.gate);
    if (!gates.length) throw unknownTarget(parsed.reference);
    return { ...parsed, gateRecord: gates[0], ambiguous: gates.length > 1 ? ambiguousApprovalMessage(parsed.gate, gates) : null };
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
  if (gate.kind === "visual-review" || gate.kind === "correctness" || gate.kind === "approval") {
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

// A requirement's or ADR's approval gate is answered as a review is, against the artifact's current version, and refused while the artifact differs from the version the gate asked about.
const APPROVAL_CHANGED = "The file changed since this approval was asked, so approving it would approve a version nobody asked about. The agent asks again for the current version.";

const APPROVAL_ANSWER = {
  ...GATE_ANSWER,
  kinds: ["approval"],
  effect: "Records your answer; approving sets the file's status, and the agent that asked resumes with it.",
  fields: () => gateFields({ kind: "approval" }),
  context: (context) => context.ambiguous ? null : GATE_ANSWER.context(context),
  recommended: () => null,
  // An id that several pending gates hold names no version to answer against.
  revision: (context) => context.ambiguous ? null : context.gateRecord.current,
  unavailable: (context) => context.ambiguous ?? (context.gateRecord.changed ? APPROVAL_CHANGED : null),
  unavailableCode: (context) => context.ambiguous ? "approval_ambiguous" : "artifact_changed",
  change: undefined
};

// A comment names a line by its number, so it is refused unless it is decimal digits naming a whole number of at least 1.
function commentLine(value) {
  const line = /^[0-9]+$/.test(value ?? "") ? Number(value) : NaN;
  if (!Number.isSafeInteger(line) || line < 1) throw invalid("line", "Decimal digits naming a whole number of at least 1.", "Line must be a whole number of at least 1.");
  return line;
}

// A comment on a store artifact is made against the version the page shows, so a page that read an older version is refused as stale.
const ARTIFACT_COMMENT = {
  id: "artifact.comment",
  kinds: ["artifact"],
  label: "Comment",
  group: "Review",
  effect: "Adds your comment on that line for everyone whose checkout sees this file; the file itself does not change.",
  target: (context) => context.reference,
  fields: () => [text("line", "Line", LINE_LIMIT, { required: true }), text("text", "Comment", NOTE_LIMIT, { required: true, multiline: true })],
  value: () => null,
  context: () => null,
  recommended: () => null,
  confirm: () => null,
  revision: (context) => context.artifact.version,
  unavailable: () => null,
  after: (values, context) => ({ version: context.artifact.version, line: commentLine(values.line), text: values.text })
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

/** Every action, in listing order; a later action joins by adding its definition here. */
const ACTIONS = [...SETTING_ACTIONS, GATE_ANSWER, APPROVAL_ANSWER, ARTIFACT_COMMENT, INDEX_REBUILD];

/** The sentence on when an action's change takes effect, or null for an action the registry does not define. */
export const actionEffect = (id) => ACTIONS.find((definition) => definition.id === id)?.effect ?? null;

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
  if (!current.available) throw fail(definition.unavailableCode?.(context) ?? "action_unavailable", current.reason, { reason: current.reason, current });
  const values = readInput(current.fields, input, definition.ignores ?? (() => []));
  const after = definition.after(values, context);
  if (current.value !== null && sameValue(after, current.value)) return null;
  if (current.confirm && current.confirm.values.includes(values[current.confirm.field] ?? null) && confirmed !== true) {
    throw fail("confirmation_required", current.confirm.message, { confirm: current.confirm });
  }
  return { current, after };
}

/**
 * Applies one action to a target: { applied, actions }, where applied is the history entry or null for an unchanged value, and actions the target's listing after it;
 * an approval's or a comment's result also names its artifact as artifact { path, scope }, since its entry belongs to no initiative.
 */
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
  if (parsed.kind === "approval") {
    // An ambiguous id is refused before any other check, whatever revision and input the request holds.
    if (read.ambiguous) throw fail("approval_ambiguous", read.ambiguous, { reason: read.ambiguous });
    const checked = check(definition, read, request);
    applied = await entryOf(checked, read);
    // An approval records who gave it, so a checkout whose Git names no user is refused rather than recording an anonymous one.
    if (!applied.by.name) throw fail("author_unknown", "Git names no user.name for this checkout, so the answer cannot record who approved; set one with git config user.name and answer again.");
    const gate = read.gateRecord;
    // The store update repeats the gate and version checks under the artifact lock, so a change that lands after the read above is refused, never overwritten.
    await answerArtifactApproval(projectRoot, { path: gate.artifact.path, scope: gate.artifact.scope, id: gate.id, choice: checked.after.choice, note: checked.after.note, by: { name: applied.by.name, host: os.hostname() }, entry: applied }).catch((error) => {
      if (error?.code === "unknown_gate" || error?.code === "gate_answered") throw unknownTarget(target);
      if (error?.code === "artifact_changed") throw fail("artifact_changed", APPROVAL_CHANGED);
      if (error?.code === "invalid_answer") throw fail("invalid_input", error.message, { field: null });
      if (error?.code === "approval_ambiguous") throw fail("approval_ambiguous", error.message, { reason: error.message });
      throw storeRefused(error) ? storeRefusal(error) : error;
    });
  } else if (parsed.kind === "artifact") {
    const checked = check(definition, read, request);
    applied = await entryOf(checked, read);
    // A comment records who wrote it, so a checkout whose Git names no user is refused rather than storing an anonymous one.
    if (!applied.by.name) throw fail("author_unknown", "Git names no user.name for this checkout, so the comment cannot record who wrote it; set one with git config user.name and comment again.");
    // The store write repeats the artifact and version checks under the artifact lock, so a change that lands after the read above is refused as stale.
    const { artifact } = read;
    await commentOnArtifact(projectRoot, { path: artifact.path, label: artifact.scope.label, version: checked.after.version, line: checked.after.line, text: checked.after.text, author: { name: applied.by.name, host: os.hostname().slice(0, 255) }, entry: applied }).catch((error) => {
      if (error?.code === "artifact_not_found") throw unknownTarget(target);
      if (error?.code === "version_conflict") throw fail("stale_revision", "The file changed since the page read it.", { current: view(definition, { ...read, artifact: { ...artifact, version: error.version ?? null } }) });
      throw storeRefused(error) ? storeRefusal(error) : error;
    });
  } else if (parsed.kind === "index") {
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
  // An answered approval gate leaves its artifact's pending gates, so its target has no actions left, and the result names the artifact the answer applied to.
  if (parsed.kind === "approval") return { applied, actions: [], artifact: { path: read.gateRecord.artifact.path, scope: read.gateRecord.artifact.scope } };
  // A comment leaves its artifact unchanged, so the target lists its action again, and the result names the artifact it commented on.
  if (parsed.kind === "artifact") return { applied, actions: [view(definition, read)], artifact: { path: read.artifact.path, scope: read.artifact.scope } };
  return { applied, actions: (await listActions({ projectRoot, target, indexer })).actions };
}
