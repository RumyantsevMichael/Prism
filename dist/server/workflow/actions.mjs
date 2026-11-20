// Generated from src/server/workflow/actions.mts by scripts/native-build/compile.mjs.
import { randomBytes } from "node:crypto";
import os from "node:os";
import { realpath } from "node:fs/promises";
import { listComponents } from "./components.mjs";
import { appendIndexHistory } from "./index-history.mjs";
import { readInitiativeWithClaims } from "./initiative.mjs";
import { SLUG_PATTERN } from "./initiative-graph.mjs";
import { isStoreWithoutCheckout, recordStoreOf } from "./record-store.mjs";
import { runGit } from "./record-store-sync.mjs";
import { REPOSITORY_NAME } from "./repository-names.mjs";
import { readRoadmap } from "./roadmap.mjs";
import { shippedActionReason, shippedDecision } from "./shipped-history.mjs";
import { earlierReason, INITIATIVE_SETTINGS, readCoordinationState, recordPersonAction, validEarlierName } from "./state.mjs";
import { ambiguousApprovalMessage, answerArtifactApproval, commentOnArtifact, pendingApprovalGates, storeArtifactTarget } from "./store-artifacts.mjs";
import { readWorkflowConfig } from "./workflow-config.mjs";
import { checkoutLabel, readWorkspaceIdentity } from "../review/workspace-identity.mjs";
import { confirmLaunch } from "../session/launch-confirmation.mjs";
import { HOSTS, hostDefinition } from "../session/launch-hosts.mjs";
import { LAUNCH_ID_PATTERN } from "../session/launch-records.mjs";
import { AUTOMATIC, AUTOMATIC_LABEL, PrismRunsError, readPrismRunsChoice, writePrismRunsChoice } from "../session/prism-runs.mjs";
import { choiceReasons, nameRuleBreach, NAME_RULE_MESSAGES, readRunOptions, RUN_KINDS, validProvider } from "../session/run-options.mjs";
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
const GATE_ID = /^gate-[0-9a-f]{8,32}$/;
const APPROVAL_ID = /^approval-[0-9a-f]{8,32}$/;
const NOTE_LIMIT = 4e3;
const SCOPE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const LINE_LIMIT = 16;
class ActionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    Object.assign(this, details);
  }
}
const fail = (code, message, details) => new ActionError(code, message, details);
const order = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const option = (value, label, consequence = null) => ({ value, label, consequence });
function field(name, kind, label, extra = {}) {
  return { name, kind, label, options: null, required: false, requiredWhen: null, maxLength: null, multiline: null, ...extra };
}
const choice = (name, label, options, extra = {}) => field(name, "choice", label, { options, ...extra });
const toggle = (name, label, off, on) => field(name, "toggle", label, { options: [option("off", "Off", off), option("on", "On", on)], required: true });
const text = (name, label, maxLength, extra = {}) => field(name, "text", label, { maxLength, multiline: false, ...extra });
const MACHINE_TARGETS = ["machine:prism-runs"];
function parseTarget(reference) {
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
  match = /^launch:(.+)$/.exec(reference);
  if (match && LAUNCH_ID_PATTERN.test(match[1])) return { kind: "launch", reference, launch: match[1] };
  match = /^index:([^/]+)\/([^/]+)$/.exec(reference);
  if (match && REPOSITORY_NAME.test(match[1]) && REPOSITORY_NAME.test(match[2])) return { kind: "index", reference, identity: `${match[1]}/${match[2]}` };
  if (MACHINE_TARGETS.includes(reference)) return { kind: "machine", reference, machine: reference.slice("machine:".length) };
  return null;
}
const unknownTarget = (reference) => fail("unknown_target", `No action target ${JSON.stringify(String(reference ?? ""))} exists on this page.`);
async function checkoutComponents(root) {
  const config = await readWorkflowConfig(root);
  const listed = listComponents(config);
  const repository = listed.repository ?? "root";
  if (listed.problem || listed.declared.length === 0) return [{ identity: `${repository}/${repository}`, folder: "", root }];
  return listed.declared.map((component) => ({ identity: component.component, folder: component.folder, root }));
}
async function indexComponents(projectRoot, checkouts = null) {
  if (checkouts === null) return checkoutComponents(projectRoot);
  const byRepository = /* @__PURE__ */ new Map();
  for (const root of checkouts) {
    const components = await checkoutComponents(root).catch(() => []);
    const repository = components[0]?.identity.split("/")[0];
    if (repository && !byRepository.has(repository)) byRepository.set(repository, components);
  }
  return [...byRepository].sort(([left], [right]) => order(left, right)).flatMap(([, components]) => components);
}
async function listActionTargets({ projectRoot, kind, checkouts = null }) {
  if (kind !== "index") throw fail("unknown_target", "Only index targets are listed.");
  return { targets: (await indexComponents(projectRoot, checkouts)).map((component) => `index:${component.identity}`) };
}
async function initiativeExists(projectRoot, initiative, record) {
  if (record) return true;
  const roadmap = await readRoadmap(projectRoot).catch(() => null);
  return Boolean(roadmap?.loaded?.record?.initiatives?.some((item) => item.id === initiative));
}
const storeRefusal = (error) => fail(error.code, error.message, { unavailable: true });
const storeRefused = (error) => error?.name === "ArtifactError" && typeof error.code === "string";
async function pendingApprovals(projectRoot, id) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  const gates = await pendingApprovalGates(projectRoot).catch((error) => {
    if (error?.code === "store_not_configured") return [];
    throw storeRefused(error) ? storeRefusal(error) : error;
  });
  return gates.filter((gate) => gate.id === id);
}
async function seenArtifact(projectRoot, parsed) {
  return storeArtifactTarget(projectRoot, parsed.scope, parsed.path).catch((error) => {
    throw storeRefused(error) ? storeRefusal(error) : error;
  });
}
async function readTarget(projectRoot, parsed, indexer, state = void 0, env = process.env, checkouts = null, readOptions = null) {
  if (parsed.kind === "artifact") {
    const artifact = await seenArtifact(projectRoot, parsed);
    if (!artifact) throw unknownTarget(parsed.reference);
    return { ...parsed, artifact };
  }
  if (parsed.kind === "approval") {
    const gates = await pendingApprovals(projectRoot, parsed.gate);
    if (!gates.length) throw unknownTarget(parsed.reference);
    return { ...parsed, gateRecord: gates[0], ambiguous: gates.length > 1 ? ambiguousApprovalMessage(parsed.gate, gates) : null };
  }
  if (parsed.kind === "launch") {
    const view2 = (await listLaunches({ projectRoot, env })).launches.find((item) => item.id === parsed.launch);
    if (!view2) throw unknownTarget(parsed.reference);
    const status = await launchRunStatus({ id: parsed.launch, env });
    const resumeReason = status === "running" ? "The session is running." : await resumeRefusal({ id: parsed.launch, env });
    const shipped2 = await shippedDecision(projectRoot, view2.initiative).catch(() => null);
    return { ...parsed, view: view2, initiative: view2.initiative, running: status === "running", resumeReason, shipped: shipped2 };
  }
  if (parsed.kind === "machine") {
    return { ...parsed, prismRuns: await readPrismRunsChoice(env), hosts: await hostAvailability({ env }), readOptions: readOptions ?? runOptionsReader(projectRoot, env) };
  }
  if (parsed.kind === "index") {
    const component = (await indexComponents(projectRoot, checkouts)).find((item) => item.identity === parsed.identity);
    if (!component) throw unknownTarget(parsed.reference);
    const status = await Promise.resolve(indexer.status(component.root, component)).catch(() => null);
    return { ...parsed, component, indexState: status?.state ?? null };
  }
  const coordination = state ?? await readCoordinationState({ projectRoot, initiative: parsed.initiative }).then((read) => ({ exists: read.exists, revision: read.revision, state: read.state, valid: read.valid }));
  const { loaded } = await readInitiativeWithClaims(projectRoot, parsed.initiative).catch(() => ({ loaded: { exists: false, record: null } }));
  const record = loaded.exists ? loaded.record : null;
  const shipped = await shippedDecision(projectRoot, parsed.initiative).catch(() => null);
  const context = { ...parsed, coordination, record, shipped, initiativeTarget: `initiative:${parsed.initiative}` };
  if (parsed.kind === "initiative" && !await initiativeExists(projectRoot, parsed.initiative, record)) throw unknownTarget(parsed.reference);
  if (parsed.kind === "initiative" || parsed.kind === "slice") {
    context.hosts = await hostAvailability({ env });
    context.readOptions = readOptions ?? runOptionsReader(projectRoot, env);
  }
  if (parsed.kind === "initiative") context.launchRunning = await initiativeRunning({ projectRoot, initiative: parsed.initiative, env });
  if (parsed.kind === "slice" && !(record?.slices && Object.hasOwn(record.slices, parsed.slice))) throw unknownTarget(parsed.reference);
  if (parsed.kind === "gate") {
    const gate = (coordination.state?.pending ?? []).find((item) => isRecord(item) && item.id === parsed.gate);
    if (!gate) throw unknownTarget(parsed.reference);
    context.gateRecord = gate;
  }
  return context;
}
const settingsOf = (context) => (context.coordination.valid ? context.coordination.state?.settings : null) ?? {};
function setting({ name, label, fields, effect, confirm = null, value, stored = null, after = (values) => values.value, ignores = () => [] }) {
  return {
    id: `initiative.${name}`,
    kinds: ["initiative", "slice"],
    label,
    group: "Initiative settings",
    effect,
    target: (context) => context.initiativeTarget,
    fields: typeof fields === "function" ? fields : () => fields,
    value,
    ...stored ? { stored } : {},
    context: () => null,
    recommended: () => null,
    confirm: () => confirm,
    revision: (context) => context.coordination.revision,
    unavailable: () => null,
    ignores,
    after,
    change: (context, after2) => ({ setting: { name, value: after2 } })
  };
}
const NEXT_AGENT = "Applies to agents started after the change.";
const autonomyOf = (context) => settingsOf(context).autonomy ?? "conservative";
function hostOptions(context, consequence) {
  return HOSTS.map(({ host, label }) => {
    const availability = context.hosts?.find((item) => item.host === host);
    return { value: host, label, consequence: consequence(label), reason: availability?.available ? null : availability?.reason ?? `${label} was not found.` };
  });
}
const firstFoundHost = (context) => context.hosts?.find((item) => item.available)?.host ?? null;
const HOST_DEFAULT_CHOICE = Object.freeze({ model: null, effort: null, typed: false });
function fullEntry(stored) {
  const entry = isRecord(stored) ? stored : {};
  const choiceOf = (value) => {
    if (!isRecord(value)) return { ...HOST_DEFAULT_CHOICE };
    if (typeof value.earlier === "string") return { ...HOST_DEFAULT_CHOICE, earlier: value.earlier };
    return { model: value.model ?? null, effort: value.effort ?? null, typed: value.typed === true };
  };
  return { provider: typeof entry.provider === "string" ? entry.provider : null, ...Object.fromEntries(RUN_KINDS.map(({ kind }) => [kind, choiceOf(entry[kind])])) };
}
const modelsOf = (context) => {
  const stored = isRecord(settingsOf(context).models) ? settingsOf(context).models : {};
  return Object.fromEntries(HOSTS.map(({ host }) => [host, fullEntry(stored[host])]));
};
function compactModels(value) {
  const compact = {};
  for (const [host, entry] of Object.entries(value)) {
    const kept = {};
    if (entry.provider !== null) kept.provider = entry.provider;
    for (const { kind } of RUN_KINDS) {
      const choice2 = entry[kind];
      if (typeof choice2.earlier === "string") {
        kept[kind] = { earlier: choice2.earlier };
        continue;
      }
      const part = { ...choice2.model === null ? {} : { model: choice2.model }, ...choice2.effort === null ? {} : { effort: choice2.effort }, ...choice2.typed ? { typed: true } : {} };
      if (Object.keys(part).length) kept[kind] = part;
    }
    if (Object.keys(kept).length) compact[host] = kept;
  }
  return compact;
}
function runOptionsReader(projectRoot, env) {
  const reads = /* @__PURE__ */ new Map();
  return (selection) => {
    const key = JSON.stringify(selection);
    if (!reads.has(key)) reads.set(key, readRunOptions({ ...selection, checkout: projectRoot, env }));
    return reads.get(key);
  };
}
const optionOf = (report, id) => report.options.find((item) => item.id === id) ?? null;
const RUN_CHOICE_HINTS = {
  coordinator: "Only coordinates: it plans the order of work, starts the agents below and asks you at gates. It writes no code.",
  designImplementation: "Writes each slice's design, tests and code.",
  codeReview: "Reviews each finished slice.",
  securityReview: "Reviews slices that touch access, secrets or other trust boundaries.",
  gateSummary: "Turns the design's tests into the short summaries you read at the design gate."
};
const PROVIDER_HINT = "Where the host sends its model requests; only some hosts offer a choice.";
function modelsFields(context) {
  return [
    choice("host", "Host", hostOptions(context, (label) => `Shows and changes the choices kept for ${label}.`), { required: true }),
    field("provider", "run-option", "Provider", { for: "coordinator", option: "provider", hint: PROVIDER_HINT }),
    ...RUN_KINDS.map(({ kind, label, purpose }) => field(kind, "run-choice", label, { for: purpose, hint: RUN_CHOICE_HINTS[kind] }))
  ];
}
async function checkHostChoices(context, { host, provider, choices }, refuse) {
  const { label } = hostDefinition(host);
  const missing = hostOptions(context, () => "").find((item) => item.value === host)?.reason;
  if (missing) throw refuse("host", missing);
  if (provider !== null) {
    if (!validProvider(provider)) throw refuse("provider", NAME_RULE_MESSAGES.provider);
    const base = await context.readOptions({ host, purpose: "coordinator" });
    if (base.state === "unavailable") throw refuse("host", base.reason);
    if (!optionOf(base, "provider")?.values.some((item) => item.value === provider)) throw refuse("provider", choiceReasons.provider(label, provider));
  }
  for (const { name, purpose, choice: choice2 } of choices) {
    if (choice2.earlier !== void 0) throw refuse(name, earlierReason(label, choice2.earlier));
    if (choice2.typed && choice2.model === null) throw refuse(name, "Only a model name can be typed.");
    const breach = nameRuleBreach({ model: choice2.model, effort: choice2.effort });
    if (breach) throw refuse(name, breach.message);
    if (choice2.effort === null && (choice2.model === null || choice2.typed)) continue;
    const report = await context.readOptions({ host, purpose, provider, model: choice2.model, effort: choice2.effort, typed: choice2.typed });
    if (report.state === "unavailable") throw refuse("host", report.reason);
    for (const id of ["model", "effort"]) {
      const chosen = optionOf(report, id)?.chosen;
      if (chosen?.state === "not-offered") throw refuse(name, chosen.reason);
    }
  }
}
const refuseChoice = (name, message) => invalid(name, "A value that the host reports, the host default, or a model name typed as such.", message);
async function checkedModels(values, context) {
  const { host, provider } = values;
  const choices = RUN_KINDS.map(({ kind, purpose }) => ({ name: kind, purpose, choice: values[kind] ?? HOST_DEFAULT_CHOICE }));
  await checkHostChoices(context, { host, provider, choices }, refuseChoice);
  const after = modelsOf(context);
  after[host] = { provider, ...Object.fromEntries(RUN_KINDS.map(({ kind }) => [kind, values[kind] ?? { ...HOST_DEFAULT_CHOICE }])) };
  return after;
}
const SETTING_DEFINITIONS = [
  setting({
    name: "host",
    label: "Host",
    fields: (context) => [choice("value", "Host", hostOptions(context, (label) => `${label} runs the launched session and its agents.`), { required: true })],
    effect: "Launches started after the change run on this host; a running or resumed session keeps the host it started on.",
    // With no host stored, the first host this computer finds shows, and choosing it still stores it as the person's.
    value: (context) => settingsOf(context).host ?? firstFoundHost(context),
    stored: (context) => settingsOf(context).host ?? null,
    after: (values, context) => {
      const chosen = hostOptions(context, () => "").find((item) => item.value === values.value);
      if (chosen?.reason) throw invalid("value", HOSTS.map(({ host }) => host), chosen.reason);
      return values.value;
    }
  }),
  setting({
    name: "autonomy",
    label: "Autonomy",
    fields: [choice("value", "Autonomy", [
      option("conservative", "Conservative", "You approve every design and answer every decision."),
      option("broad", "Broad", "Designs that change no requirement, add no decision record and raise no open question are accepted without you; you answer the rest."),
      option("full", "Full", "Agents accept every design and settle internal decisions without you; they never turn on Push.")
    ], { required: true })],
    effect: "Decides which later gates wait for you; a gate already open keeps waiting for you.",
    confirm: { field: "value", values: ["full"], message: "Agents will accept every design and resolve internal decisions without you." },
    value: autonomyOf
  }),
  setting({
    name: "commit",
    label: "Commit",
    fields: [toggle("value", "Commit", "Agents leave their changes uncommitted.", "Agents commit their changes to Git history.")],
    effect: NEXT_AGENT,
    confirm: { field: "value", values: ["on"], message: "Agents will commit their changes to Git history." },
    value: (context) => settingsOf(context).commit ?? (autonomyOf(context) === "full" ? "on" : "off")
  }),
  setting({
    name: "push",
    label: "Push",
    fields: [toggle("value", "Push", "Finished slices stay on this machine.", "Agents push finished slices beyond this machine.")],
    effect: NEXT_AGENT,
    confirm: { field: "value", values: ["on"], message: "Agents will push finished slices beyond this machine." },
    value: (context) => settingsOf(context).push ?? "off"
  }),
  setting({
    name: "continuation",
    label: "Continuation",
    fields: [choice("value", "Continuation", [
      option("auto", "Automatic", "The next slice starts as soon as one finishes."),
      option("stepwise", "Stepwise", "The run stops after each slice until you continue it.")
    ], { required: true })],
    effect: "Whether the next slice starts by itself; applies when the slice in progress finishes.",
    value: (context) => settingsOf(context).continuation ?? "auto"
  }),
  setting({
    name: "review",
    label: "Review",
    fields: [choice("value", "Review", [
      option("marked", "Marked slices", "Only slices you mark for review at the design gate."),
      option("recommended", "Recommended slices", "Slices you mark, plus those the design recommends reviewing."),
      option("all", "All slices", "Every slice gets a code review.")
    ], { required: true })],
    effect: "Which slices get a code review before they count as done; a slice whose design is already accepted keeps its review.",
    value: (context) => settingsOf(context).review ?? "marked"
  }),
  {
    ...setting({
      name: "models",
      label: "Models",
      fields: modelsFields,
      effect: "The coordinator's model and effort apply to launches started after the change, and each agent's to agents started after it; a running session or agent keeps its own.",
      value: modelsOf,
      after: checkedModels
    }),
    change: (context, after) => ({ setting: { name: "models", value: compactModels(after) } })
  }
];
const SETTING_ACTIONS = SETTING_DEFINITIONS.filter((definition) => INITIATIVE_SETTINGS.includes(definition.id.slice("initiative.".length)));
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
  change: void 0
};
function commentLine(value) {
  const line = /^[0-9]+$/.test(value ?? "") ? Number(value) : NaN;
  if (!Number.isSafeInteger(line) || line < 1) throw invalid("line", "Decimal digits naming a whole number of at least 1.", "Line must be a whole number of at least 1.");
  return line;
}
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
const hostList = (labels) => labels.length > 2 ? `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}` : labels.join(" and ");
const NO_HOST = `No host that Prism supports was found on this computer. Prism supports ${hostList(HOSTS.map(({ label }) => label))}.`;
const launchHostOf = (context) => settingsOf(context).host ?? firstFoundHost(context);
const UNREADABLE_STATE = "This initiative's saved settings cannot be read, so Prism cannot tell which host, models, and efforts to launch with.";
const notOffered = (label, reason) => fail("choice_not_offered", `${label}: ${reason}`);
async function checkedLaunchChoices(context, host) {
  const { label } = hostDefinition(host);
  const entry = modelsOf(context)[host];
  const { provider } = entry;
  const report = async (fieldLabel, selection) => {
    const read = await context.readOptions({ host, ...selection });
    if (read.state === "unavailable") throw fail("host_unavailable", read.reason);
    if (read.state === "failed") throw notOffered(fieldLabel, read.reason);
    return read;
  };
  if (provider !== null) {
    const base = await report("Provider", { purpose: "coordinator" });
    if (!optionOf(base, "provider")?.values.some((item) => item.value === provider)) throw notOffered("Provider", choiceReasons.provider(label, provider));
  }
  for (const { kind, label: kindLabel, purpose } of RUN_KINDS) {
    const choice2 = entry[kind];
    if (choice2.earlier !== void 0) throw notOffered(kindLabel, earlierReason(label, choice2.earlier));
    if (choice2.effort === null && (choice2.model === null || choice2.typed)) continue;
    const read = await report(kindLabel, { purpose, provider, model: choice2.model, effort: choice2.effort, typed: choice2.typed });
    for (const id of ["model", "effort"]) {
      const chosen = optionOf(read, id)?.chosen;
      if (chosen?.state === "not-offered") throw notOffered(kindLabel, chosen.reason);
    }
  }
  const { model, effort, typed } = entry.coordinator;
  return { provider, model, effort, typed };
}
const LAUNCH_RUN = {
  ...launchBase,
  id: "launch.run",
  kinds: ["initiative"],
  label: "Launch",
  effect: "Starts a headless session of this initiative's host on this computer with its settings; you confirm it outside the browser unless you confirmed in the last 30 minutes.",
  target: (context) => context.initiativeTarget,
  unavailable: (context) => {
    if (!context.hosts.some((item) => item.available)) return NO_HOST;
    if (context.coordination.exists && !context.coordination.valid) return UNREADABLE_STATE;
    const host = launchHostOf(context);
    const availability = context.hosts.find((item) => item.host === host);
    if (!availability?.available) return availability?.reason ?? `${hostDefinition(host)?.label ?? host} was not found.`;
    return context.launchRunning ? launchRunningMessage(context.initiative) : null;
  },
  after: () => null,
  async launch({ projectRoot, context, env }) {
    const host = launchHostOf(context);
    const coordinator = await checkedLaunchChoices(context, host);
    const checkout = await realpath(projectRoot);
    await confirmLaunch({ initiative: context.initiative, host, checkout, env });
    const { launch } = await startLaunch({ projectRoot: checkout, initiative: context.initiative, host, coordinator, env });
    const { provider, model, effort } = coordinator;
    return { launch, after: { launch: launch.id, host, coordinator: { provider, model, effort } }, initiative: context.initiative, started: launch.id };
  }
};
const LAUNCH_STOP = {
  ...launchBase,
  id: "launch.stop",
  kinds: ["launch"],
  label: "Stop",
  effect: "Interrupts the host's turn as the host's own Stop button does, and ends the host process if it still runs after the grace period.",
  target: (context) => context.reference,
  // The shipped state never decides a stop.
  ownsShipped: true,
  unavailable: (context) => context.running ? null : "The session is not running.",
  after: () => null,
  async launch({ projectRoot, context, env }) {
    const launch = await stopLaunch({ id: context.launch, env });
    const shipped = await shippedDecision(projectRoot, context.initiative).catch(() => null);
    return { launch, after: "stopped", initiative: context.initiative, started: null, record: !shipped };
  }
};
const LAUNCH_RESUME = {
  ...launchBase,
  id: "launch.resume",
  kinds: ["launch"],
  label: "Resume",
  effect: "Starts the host session again headless; you confirm it outside the browser unless you confirmed in the last 30 minutes.",
  target: (context) => context.reference,
  ownsShipped: true,
  unavailable: (context) => {
    if (context.running) return "The session is running.";
    return context.shipped ? shippedActionReason(context.shipped) : context.resumeReason;
  },
  after: () => null,
  async launch({ projectRoot, context, env }) {
    await confirmLaunch({ initiative: context.view.initiative, host: context.view.host, checkout: context.view.checkout, env });
    const shipped = await shippedDecision(projectRoot, context.initiative).catch(() => null);
    if (shipped) throw fail("action_unavailable", shippedActionReason(shipped), { reason: shippedActionReason(shipped) });
    const launch = await resumeLaunch({ id: context.launch, env, cause: "person" });
    return { launch, after: { launch: launch.id, run: launch.runs }, initiative: context.initiative, started: launch.id };
  }
};
const AUTOMATIC_ONLY_DEFAULTS = "Any available host takes only the host's default model.";
const UNREADABLE_PRISM_RUNS = "The stored choice could not be read, so each run starts on the first host Prism finds with its default model until you apply a host.";
const prismRunsValue = (context) => {
  const { state, choice: choice2 } = context.prismRuns;
  if (state === "unreadable") return { host: null, provider: null, run: { ...HOST_DEFAULT_CHOICE } };
  if (state !== "chosen") return { host: AUTOMATIC, provider: null, run: { ...HOST_DEFAULT_CHOICE } };
  return { host: choice2.host, provider: choice2.provider, run: { model: choice2.model, effort: choice2.effort, typed: choice2.typed } };
};
const MACHINE_PRISM_RUNS = {
  id: "machine.prismRuns",
  kinds: ["machine"],
  label: "Prism's own runs",
  group: "This computer",
  effect: "Prism's own runs on this computer, such as moving records to a new format, start with this host and model; a run already started keeps its own.",
  target: (context) => context.reference,
  fields: (context) => [
    choice("host", "Host", [
      { value: AUTOMATIC, label: AUTOMATIC_LABEL, consequence: "Each run starts on the first host Prism finds on this computer, with its default model.", reason: null },
      ...hostOptions(context, (label) => `${label} runs Prism's own runs.`)
    ], { required: true, ...context.prismRuns.state === "unreadable" ? { hint: UNREADABLE_PRISM_RUNS } : {} }),
    field("provider", "run-option", "Provider", { for: "coordinator", option: "provider", hint: PROVIDER_HINT, fixedWhen: { field: "host", values: [AUTOMATIC] } }),
    field("run", "run-choice", "Model", { for: "coordinator", heading: "Model of Prism's own runs", hint: "The model and effort of each run, from what the host reports.", fixedWhen: { field: "host", values: [AUTOMATIC] } })
  ],
  value: prismRunsValue,
  // A change is compared with the value only while that value is stored or is the default of no choice, never an unreadable one.
  stored: (context) => context.prismRuns.state === "unreadable" ? null : prismRunsValue(context),
  context: () => null,
  recommended: () => null,
  confirm: () => null,
  revision: (context) => context.prismRuns.revision,
  unavailable: () => null,
  async after(values, context) {
    const { host, provider, run } = values;
    if (host === AUTOMATIC) {
      if (provider !== null) throw refuseChoice("provider", AUTOMATIC_ONLY_DEFAULTS);
      if (run.model !== null || run.effort !== null || run.typed) throw refuseChoice("run", AUTOMATIC_ONLY_DEFAULTS);
      return { host, provider: null, run: { ...HOST_DEFAULT_CHOICE } };
    }
    await checkHostChoices(context, { host, provider, choices: [{ name: "run", purpose: "coordinator", choice: run }] }, refuseChoice);
    return { host, provider, run: { model: run.model, effort: run.effort, typed: run.typed } };
  }
};
const ACTIONS = [...SETTING_ACTIONS, LAUNCH_RUN, GATE_ANSWER, APPROVAL_ANSWER, ARTIFACT_COMMENT, INDEX_REBUILD, LAUNCH_STOP, LAUNCH_RESUME, MACHINE_PRISM_RUNS];
const actionEffect = (id) => ACTIONS.find((definition) => definition.id === id)?.effect ?? null;
function view(definition, context) {
  const reason = context.shipped && !definition.ownsShipped ? shippedActionReason(context.shipped) : definition.unavailable(context);
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
function componentIndexingStatus(status, component) {
  if (!Array.isArray(status?.components)) return status;
  return { state: status.components.find((entry) => entry.component === component?.identity)?.state ?? "none" };
}
const prismIndexer = Object.freeze({
  async status(projectRoot, component) {
    const [{ readIndexingStatus }, { nativeSemanticRuntime }] = await Promise.all([import("../repository-intelligence/index-status.mjs"), import("../repository-intelligence/native-semantic-runtime.mjs")]);
    return componentIndexingStatus(await readIndexingStatus(projectRoot, [nativeSemanticRuntime.directory]), component);
  },
  async rebuild(projectRoot, component) {
    const { startIndexRebuild } = await import("../repository-intelligence/background-preparation.mjs");
    void startIndexRebuild(projectRoot, { component: { identity: component.identity, folder: component.folder } });
  }
});
async function listActions({ projectRoot, target, indexer = prismIndexer, env = process.env, checkouts = null }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const context = await readTarget(projectRoot, parsed, indexer, void 0, env, checkouts);
  return { target, actions: definitionsFor(parsed.kind).map((definition) => view(definition, context)) };
}
const optionValues = (item) => item.options.map((entry) => entry.value);
const invalid = (name, accepted, message) => fail("invalid_input", message, { field: name, accepted });
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
    if (item.kind === "run-option" || item.kind === "run-choice") {
      values[item.name] = item.kind === "run-option" ? runOptionInput(item, raw) : runChoiceInput(item, raw);
    } else if (item.kind === "text") {
      ignored ??= new Set(ignores(values));
      if (ignored.has(item.name)) {
        values[item.name] = null;
        continue;
      }
      const accepted = `Text of at most ${item.maxLength} characters.`;
      if (raw !== void 0 && raw !== null && typeof raw !== "string") throw invalid(item.name, accepted, `${item.label} must be text.`);
      if (typeof raw === "string" && raw.length > item.maxLength) throw invalid(item.name, accepted, `${item.label} takes at most ${item.maxLength} characters.`);
      values[item.name] = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    } else {
      if (raw === void 0 || raw === null || raw === "") {
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
    const required = item.required || when !== null && when.values.includes(values[when.field] ?? null);
    if (required && values[item.name] === null) {
      throw invalid(item.name, item.kind === "text" ? `Fill in ${item.label}.` : optionValues(item), `Fill in ${item.label}.`);
    }
  }
  return values;
}
function runOptionInput(item, raw) {
  if (raw === void 0 || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw invalid(item.name, "A name, or null for the host default.", `${item.label} must be a name or the host default.`);
  return raw;
}
function runChoiceInput(item, raw) {
  const accepted = "{ model, effort, typed } with model and effort a name or null and typed true or false, or null for the host default.";
  if (raw === void 0 || raw === null) return { model: null, effort: null, typed: false };
  const malformed = () => invalid(item.name, accepted, `${item.label} must be a model, an effort, and whether the model was typed.`);
  const parts = item.for === "agents" ? ["model", "effort", "typed", "earlier"] : ["model", "effort", "typed"];
  if (!isRecord(raw) || Object.keys(raw).some((key) => !parts.includes(key))) throw malformed();
  if (raw.earlier !== void 0 && !validEarlierName(raw.earlier)) throw malformed();
  const part = (value) => {
    if (value === void 0 || value === null || value === "") return null;
    if (typeof value !== "string") throw malformed();
    return value;
  };
  if (raw.typed !== void 0 && typeof raw.typed !== "boolean") throw malformed();
  return { model: part(raw.model), effort: part(raw.effort), typed: raw.typed === true, ...raw.earlier === void 0 ? {} : { earlier: raw.earlier } };
}
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
async function authorOf(projectRoot, { store = false } = {}) {
  const clone = store ? await recordStoreOf(projectRoot).then((found) => found.external ? found.base : null, () => null) : null;
  const read = async (where2, key) => {
    const result = await runGit(where2, ["config", key]);
    const value = result.ok ? result.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return value || null;
  };
  const where = clone && await read(clone, "user.name") ? clone : projectRoot;
  const checkoutless = await isStoreWithoutCheckout(projectRoot);
  const [name, email, identity] = await Promise.all([read(where, "user.name"), read(where, "user.email"), checkoutless ? { repository: "review app", worktree: null, branch: null, detached: false } : readWorkspaceIdentity(projectRoot)]);
  return { name, email, checkout: checkoutLabel(identity).slice(0, 400) };
}
async function check(definition, context, { revision, input, confirmed }) {
  const current = view(definition, context);
  if ((revision ?? null) !== current.revision) throw fail("stale_revision", "The record changed since the page read it.", { current });
  if (!current.available) throw fail(definition.unavailableCode?.(context) ?? "action_unavailable", current.reason, { reason: current.reason, current });
  const values = readInput(current.fields, input, definition.ignores ?? (() => []));
  const after = await definition.after(values, context);
  const unchanged = definition.stored ? definition.stored(context) : current.value;
  if (unchanged !== null && sameValue(after, unchanged)) return null;
  if (current.confirm && current.confirm.values.includes(values[current.confirm.field] ?? null) && confirmed !== true) {
    throw fail("confirmation_required", current.confirm.message, { confirm: current.confirm });
  }
  return { current, after };
}
async function applyAction({ projectRoot, target, action, input, revision, confirmed, via = "review-app", indexer = prismIndexer, env = process.env, checkouts = null }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const definition = definitionsFor(parsed.kind).find((item) => item.id === action);
  const readOptions = runOptionsReader(projectRoot, env);
  const read = await readTarget(projectRoot, parsed, indexer, void 0, env, checkouts, readOptions);
  if (!definition) throw fail("unknown_action", `The target ${target} has no action ${JSON.stringify(String(action ?? ""))}.`);
  const request = { revision, input, confirmed };
  const entryOf = async (checked, context) => ({
    id: randomBytes(16).toString("hex"),
    action: definition.id,
    target: checked.current.target,
    before: checked.current.value,
    after: checked.after,
    at: (/* @__PURE__ */ new Date()).toISOString(),
    by: await authorOf(projectRoot, { store: parsed.kind === "artifact" }),
    via: typeof via === "string" && via ? via : "review-app"
  });
  if (definition.launch) return applyLaunchAction({ projectRoot, definition, context: read, request, entryOf, env, target, indexer, checkouts });
  let applied = null;
  let stored = null;
  if (parsed.kind === "approval") {
    if (read.ambiguous) throw fail("approval_ambiguous", read.ambiguous, { reason: read.ambiguous });
    const checked = await check(definition, read, request);
    applied = await entryOf(checked, read);
    if (!applied.by.name) throw fail("author_unknown", "Git names no user.name for this checkout, so the answer cannot record who approved; set one with git config user.name and answer again.");
    const gate = read.gateRecord;
    await answerArtifactApproval(projectRoot, { path: gate.artifact.path, scope: gate.artifact.scope, id: gate.id, choice: checked.after.choice, note: checked.after.note, by: { name: applied.by.name, host: os.hostname() }, entry: applied }).catch((error) => {
      if (error?.code === "unknown_gate" || error?.code === "gate_answered") throw unknownTarget(target);
      if (error?.code === "artifact_changed") throw fail("artifact_changed", APPROVAL_CHANGED);
      if (error?.code === "invalid_answer") throw fail("invalid_input", error.message, { field: null });
      if (error?.code === "approval_ambiguous") throw fail("approval_ambiguous", error.message, { reason: error.message });
      throw storeRefused(error) ? storeRefusal(error) : error;
    });
  } else if (parsed.kind === "artifact") {
    const checked = await check(definition, read, request);
    applied = await entryOf(checked, read);
    if (!applied.by.name) throw fail("author_unknown", "Git names no user.name for this checkout, so the comment cannot record who wrote it; set one with git config user.name and comment again.");
    const { artifact } = read;
    stored = await commentOnArtifact(projectRoot, { path: artifact.path, location: artifact.location ?? null, label: artifact.scope.label, version: checked.after.version, line: checked.after.line, text: checked.after.text, author: { name: applied.by.name, host: os.hostname().slice(0, 255) }, entry: applied }).catch((error) => {
      if (error?.code === "artifact_not_found") throw unknownTarget(target);
      if (error?.code === "comment_limit") throw fail("comment_limit", error.message);
      if (error?.code === "version_conflict") throw fail("stale_revision", "The file changed since the page read it.", { current: view(definition, { ...read, artifact: { ...artifact, version: error.version ?? null } }) });
      throw storeRefused(error) ? storeRefusal(error) : error;
    });
  } else if (parsed.kind === "machine") {
    const checked = await check(definition, read, request);
    if (checked) {
      applied = await entryOf(checked, read);
      const { host, provider, run } = checked.after;
      await writePrismRunsChoice({ choice: { host, provider, ...run }, by: applied.by.name ?? applied.by.checkout, revision: read.prismRuns.revision, env }).catch(async (error) => {
        if (error instanceof PrismRunsError && error.code === "not_a_file") throw fail("invalid_input", error.message, { field: null });
        if (error instanceof PrismRunsError && error.code === "stale_revision") {
          const current = view(definition, await readTarget(projectRoot, parsed, indexer, void 0, env, checkouts, readOptions));
          throw fail("stale_revision", "The choice changed since the page read it.", { current });
        }
        throw error;
      });
    }
  } else if (parsed.kind === "index") {
    const checked = await check(definition, read, request);
    if (checked) {
      applied = await entryOf(checked, read);
      await indexer.rebuild(read.component.root, read.component);
      await appendIndexHistory(read.component.root, applied);
    }
  } else {
    const written = await recordPersonAction({ projectRoot, initiative: parsed.initiative, prepare: async (coordination) => {
      const context = await readTarget(projectRoot, parsed, indexer, coordination, env, checkouts, readOptions);
      const checked = await check(definition, context, request);
      if (!checked) return null;
      const entry = await entryOf(checked, context);
      return { entry, ...definition.change(context, checked.after) };
    } });
    applied = written.entry;
  }
  if (parsed.kind === "approval") return { applied, actions: [], artifact: { path: read.gateRecord.artifact.path, scope: read.gateRecord.artifact.scope } };
  if (parsed.kind === "artifact") return { applied, actions: [view(definition, read)], artifact: { path: read.artifact.path, ...read.artifact.path === null ? { location: read.artifact.location } : {}, scope: read.artifact.scope }, comment: stored.id };
  const actions = (await listActions({ projectRoot, target, indexer, env, checkouts })).actions;
  if (parsed.kind === "gate") {
    const launch = applied ? await answerLaunchGate({ projectRoot, initiative: parsed.initiative, gate: parsed.gate, entry: applied.id, env }).catch(() => null) : null;
    return { applied, actions, launch };
  }
  return { applied, actions };
}
const launchRefusal = (error) => error instanceof LaunchError ? fail(error.code, error.message) : error;
async function applyLaunchAction({ projectRoot, definition, context, request, entryOf, env, target, indexer, checkouts = null }) {
  const checked = await check(definition, context, request);
  let outcome;
  try {
    outcome = await definition.launch({ projectRoot, context, env });
  } catch (error) {
    throw launchRefusal(error);
  }
  const entry = await entryOf({ ...checked, after: outcome.after }, context);
  if (outcome.record === false) return { applied: entry, actions: (await listActions({ projectRoot, target, indexer, env, checkouts })).actions, launch: outcome.launch };
  try {
    await recordPersonAction({ projectRoot, initiative: outcome.initiative, prepare: async () => ({ entry }) });
  } catch (error) {
    if (outcome.started) await stopLaunch({ id: outcome.started, env }).catch(() => {
    });
    throw error;
  }
  return { applied: entry, actions: (await listActions({ projectRoot, target, indexer, env, checkouts })).actions, launch: outcome.launch };
}
export {
  ActionError,
  actionEffect,
  applyAction,
  componentIndexingStatus,
  listActionTargets,
  listActions,
  parseTarget,
  prismIndexer
};
