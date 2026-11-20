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
import { acpLaunchPending, HOSTS } from "../session/launch-hosts.mjs";
import { isAcpHost } from "../session/acp-agents.mjs";
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

// The review app's actions: one registry of definitions that lists and applies every change a person makes to Prism records from a page.
// The module needs no HTTP, so any transport serves the same registry, and a new action joins by adding a definition below.

const GATE_ID = /^gate-[0-9a-f]{8,32}$/;
const APPROVAL_ID = /^approval-[0-9a-f]{8,32}$/;
const NOTE_LIMIT = 4000;
// A scope label is workspace, a repository name, or <repository>/<component>, and neither a label nor an artifact path holds a ":".
const SCOPE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const LINE_LIMIT = 16;

export class ActionError extends Error {
  declare code: any;
  constructor(code: any, message: any, details: any = {}) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (code: any, message: any, details?: any) => new ActionError(code, message, details);
const order = (left: any, right: any) => (left < right ? -1 : left > right ? 1 : 0);
const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
const option = (value: any, label: string, consequence: string | null = null) => ({ value, label, consequence });

function field(name: string, kind: any, label: string, extra: any = {}) {
  return { name, kind, label, options: null, required: false, requiredWhen: null, maxLength: null, multiline: null, ...extra };
}

const choice = (name: string, label: string, options: any, extra: any = {}) => field(name, "choice", label, { options, ...extra });
const toggle = (name: string, label: string, off: any, on: any) => field(name, "toggle", label, { options: [option("off", "Off", off), option("on", "On", on)], required: true });
const text = (name: string, label: string, maxLength: any, extra: any = {}) => field(name, "text", label, { maxLength, multiline: false, ...extra });

// ---- Targets ----

// The choices that belong to this computer rather than to a project's records.
const MACHINE_TARGETS = ["machine:prism-runs"];

/** A target reference read into its parts, or null when it is malformed. */
export function parseTarget(reference: any): any {
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
  // A machine target is a choice that belongs to this computer, kept in the review app folder rather than in any record.
  if (MACHINE_TARGETS.includes(reference)) return { kind: "machine", reference, machine: reference.slice("machine:".length) };
  return null;
}

const unknownTarget = (reference: any) => fail("unknown_target", `No action target ${JSON.stringify(String(reference ?? ""))} exists on this page.`);

// A checkout's components as index targets: the root component first and the declared ones in declaration order, each with the checkout that indexes it.
async function checkoutComponents(root: string) {
  const config = await readWorkflowConfig(root);
  const listed = listComponents(config);
  const repository = listed.repository ?? "root";
  if (listed.problem || listed.declared.length === 0) return [{ identity: `${repository}/${repository}`, folder: "", root }];
  return listed.declared.map((component) => ({ identity: component.component, folder: component.folder, root }));
}

// The index targets of a page: the checkout's own components, or, for a workspace's page, given checkouts, the components of every checkout of the workspace on this machine,
// by repository name and each repository's root component first, so a repository without a checkout here offers no index rebuild.
async function indexComponents(projectRoot: string, checkouts: any = null) {
  if (checkouts === null) return checkoutComponents(projectRoot);
  const byRepository = new Map();
  for (const root of checkouts) {
    const components = await checkoutComponents(root).catch(() => []);
    const repository = components[0]?.identity.split("/")[0];
    if (repository && !byRepository.has(repository)) byRepository.set(repository, components);
  }
  return [...byRepository].sort(([left], [right]) => order(left, right)).flatMap(([, components]) => components);
}

/**
 * The targets of a kind on a page: { targets }, which only the index kind lists.
 * checkouts, for a workspace's page, lists the roots of the workspace's checkouts on this machine, whose components are its index targets.
 */
export async function listActionTargets({ projectRoot, kind, checkouts = null }: { projectRoot: string; kind: any; checkouts?: any }) {
  if (kind !== "index") throw fail("unknown_target", "Only index targets are listed.");
  return { targets: (await indexComponents(projectRoot, checkouts)).map((component) => `index:${component.identity}`) };
}

async function initiativeExists(projectRoot: string, initiative: string, record: any) {
  if (record) return true;
  const roadmap = await readRoadmap(projectRoot).catch(() => null);
  return Boolean(roadmap?.loaded?.record?.initiatives?.some((item: any) => item.id === initiative));
}

// A store that cannot be used refuses an approval target with its own code and message, as an artifact read is refused, and the review app answers it as unavailable.
const storeRefusal = (error: any) => fail(error.code, error.message, { unavailable: true });
const storeRefused = (error: any) => error?.name === "ArtifactError" && typeof error.code === "string";

// The pending approval gates of the requirements and ADRs that the checkout sees whose id is the given one; a project without a store has none.
// More than one names no single gate: a copied status record or a move between scopes that stopped halfway leaves such a copy.
async function pendingApprovals(projectRoot: string, id: string) {
  const config = await readWorkflowConfig(projectRoot);
  if ((config.workspace?.store ?? null) === null) return [];
  const gates = await pendingApprovalGates(projectRoot).catch((error) => {
    if (error?.code === "store_not_configured") return [];
    throw storeRefused(error) ? storeRefusal(error) : error;
  });
  return gates.filter((gate: any) => gate.id === id);
}

// The store artifact that an artifact target names, as { path, scope, kind, version }, or null; a project without a store holds none.
async function seenArtifact(projectRoot: string, parsed: any) {
  return storeArtifactTarget(projectRoot, parsed.scope, parsed.path).catch((error) => {
    throw storeRefused(error) ? storeRefusal(error) : error;
  });
}

// Reads what a target's actions need: the initiative's coordination state and record, the index component, the approval gate, the store artifact, or the launched session, and refuses a target that does not exist.
// readOptions, when given, is the run options reader of the apply that reads the target again, so its reads are not repeated.
async function readTarget(projectRoot: string, parsed: any, indexer: any, state = undefined, env = process.env, checkouts = null, readOptions: any = null) {
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
  if (parsed.kind === "launch") {
    // A launched session is a target while this machine lists it for the page's checkout.
    const view = (await listLaunches({ projectRoot, env })).launches.find((item) => item.id === parsed.launch);
    if (!view) throw unknownTarget(parsed.reference);
    const status = await launchRunStatus({ id: parsed.launch, env });
    const resumeReason = status === "running" ? "The session is running." : await resumeRefusal({ id: parsed.launch, env });
    // A shipped initiative's state is history, so its sessions cannot resume; they stay stoppable, since orchestrate ships while its host runs.
    const shipped = await shippedDecision(projectRoot, view.initiative).catch(() => null);
    return { ...parsed, view, initiative: view.initiative, running: status === "running", resumeReason, shipped };
  }
  if (parsed.kind === "machine") {
    // The choice is checked against what this computer's hosts report, read in the page's checkout.
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
  // A shipped initiative's state is history, so its decision makes every action on it unavailable.
  const shipped = await shippedDecision(projectRoot, parsed.initiative).catch(() => null);
  const context = { ...parsed, coordination, record, shipped, initiativeTarget: `initiative:${parsed.initiative}` };
  if (parsed.kind === "initiative" && !(await initiativeExists(projectRoot, parsed.initiative, record))) throw unknownTarget(parsed.reference);
  // The host setting names each host this computer lacks, and the models setting checks a change against its host's report.
  if (parsed.kind === "initiative" || parsed.kind === "slice") {
    context.hosts = await hostAvailability({ env });
    context.readOptions = readOptions ?? runOptionsReader(projectRoot, env);
  }
  if (parsed.kind === "initiative") {
    context.launchRunning = await initiativeRunning({ projectRoot, initiative: parsed.initiative, env });
    // An ACP host that needs a sign-in or cannot run Prism's workflow makes the launch unavailable with its report's reason.
    const host = launchHostOf(context);
    if (isAcpHost(host) && context.hosts.find((item: any) => item.host === host)?.available && !(context.coordination.exists && !context.coordination.valid)) {
      context.launchReport = await context.readOptions({ host, purpose: "coordinator" });
    }
  }
  if (parsed.kind === "slice" && !(record?.slices && Object.hasOwn(record.slices, parsed.slice))) throw unknownTarget(parsed.reference);
  if (parsed.kind === "gate") {
    const gate = (coordination!.state?.pending ?? []).find((item: any) => isRecord(item) && item.id === parsed.gate);
    if (!gate) throw unknownTarget(parsed.reference);
    context.gateRecord = gate;
  }
  return context;
}

// ---- Definitions ----

const settingsOf = (context: any) => (context.coordination.valid ? context.coordination.state?.settings : null) ?? {};

// A setting's fields may follow the target, such as the hosts this computer finds; stored, when given, is the value a change is
// compared with, for a setting that shows a value it has not stored.
function setting({ name, label, fields, effect, confirm = null, value, stored = null, after = (values: any) => values.value, ignores = () => [] }: { name: string; label: string; fields: any; effect: any; confirm?: any; value: any; stored?: any; after?: any; ignores?: any }) {
  return {
    id: `initiative.${name}`,
    kinds: ["initiative", "slice"],
    label,
    group: "Initiative settings",
    effect,
    target: (context: any) => context.initiativeTarget,
    fields: typeof fields === "function" ? fields : () => fields,
    value,
    ...(stored ? { stored } : {}),
    context: () => null,
    recommended: () => null,
    confirm: () => confirm,
    revision: (context: any) => context.coordination.revision,
    unavailable: () => null,
    ignores,
    after,
    change: (context: any, after: any) => ({ setting: { name, value: after } })
  };
}

const NEXT_AGENT = "Applies to agents started after the change.";
const autonomyOf = (context: any) => settingsOf(context).autonomy ?? "conservative";

// ---- Host and models ----

// Each host in order, Claude Code, Codex, and then the ACP agents that this computer offers, read again for each request, with the
// reason this computer lacks it, or null where it is found; Prism's own runs list every ACP agent as unavailable.
const OWN_RUNS_ON_ACP = "Prism's own runs do not run on ACP agents.";
function hostOptions(context: any, consequence: (label: string) => string, { ownRuns = false } = {}) {
  const hosts = context.hosts ?? HOSTS.map(({ host, label }) => ({ host, label, available: false, reason: null }));
  return hosts.map(({ host, label, available, reason }: any) => {
    const why = ownRuns && isAcpHost(host) ? OWN_RUNS_ON_ACP : available ? null : reason ?? `${label} was not found.`;
    return { value: host, label, consequence: consequence(label), reason: why };
  });
}

const hostLabel = (context: any, host: string) => context.hosts?.find((item: any) => item.host === host)?.label ?? host;

const firstFoundHost = (context: any) => context.hosts?.find((item: any) => item.available)?.host ?? null;
const HOST_DEFAULT_CHOICE = Object.freeze({ model: null, effort: null, typed: false });

// One host's stored entry in full: its provider or null, and each kind's choice with null for the host default; a kept earlier
// name reads as the host default beside its earlier name, so nothing passes it on as a model.
function fullEntry(stored: any): any {
  const entry = isRecord(stored) ? stored : {};
  const choiceOf = (value: any) => {
    if (!isRecord(value)) return { ...HOST_DEFAULT_CHOICE };
    if (typeof value.earlier === "string") return { ...HOST_DEFAULT_CHOICE, earlier: value.earlier };
    return { model: value.model ?? null, effort: value.effort ?? null, typed: value.typed === true };
  };
  return { provider: typeof entry.provider === "string" ? entry.provider : null, ...Object.fromEntries(RUN_KINDS.map(({ kind }) => [kind, choiceOf(entry[kind])])) };
}

// Every listed host has an entry, and an ACP agent's stored entry stays while this computer does not offer that agent.
const modelsOf = (context: any) => {
  const stored = isRecord(settingsOf(context).models) ? settingsOf(context).models : {};
  const hosts = [...new Set([...(context.hosts ?? HOSTS).map(({ host }: any) => host), ...Object.keys(stored).filter(isAcpHost)])];
  return Object.fromEntries(hosts.map((host) => [host, fullEntry(stored[host])]));
};

// The stored form leaves out every host default, and every host whose entry is then empty.
function compactModels(value: any) {
  const compact: any = {};
  for (const [host, entry] of Object.entries<any>(value)) {
    const kept: any = {};
    if (entry.provider !== null) kept.provider = entry.provider;
    for (const { kind } of RUN_KINDS) {
      const choice = entry[kind];
      if (typeof choice.earlier === "string") {
        kept[kind] = { earlier: choice.earlier };
        continue;
      }
      const part = { ...(choice.model === null ? {} : { model: choice.model }), ...(choice.effort === null ? {} : { effort: choice.effort }), ...(choice.typed ? { typed: true } : {}) };
      if (Object.keys(part).length) kept[kind] = part;
    }
    if (Object.keys(kept).length) compact[host] = kept;
  }
  return compact;
}

// Reads a host's run options for the checkout and keeps each read: one apply shares one reader between its check on the state as read
// and its check under the state lock, which takes the same values and so reuses the first check's reads and starts no host.
function runOptionsReader(projectRoot: any, env: any) {
  const reads = new Map();
  return (selection: any) => {
    const key = JSON.stringify(selection);
    if (!reads.has(key)) reads.set(key, readRunOptions({ ...selection, checkout: projectRoot, env }));
    return reads.get(key);
  };
}

const optionOf = (report: any, id: any) => report.options.find((item: any) => item.id === id) ?? null;
const RUN_CHOICE_HINTS = {
  coordinator: "Only coordinates: it plans the order of work, starts the agents below and asks you at gates. It writes no code.",
  designImplementation: "Writes each slice's design, tests and code.",
  codeReview: "Reviews each finished slice.",
  securityReview: "Reviews slices that touch access, secrets or other trust boundaries.",
  gateSummary: "Turns the design's tests into the short summaries you read at the design gate."
};
const PROVIDER_HINT = "Where the host sends its model requests; only some hosts offer a choice.";

function modelsFields(context: any) {
  return [
    choice("host", "Host", hostOptions(context, (label) => `Shows and changes the choices kept for ${label}.`), { required: true }),
    field("provider", "run-option", "Provider", { for: "coordinator", option: "provider", hint: PROVIDER_HINT }),
    ...RUN_KINDS.map(({ kind, label, purpose }) => field(kind, "run-choice", label, { for: purpose, hint: RUN_CHOICE_HINTS[kind] }))
  ];
}

// One host's provider and run choices, checked in field order against what the host reports, so the first failing field answers:
// the host, the provider, then each choice as listed in choices, { name, purpose, choice }. Only what the host reports, or a model
// name typed as such, is taken, and refuse(name, message) builds each refusal. The host is read only for a value it must offer, so
// host defaults and a typed model without an effort start no host process.
async function checkHostChoices(context: any, { host, provider, choices, ownRuns = false }: any, refuse: any) {
  const label = hostLabel(context, host);
  const missing = hostOptions(context, () => "", { ownRuns }).find((item: any) => item.value === host)?.reason;
  if (missing) throw refuse("host", missing);
  if (provider !== null) {
    if (!validProvider(provider)) throw refuse("provider", NAME_RULE_MESSAGES.provider);
    const base = await context.readOptions({ host, purpose: "coordinator" });
    if (base.state === "unavailable" || base.state === "sign-in") throw refuse("host", base.reason);
    if (!optionOf(base, "provider")?.values.some((item: any) => item.value === provider)) throw refuse("provider", choiceReasons.provider(label, provider));
  }
  for (const { name, purpose, choice } of choices) {
    // An earlier name is never offered, so a change that still holds one is refused until the person replaces it.
    if (choice.earlier !== undefined) throw refuse(name, earlierReason(label, choice.earlier));
    if (choice.typed && choice.model === null) throw refuse(name, "Only a model name can be typed.");
    const breach = nameRuleBreach({ model: choice.model, effort: choice.effort });
    if (breach) throw refuse(name, breach.message);
    if (choice.effort === null && (choice.model === null || choice.typed)) continue;
    const report = await context.readOptions({ host, purpose, provider, model: choice.model, effort: choice.effort, typed: choice.typed });
    if (report.state === "unavailable" || report.state === "sign-in") throw refuse("host", report.reason);
    for (const id of ["model", "effort"]) {
      const chosen = optionOf(report, id)?.chosen;
      if (chosen?.state === "not-offered") throw refuse(name, chosen.reason);
    }
  }
}

const refuseChoice = (name: any, message: any) => invalid(name, "A value that the host reports, the host default, or a model name typed as such.", message);

// A change names one host and its entry, and replaces only that host's entry once its choices are checked.
async function checkedModels(values: any, context: any) {
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
    fields: (context: any) => [choice("value", "Host", hostOptions(context, (label) => `${label} runs the launched session and its agents.`), { required: true })],
    effect: "Launches started after the change run on this host; a running or resumed session keeps the host it started on.",
    // With no host stored, the first host this computer finds shows, and choosing it still stores it as the person's.
    value: (context: any) => settingsOf(context).host ?? firstFoundHost(context),
    stored: (context: any) => settingsOf(context).host ?? null,
    after: (values: any, context: any) => {
      const options = hostOptions(context, () => "");
      const chosen = options.find((item: any) => item.value === values.value);
      if (chosen?.reason) throw invalid("value", options.map((item: any) => item.value), chosen.reason);
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
    value: (context: any) => settingsOf(context).commit ?? (autonomyOf(context) === "full" ? "on" : "off")
  }),
  setting({
    name: "push",
    label: "Push",
    fields: [toggle("value", "Push", "Finished slices stay on this machine.", "Agents push finished slices beyond this machine.")],
    effect: NEXT_AGENT,
    confirm: { field: "value", values: ["on"], message: "Agents will push finished slices beyond this machine." },
    value: (context: any) => settingsOf(context).push ?? "off"
  }),
  setting({
    name: "continuation",
    label: "Continuation",
    fields: [choice("value", "Continuation", [
      option("auto", "Automatic", "The next slice starts as soon as one finishes."),
      option("stepwise", "Stepwise", "The run stops after each slice until you continue it.")
    ], { required: true })],
    effect: "Whether the next slice starts by itself; applies when the slice in progress finishes.",
    value: (context: any) => settingsOf(context).continuation ?? "auto"
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
    value: (context: any) => settingsOf(context).review ?? "marked"
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
    change: (context: any, after: any) => ({ setting: { name: "models", value: compactModels(after) } })
  }
];

// Only the settings that coordination state accepts have actions, so a setting Prism retires loses its action with it.
const SETTING_ACTIONS = SETTING_DEFINITIONS.filter((definition) => INITIATIVE_SETTINGS.includes(definition.id.slice("initiative.".length)));

// A gate's answer fields follow its kind: a review approves or asks for changes with a reason, a decision picks an option or explains, and assistance is done.
function gateFields(gate: any) {
  const note = (extra?: any) => text("note", "Note", NOTE_LIMIT, { multiline: true, ...extra });
  if (gate.kind === "visual-review" || gate.kind === "correctness" || gate.kind === "approval") {
    return [choice("choice", "Answer", [option("approve", "Approve"), option("request-changes", "Request changes")], { required: true }), note({ requiredWhen: { field: "choice", values: ["request-changes"] } })];
  }
  if (gate.kind === "decision" && Array.isArray(gate.options) && gate.options.length) {
    return [choice("choice", "Answer", gate.options.map((item: any) => option(item.id, item.label, typeof item.consequence === "string" ? item.consequence : null))), note({ requiredWhen: { field: "choice", values: [null] } })];
  }
  if (gate.kind === "decision") return [note({ required: true })];
  return [choice("choice", "Answer", [option("done", "Done")], { required: true }), note()];
}

// A gate's recommendation as the page shows it: the recommended option, or null when it names none, and why.
function gateRecommendation(gate: any) {
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
  target: (context: any) => context.reference,
  fields: (context: any) => gateFields(context.gateRecord),
  value: () => null,
  context: (context: any) => typeof context.gateRecord.context === "string" && context.gateRecord.context ? context.gateRecord.context : null,
  recommended: (context: any) => gateRecommendation(context.gateRecord),
  confirm: () => null,
  revision: (context: any) => context.coordination.revision,
  unavailable: (context: any) => context.gateRecord.answer ? "The question already has an answer." : null,
  after: (values: any) => ({ choice: values.choice ?? null, note: values.note ?? null }),
  change: (context: any, after: any) => ({ answer: { id: context.gate, choice: after.choice, note: after.note } })
};

// A requirement's or ADR's approval gate is answered as a review is, against the artifact's current version, and refused while the artifact differs from the version the gate asked about.
const APPROVAL_CHANGED = "The file changed since this approval was asked, so approving it would approve a version nobody asked about. The agent asks again for the current version.";

const APPROVAL_ANSWER = {
  ...GATE_ANSWER,
  kinds: ["approval"],
  effect: "Records your answer; approving sets the file's status, and the agent that asked resumes with it.",
  fields: () => gateFields({ kind: "approval" }),
  context: (context: any) => context.ambiguous ? null : GATE_ANSWER.context(context),
  recommended: () => null,
  // An id that several pending gates hold names no version to answer against.
  revision: (context: any) => context.ambiguous ? null : context.gateRecord.current,
  unavailable: (context: any) => context.ambiguous ?? (context.gateRecord.changed ? APPROVAL_CHANGED : null),
  unavailableCode: (context: any) => context.ambiguous ? "approval_ambiguous" : "artifact_changed",
  change: undefined
};

// A comment names a line by its number, so it is refused unless it is decimal digits naming a whole number of at least 1.
function commentLine(value: any) {
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
  target: (context: any) => context.reference,
  fields: () => [text("line", "Line", LINE_LIMIT, { required: true }), text("text", "Comment", NOTE_LIMIT, { required: true, multiline: true })],
  value: () => null,
  context: () => null,
  recommended: () => null,
  confirm: () => null,
  revision: (context: any) => context.artifact.version,
  unavailable: () => null,
  after: (values: any, context: any) => ({ version: context.artifact.version, line: commentLine(values.line), text: values.text })
};

const INDEX_REBUILD = {
  id: "index.rebuild",
  kinds: ["index"],
  label: "Rebuild index",
  group: "Index",
  effect: "Starts a new build of this component's index now; searches use the current index until it finishes.",
  target: (context: any) => context.reference,
  fields: () => [],
  value: () => null,
  context: () => null,
  recommended: () => null,
  confirm: () => null,
  revision: () => null,
  unavailable: (context: any) => context.indexState === "preparing" ? "An index build is already running." : null,
  after: () => "started"
};

// Launched sessions: one launch on an initiative, which runs the initiative's host, and stop and resume on each launched session. Each
// runs through its own step after the common checks, the launch and the person's resume behind the confirmation outside the page, and
// is recorded only once it took effect.
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

const hostList = (labels: any) => (labels.length > 2 ? `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}` : labels.join(" and "));
// Named from the live host list, so a declared or installed ACP agent that cannot run is named beside Claude Code and Codex.
const noHost = (hosts: any) => `No host that Prism supports was found on this computer. Prism supports ${hostList(hosts.map(({ label }: any) => label))}.`;
const launchHostOf = (context: any) => settingsOf(context).host ?? firstFoundHost(context);
// A state that exists but reads invalid hides the host and the models chosen for the launch, and its history cannot record one, so
// the launch is unavailable until the state reads again rather than running another host or other choices than the ones saved.
const UNREADABLE_STATE = "This initiative's saved settings cannot be read, so Prism cannot tell which host, models, and efforts to launch with.";
const notOffered = (label: any, reason: any) => fail("choice_not_offered", `${label}: ${reason}`);

// The initiative's provider and every kind's choice for its host, checked against what the host reports, in field order: the
// provider, then the kinds. A kept earlier name is refused without a read, and a host default, or a typed model without an
// effort, needs none, so a launch whose choices are all host defaults reads no host. A read that failed offers only the host
// defaults, so the field that needed it is refused with the read's own reason rather than as a choice the host does not offer.
async function checkedLaunchChoices(context: any, host: any) {
  const label = hostLabel(context, host);
  const entry = modelsOf(context)[host];
  const { provider } = entry;
  const report = async (fieldLabel: any, selection: any) => {
    const read = await context.readOptions({ host, ...selection });
    if (read.state === "unavailable" || read.state === "sign-in") throw fail("host_unavailable", read.reason);
    if (read.state === "failed") throw notOffered(fieldLabel, read.reason);
    return read;
  };
  if (provider !== null) {
    const base = await report("Provider", { purpose: "coordinator" });
    if (!optionOf(base, "provider")?.values.some((item: any) => item.value === provider)) throw notOffered("Provider", choiceReasons.provider(label, provider));
  }
  for (const { kind, label: kindLabel, purpose } of RUN_KINDS) {
    const choice = entry[kind];
    if (choice.earlier !== undefined) throw notOffered(kindLabel, earlierReason(label, choice.earlier));
    if (choice.effort === null && (choice.model === null || choice.typed)) continue;
    const read = await report(kindLabel, { purpose, provider, model: choice.model, effort: choice.effort, typed: choice.typed });
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
  target: (context: any) => context.initiativeTarget,
  unavailable: (context: any) => {
    // The missing hosts read no setting, so they answer first, also while the state reads invalid.
    if (!context.hosts.some((item: any) => item.available)) return noHost(context.hosts);
    if (context.coordination.exists && !context.coordination.valid) return UNREADABLE_STATE;
    const host = launchHostOf(context);
    const availability = context.hosts.find((item: any) => item.host === host);
    if (!availability?.available) return availability?.reason ?? `${hostLabel(context, host)} was not found.`;
    if (isAcpHost(host)) return ["failed", "sign-in"].includes(context.launchReport?.state) ? context.launchReport.reason : acpLaunchPending(availability.label);
    return context.launchRunning ? launchRunningMessage(context.initiative) : null;
  },
  after: () => null,
  async launch({ projectRoot, context, env }: { projectRoot: string; context: any; env: NodeJS.ProcessEnv }) {
    const host = launchHostOf(context);
    // Every choice is checked before the confirmation, so a launch that would be refused asks nothing.
    const coordinator = await checkedLaunchChoices(context, host);
    const checkout = await realpath(projectRoot);
    await confirmLaunch({ initiative: context.initiative, host, checkout, env });
    const { launch }: any = await startLaunch({ projectRoot: checkout, initiative: context.initiative, host, coordinator, env });
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
  target: (context: any) => context.reference,
  // The shipped state never decides a stop.
  ownsShipped: true,
  unavailable: (context: any) => (context.running ? null : "The session is not running."),
  after: () => null,
  async launch({ projectRoot, context, env }: { projectRoot: string; context: any; env: NodeJS.ProcessEnv }) {
    const launch = await stopLaunch({ id: context.launch, env });
    // After the initiative shipped, its state is history: the stop request in the launch folder is the stop's only record.
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
  target: (context: any) => context.reference,
  ownsShipped: true,
  unavailable: (context: any) => {
    if (context.running) return "The session is running.";
    return context.shipped ? shippedActionReason(context.shipped) : context.resumeReason;
  },
  after: () => null,
  async launch({ projectRoot, context, env }: { projectRoot: string; context: any; env: NodeJS.ProcessEnv }) {
    await confirmLaunch({ initiative: context.view.initiative, host: context.view.host, checkout: context.view.checkout, env });
    // The initiative may have shipped while the dialog was open; then nothing starts.
    const shipped = await shippedDecision(projectRoot, context.initiative).catch(() => null);
    if (shipped) throw fail("action_unavailable", shippedActionReason(shipped), { reason: shippedActionReason(shipped) });
    const launch: any = await resumeLaunch({ id: context.launch, env, cause: "person" });
    return { launch, after: { launch: launch.id, run: launch.runs }, initiative: context.initiative, started: launch.id };
  }
};

// ---- This computer ----

// The host and model of Prism's own runs, such as the runs that move records to a new format: one choice per computer, kept in the
// review app folder, from the same host reports as a launch's coordinator. Any available host starts each run on the first host
// found with its defaults, so it takes no provider, model, or effort.
const AUTOMATIC_ONLY_DEFAULTS = "Any available host takes only the host's default model.";
// A choice that cannot be read shows no host, so the page offers to store a readable one, and any choice applied over it is stored.
const UNREADABLE_PRISM_RUNS = "The stored choice could not be read, so each run starts on the first host Prism finds with its default model until you apply a host.";
const prismRunsValue = (context: any) => {
  const { state, choice } = context.prismRuns;
  if (state === "unreadable") return { host: null, provider: null, run: { ...HOST_DEFAULT_CHOICE } };
  if (state !== "chosen") return { host: AUTOMATIC, provider: null, run: { ...HOST_DEFAULT_CHOICE } };
  return { host: choice.host, provider: choice.provider, run: { model: choice.model, effort: choice.effort, typed: choice.typed } };
};

const MACHINE_PRISM_RUNS = {
  id: "machine.prismRuns",
  kinds: ["machine"],
  label: "Prism's own runs",
  group: "This computer",
  effect: "Prism's own runs on this computer, such as moving records to a new format, start with this host and model; a run already started keeps its own.",
  target: (context: any) => context.reference,
  fields: (context: any) => [
    choice("host", "Host", [
      { value: AUTOMATIC, label: AUTOMATIC_LABEL, consequence: "Each run starts on the first host Prism finds on this computer, with its default model.", reason: null },
      ...hostOptions(context, (label) => `${label} runs Prism's own runs.`, { ownRuns: true })
    ], { required: true, ...(context.prismRuns.state === "unreadable" ? { hint: UNREADABLE_PRISM_RUNS } : {}) }),
    field("provider", "run-option", "Provider", { for: "coordinator", option: "provider", hint: PROVIDER_HINT, fixedWhen: { field: "host", values: [AUTOMATIC] } }),
    field("run", "run-choice", "Model", { for: "coordinator", heading: "Model of Prism's own runs", hint: "The model and effort of each run, from what the host reports.", fixedWhen: { field: "host", values: [AUTOMATIC] } })
  ],
  value: prismRunsValue,
  // A change is compared with the value only while that value is stored or is the default of no choice, never an unreadable one.
  stored: (context: any) => (context.prismRuns.state === "unreadable" ? null : prismRunsValue(context)),
  context: () => null,
  recommended: () => null,
  confirm: () => null,
  revision: (context: any) => context.prismRuns.revision,
  unavailable: () => null,
  async after(values: any, context: any) {
    const { host, provider, run } = values;
    if (host === AUTOMATIC) {
      if (provider !== null) throw refuseChoice("provider", AUTOMATIC_ONLY_DEFAULTS);
      if (run.model !== null || run.effort !== null || run.typed) throw refuseChoice("run", AUTOMATIC_ONLY_DEFAULTS);
      return { host, provider: null, run: { ...HOST_DEFAULT_CHOICE } };
    }
    await checkHostChoices(context, { host, provider, choices: [{ name: "run", purpose: "coordinator", choice: run }], ownRuns: true }, refuseChoice);
    return { host, provider, run: { model: run.model, effort: run.effort, typed: run.typed } };
  }
};

/** Every action, in listing order; a later action joins by adding its definition here. */
const ACTIONS = [...SETTING_ACTIONS, LAUNCH_RUN, GATE_ANSWER, APPROVAL_ANSWER, ARTIFACT_COMMENT, INDEX_REBUILD, LAUNCH_STOP, LAUNCH_RESUME, MACHINE_PRISM_RUNS];

/** The sentence on when an action's change takes effect, or null for an action the registry does not define. */
export const actionEffect = (id: string) => ACTIONS.find((definition) => definition.id === id)?.effect ?? null;

function view(definition: any, context: any) {
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

const definitionsFor = (kind: any) => ACTIONS.filter((definition) => definition.kinds.includes(kind));

// ---- The default indexer ----

/** One component's indexing status from a checkout's index status: its own entry with declared components, or the status itself without them. */
export function componentIndexingStatus(status: any, component: any) {
  if (!Array.isArray(status?.components)) return status;
  return { state: status.components.find((entry: any) => entry.component === component?.identity)?.state ?? "none" };
}

/**
 * Prism's own indexer, which serves each component's own index: in a repository that declares components, a component's state is its entry in the
 * index status, or none while it has neither an index nor a preparation, and without declared components the root component's state is the status's own.
 */
export const prismIndexer = Object.freeze({
  async status(projectRoot: string, component: any) {
    const [{ readIndexingStatus }, { nativeSemanticRuntime }] = await Promise.all([import("../repository-intelligence/index-status.mjs"), import("../repository-intelligence/native-semantic-runtime.mjs")]);
    return componentIndexingStatus(await readIndexingStatus(projectRoot, [nativeSemanticRuntime.directory]), component);
  },
  async rebuild(projectRoot: string, component: any) {
    const { startIndexRebuild } = await import("../repository-intelligence/background-preparation.mjs");
    void startIndexRebuild(projectRoot, { component: { identity: component.identity, folder: component.folder } });
  }
});

// ---- Listing ----

/** The actions that apply to a target: { target, actions }, available or not. */
export async function listActions({ projectRoot, target, indexer = prismIndexer, env = process.env, checkouts = null }: { projectRoot: string; target: string; indexer?: any; env?: NodeJS.ProcessEnv; checkouts?: any }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const context = await readTarget(projectRoot, parsed, indexer, undefined, env, checkouts);
  return { target, actions: definitionsFor(parsed.kind).map((definition) => view(definition, context)) };
}

// ---- Input ----

const optionValues = (item: any) => item.options.map((entry: any) => entry.value);
const invalid = (name: string | null, accepted: any, message: any) => fail("invalid_input", message, { field: name, accepted });

// Reads an input against the fields: every value is a listed option, a text within its limit, or empty as null, and every required field is filled.
// The options are read first, so a field that the chosen options make irrelevant is read as null without a check.
function readInput(fields: any, input: any, ignores: (values: any) => any[] = () => []) {
  if (!isRecord(input)) throw invalid(null, `The input maps field names to values: ${fields.map((item: any) => item.name).join(", ") || "none"}.`, "The input must be an object of field values.");
  const names = new Set(fields.map((item: any) => item.name));
  for (const name of Object.keys(input)) {
    if (!names.has(name)) throw invalid(name, fields.length ? `The action has no field ${name}; its fields are ${fields.map((item: any) => item.name).join(", ")}.` : `The action has no field ${name}; it takes no fields.`, `The action has no field ${name}.`);
  }
  const values: Record<string, any> = {};
  const ordered = [...fields.filter((item: any) => item.kind !== "text"), ...fields.filter((item: any) => item.kind === "text")];
  let ignored: any = null;
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

// A run option takes a name or null for the host default; whether the host offers it is the action's own check.
function runOptionInput(item: any, raw: any) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw invalid(item.name, "A name, or null for the host default.", `${item.label} must be a name or the host default.`);
  return raw;
}

// A run choice takes { model, effort, typed } or null for the host default, with null or a missing part as the host's default; an
// agent's choice may also hold the earlier name that its value shows, which the action's own check refuses with its reason.
function runChoiceInput(item: any, raw: any) {
  const accepted = "{ model, effort, typed } with model and effort a name or null and typed true or false, or null for the host default.";
  if (raw === undefined || raw === null) return { model: null, effort: null, typed: false };
  const malformed = () => invalid(item.name, accepted, `${item.label} must be a model, an effort, and whether the model was typed.`);
  const parts = item.for === "agents" ? ["model", "effort", "typed", "earlier"] : ["model", "effort", "typed"];
  if (!isRecord(raw) || Object.keys(raw).some((key) => !parts.includes(key))) throw malformed();
  if (raw.earlier !== undefined && !validEarlierName(raw.earlier)) throw malformed();
  const part = (value: any) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw malformed();
    return value;
  };
  if (raw.typed !== undefined && typeof raw.typed !== "boolean") throw malformed();
  return { model: part(raw.model), effort: part(raw.effort), typed: raw.typed === true, ...(raw.earlier === undefined ? {} : { earlier: raw.earlier }) };
}

// ---- Applying ----

// Two values are the same when they hold the same data, whatever order an object's keys were stored in.
function sameValue(left: any, right: any): boolean {
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
// A comment on a store artifact is the store's change, so its author is what the Git configuration of the store's clone claims, or the checkout's where the clone names no user.
async function authorOf(projectRoot: string, { store = false }: any = {}) {
  const clone = store ? await recordStoreOf(projectRoot).then((found) => found.external ? found.base : null, () => null) : null;
  const read = async (where: any, key: any) => {
    const result = await runGit(where, ["config", key]);
    const value = result.ok ? result.text.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return value || null;
  };
  const where = clone && await read(clone, "user.name") ? clone : projectRoot;
  // A workspace's page without a registered checkout applies its actions in the store's clone, which is the review app's, not a checkout's.
  const checkoutless = await isStoreWithoutCheckout(projectRoot);
  const [name, email, identity] = await Promise.all([read(where, "user.name"), read(where, "user.email"), checkoutless ? { repository: "review app", worktree: null, branch: null, detached: false } : readWorkspaceIdentity(projectRoot)]);
  return { name, email, checkout: checkoutLabel(identity).slice(0, 400) };
}

// Checks one request against a target read: the action, the revision, availability, the input, and confirmation, in that order.
// It answers null for an input equal to the current value, and otherwise the definition, its view, and the value to set.
async function check(definition: any, context: any, { revision, input, confirmed }: { revision: string; input: any; confirmed: any }) {
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

/**
 * Applies one action to a target: { applied, actions }, where applied is the history entry or null for an unchanged value, and actions the target's listing after it;
 * an approval's or a comment's result also names its artifact as artifact { path, scope }, since its entry belongs to no initiative, and a comment's result names its stored comment's id as comment.
 */
export async function applyAction({ projectRoot, target, action, input, revision, confirmed, via = "review-app", indexer = prismIndexer, env = process.env, checkouts = null }: { projectRoot: string; target: string; action: any; input: any; revision: string; confirmed: any; via?: string; indexer?: any; env?: NodeJS.ProcessEnv; checkouts?: any }) {
  const parsed = parseTarget(target);
  if (!parsed) throw unknownTarget(target);
  const definition: any = definitionsFor(parsed.kind).find((item) => item.id === action);
  const readOptions = runOptionsReader(projectRoot, env);
  const read = await readTarget(projectRoot, parsed, indexer, undefined, env, checkouts, readOptions);
  if (!definition) throw fail("unknown_action", `The target ${target} has no action ${JSON.stringify(String(action ?? ""))}.`);
  const request = { revision, input, confirmed };
  const entryOf = async (checked: any, context: any) => ({
    id: randomBytes(16).toString("hex"),
    action: definition.id,
    target: checked.current.target,
    before: checked.current.value,
    after: checked.after,
    at: new Date().toISOString(),
    by: await authorOf(projectRoot, { store: parsed.kind === "artifact" }),
    via: typeof via === "string" && via ? via : "review-app"
  });
  if (definition.launch) return applyLaunchAction({ projectRoot, definition, context: read, request, entryOf, env, target, indexer, checkouts });
  let applied = null;
  // The comment as stored, whose id names its own file, so the review app hands it to another checkout's tabs by reading that one file.
  let stored = null;
  if (parsed.kind === "approval") {
    // An ambiguous id is refused before any other check, whatever revision and input the request holds.
    if (read.ambiguous) throw fail("approval_ambiguous", read.ambiguous, { reason: read.ambiguous });
    const checked = await check(definition, read, request);
    applied = await entryOf(checked, read);
    // An approval records who gave it, so a checkout whose Git names no user is refused rather than recording an anonymous one.
    if (!applied.by.name) throw fail("author_unknown", "Git names no user.name for this checkout, so the answer cannot record who approved; set one with git config user.name and answer again.");
    const gate = read.gateRecord;
    // The store update repeats the gate and version checks under the artifact lock, so a change that lands after the read above is refused, never overwritten.
    await answerArtifactApproval(projectRoot, { path: gate.artifact.path, scope: gate.artifact.scope, id: gate.id, choice: checked!.after.choice, note: checked!.after.note, by: { name: applied.by.name, host: os.hostname() }, entry: applied }).catch((error) => {
      if (error?.code === "unknown_gate" || error?.code === "gate_answered") throw unknownTarget(target);
      if (error?.code === "artifact_changed") throw fail("artifact_changed", APPROVAL_CHANGED);
      if (error?.code === "invalid_answer") throw fail("invalid_input", error.message, { field: null });
      if (error?.code === "approval_ambiguous") throw fail("approval_ambiguous", error.message, { reason: error.message });
      throw storeRefused(error) ? storeRefusal(error) : error;
    });
  } else if (parsed.kind === "artifact") {
    const checked = await check(definition, read, request);
    applied = await entryOf(checked, read);
    // A comment records who wrote it, so a checkout whose Git names no user is refused rather than storing an anonymous one.
    if (!applied.by.name) throw fail("author_unknown", "Git names no user.name for this checkout, so the comment cannot record who wrote it; set one with git config user.name and comment again.");
    // The store write repeats the artifact and version checks under the artifact lock, so a change that lands after the read above is refused as stale.
    const { artifact } = read;
    stored = await commentOnArtifact(projectRoot, { path: artifact.path, location: artifact.location ?? null, label: artifact.scope.label, version: checked!.after.version, line: checked!.after.line, text: checked!.after.text, author: { name: applied.by.name, host: os.hostname().slice(0, 255) }, entry: applied }).catch((error) => {
      if (error?.code === "artifact_not_found") throw unknownTarget(target);
      if (error?.code === "comment_limit") throw fail("comment_limit", error.message);
      if (error?.code === "version_conflict") throw fail("stale_revision", "The file changed since the page read it.", { current: view(definition, { ...read, artifact: { ...artifact, version: error.version ?? null } }) });
      throw storeRefused(error) ? storeRefusal(error) : error;
    });
  } else if (parsed.kind === "machine") {
    // The write repeats the revision check under the file's lock, so a change that lands after the read above is refused as stale.
    const checked = await check(definition, read, request);
    if (checked) {
      applied = await entryOf(checked, read);
      const { host, provider, run } = checked.after;
      await writePrismRunsChoice({ choice: { host, provider, ...run }, by: applied.by.name ?? applied.by.checkout, revision: read.prismRuns.revision, env }).catch(async (error) => {
        if (error instanceof PrismRunsError && error.code === "not_a_file") throw fail("invalid_input", error.message, { field: null });
        if (error instanceof PrismRunsError && error.code === "stale_revision") {
          const current = view(definition, await readTarget(projectRoot, parsed, indexer, undefined, env, checkouts, readOptions));
          throw fail("stale_revision", "The choice changed since the page read it.", { current });
        }
        throw error;
      });
    }
  } else if (parsed.kind === "index") {
    const checked = await check(definition, read, request);
    if (checked) {
      applied = await entryOf(checked, read);
      // The rebuild and its history entry belong to the checkout that indexes the component.
      await indexer.rebuild(read.component.root, read.component);
      await appendIndexHistory(read.component.root, applied);
    }
  } else {
    // The checks repeat under the state lock on the state it holds, so a change that lands between the read above and the write is never overwritten.
    const written = await recordPersonAction({ projectRoot, initiative: parsed.initiative, prepare: async (coordination: any) => {
      const context = await readTarget(projectRoot, parsed, indexer, coordination, env, checkouts, readOptions);
      const checked = await check(definition, context, request);
      if (!checked) return null;
      const entry = await entryOf(checked, context);
      return { entry, ...definition.change(context, checked.after) };
    } });
    applied = written.entry;
  }
  // An answered approval gate leaves its artifact's pending gates, so its target has no actions left, and the result names the artifact the answer applied to.
  if (parsed.kind === "approval") return { applied, actions: [], artifact: { path: read.gateRecord.artifact.path, scope: read.gateRecord.artifact.scope } };
  // A comment leaves its artifact unchanged, so the target lists its action again, and the result names the artifact it commented on.
  if (parsed.kind === "artifact") return { applied, actions: [view(definition, read)], artifact: { path: read.artifact.path, ...(read.artifact.path === null ? { location: read.artifact.location } : {}), scope: read.artifact.scope }, comment: stored.id };
  const actions = (await listActions({ projectRoot, target, indexer, env, checkouts })).actions;
  // An answer to a gate that a launched session of this machine asked is recorded for that session, which it may resume.
  if (parsed.kind === "gate") {
    const launch = applied ? await answerLaunchGate({ projectRoot, initiative: parsed.initiative, gate: parsed.gate, entry: applied.id, env }).catch(() => null) : null;
    return { applied, actions, launch };
  }
  return { applied, actions };
}

// A launched session's refusal answers as an action refusal with its own code and message.
const launchRefusal = (error: any) => (error instanceof LaunchError ? fail(error.code, error.message) : error);

// Applies a launch, stop, or resume: the common checks, then the action's own step, which confirms outside the page where it starts a
// session, and only once that took effect the history entry, which names the launch id and never the host session id.
async function applyLaunchAction({ projectRoot, definition, context, request, entryOf, env, target, indexer, checkouts = null }: { projectRoot: string; definition: any; context: any; request: any; entryOf: any; env: NodeJS.ProcessEnv; target: string; indexer: any; checkouts?: any }) {
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
    // A launch or resume that cannot be recorded does not stay started.
    if (outcome.started) await stopLaunch({ id: outcome.started, env }).catch(() => {});
    throw error;
  }
  return { applied: entry, actions: (await listActions({ projectRoot, target, indexer, env, checkouts })).actions, launch: outcome.launch };
}
