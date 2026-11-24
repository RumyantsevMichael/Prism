// Generated from src/server/review/public/views/actions.ts by scripts/native-build/compile.mjs.
import { badge, escapeHtml } from "./util.js";
import { coalesce } from "./poller.js";
import { createRunChoices, createRunOptionsReader, HOST_HINT, hostFieldOf, hostLeader, isRunAction, isRunField, runFieldsFixed } from "./run-choices.js";
const READ_ONLY_NOTICE = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";
const STALE_MESSAGE = "Someone changed this since you opened it; it now shows the current value.";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const normalized = (value) => typeof value === "string" ? value.trim() ? value.trim() : null : Array.isArray(value) ? value.length ? value : null : value ?? null;
const filled = (value) => normalized(value) !== null;
const same = (left, right) => isRecord(left) || isRecord(right) ? JSON.stringify(left ?? null) === JSON.stringify(right ?? null) : left === right;
function currentInput(action) {
  const fields = action.fields ?? [];
  const input = Object.fromEntries(fields.map((field) => [field.name, null]));
  const value = action.value;
  if (value === null || value === void 0) return input;
  if (!isRecord(value)) {
    if (fields[0]) input[fields[0].name] = value;
    return input;
  }
  for (const field of fields) if (Object.hasOwn(value, field.name)) input[field.name] = value[field.name] ?? null;
  for (const field of fields) {
    if (field.kind === "text" || input[field.name] !== null) continue;
    const dependent = fields.find((other) => other.requiredWhen?.field === field.name && Object.hasOwn(value, other.name));
    const implied = dependent?.requiredWhen.values.find((item) => item !== null);
    if (implied !== void 0) input[field.name] = implied;
  }
  return input;
}
const impliedOption = (field) => field.kind !== "text" && field.required && Array.isArray(field.options) && field.options.length === 1 ? field.options[0].value : null;
function isRequired(field, input) {
  if (field.required) return true;
  const when = field.requiredWhen;
  return Boolean(when) && when.values.includes(normalized(input[when.field]));
}
function keyField(action) {
  const value = action.value;
  if (!isRecord(value)) return null;
  return (action.fields ?? []).find((field) => Array.isArray(field.options) && field.options.length > 0 && field.options.every((option) => Object.hasOwn(value, option.value))) ?? null;
}
function keyedInput(action, current, values) {
  const key = keyField(action);
  const host = key ? null : hostFieldOf(action);
  if (host && Object.hasOwn(values, host.name) && normalized(values[host.name]) !== current[host.name]) {
    return Object.fromEntries((action.fields ?? []).map((field) => [field.name, isRunField(field) ? null : current[field.name]]));
  }
  const picked = key ? normalized(Object.hasOwn(values, key.name) ? values[key.name] : current[key.name]) : null;
  const entry = picked === null ? null : action.value[picked];
  if (!isRecord(entry)) return current;
  return Object.fromEntries((action.fields ?? []).map((field) => [field.name, field === key ? picked : entry[field.name] ?? null]));
}
function actionFormState(action, draft = {}) {
  const values = draft?.values ?? {};
  const fields = action.fields ?? [];
  const current = keyedInput(action, currentInput(action), values);
  const input = Object.fromEntries(fields.map((field) => [field.name, Object.hasOwn(values, field.name) ? values[field.name] : current[field.name] ?? impliedOption(field)]));
  const missing = fields.find((field) => isRequired(field, input) && !filled(input[field.name]));
  const unchanged = action.value !== null && action.value !== void 0 && fields.every((field) => same(normalized(input[field.name]), normalized(current[field.name])));
  const confirm = action.confirm && (action.confirm.field === null || action.confirm.values.includes(normalized(input[action.confirm.field]))) ? action.confirm.message : null;
  const hint = !action.available ? action.reason ?? "" : missing ? `Fill in ${missing.label}.` : "";
  return { input, ready: Boolean(action.available) && !unchanged && !missing, confirm, hint };
}
function requestInput(action, input) {
  return Object.fromEntries((action.fields ?? []).map((field) => [field.name, normalized(input[field.name])]));
}
function optionLabel(field, value) {
  return field?.options?.find((option) => option.value === value)?.label ?? value;
}
const holdsChoice = (value) => isRecord(value) ? Object.values(value).some(holdsChoice) : value !== null && value !== void 0 && value !== false;
const wordList = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
function keyedText(action, key, input) {
  const picked = normalized(input[key.name]);
  if (picked !== null) {
    const rest = (action.fields ?? []).filter((field) => field !== key).map((field) => input[field.name]);
    return `${optionLabel(key, picked)}, ${rest.some(holdsChoice) ? "its own choices" : "host defaults"}`;
  }
  const chosen = key.options.filter((option) => holdsChoice(action.value[option.value])).map((option) => option.label ?? option.value);
  return chosen.length ? `Chosen for ${wordList(chosen)}` : "Host defaults";
}
function valueText(action, input = currentInput(action)) {
  const fields = action.fields ?? [];
  if (action.value === null || action.value === void 0) return "";
  const key = keyField(action);
  if (key) return keyedText(action, key, input);
  const choice = fields.find((field) => field.kind !== "text");
  if (choice && input[choice.name] !== null) return String(optionLabel(choice, input[choice.name]));
  return isRecord(action.value) ? Object.values(action.value).filter((item) => item !== null).join(", ") : String(action.value);
}
function readOnlyNotice() {
  return `<p class="notice action-notice" role="note">${escapeHtml(READ_ONLY_NOTICE).replace("prism review", "<code>prism review</code>")}</p>`;
}
const keyOf = (target, action) => `${target}|${action.id}`;
let sequence = 0;
function guidanceHtml(action, choice) {
  const recommended = action.recommended;
  const options = choice?.options ?? [];
  const consequences = action.context ? options.filter((option) => option.consequence) : [];
  const list = consequences.length ? `<ul class="gate-consequences">${consequences.map((option) => `<li><span class="gate-option-label">${escapeHtml(option.label)}</span><span class="gate-consequence">${escapeHtml(option.consequence)}</span></li>`).join("")}</ul>` : "";
  const pick = recommended?.value !== null && recommended?.value !== void 0 ? options.find((option) => option.value === recommended.value) : null;
  const reason = recommended?.reason ? `<p class="gate-recommendation">${badge("Recommended", "accent")} ${pick ? `<span class="gate-option-label">${escapeHtml(pick.label)}</span>: ` : ""}${escapeHtml(recommended.reason)}</p>` : "";
  return list || reason ? `<div class="gate-guidance">${list}${reason}</div>` : "";
}
function contextHtml(action, renderMarkdown) {
  if (!action.context) return "";
  return `<div class="gate-context">${renderMarkdown ? renderMarkdown(action.context) : `<p class="gate-context-plain">${escapeHtml(action.context)}</p>`}</div>`;
}
function shownFields(action, input) {
  const fields = action.fields ?? [];
  const texts = fields.filter((field) => field.kind === "text");
  if (texts.length < 2) return fields;
  const active = texts.some((field) => isRequired(field, input) || filled(input[field.name]));
  return active ? fields : fields.filter((field) => field.kind !== "text");
}
const appliesOnPick = (action) => !action.context && action.fields.length === 1 && !["text", "choices"].includes(action.fields[0].kind);
function selectHtml(action, field, input, { disabled, key }) {
  const picked = normalized(input[field.name]);
  const chosen = field.options.find((option) => option.value === picked);
  const options = field.options.map((option) => `<prism-option value="${escapeHtml(option.value)}"${option.value === picked ? " selected" : ""}${option.reason ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}${option.reason ? ": unavailable" : ""}</prism-option>`).join("");
  const reasons = field.options.filter((option) => option.reason).map((option) => `<p class="action-reason">${escapeHtml(option.reason)}</p>`).join("");
  const consequence = !action.context && chosen?.consequence && !chosen.reason ? `<p class="gate-consequence action-consequence">${escapeHtml(chosen.consequence)}</p>` : "";
  return `<div class="action-choice is-wide"><prism-field class="action-field" type="select" label="${escapeHtml(field.label)}" hint="${escapeHtml(field.hint ?? HOST_HINT)}" value="${escapeHtml(picked ?? "")}" data-select data-field="${escapeHtml(field.name)}" data-focus-key="${escapeHtml(`${key}|${field.name}`)}"${disabled ? " disabled" : ""}>${options}</prism-field>${consequence}${reasons}</div>`;
}
function hostChoiceHtml(action, field, input, { disabled, key, reportReason }) {
  const picked = normalized(input[field.name]);
  const options = field.options.map((option) => {
    const detail = option.reason ?? reportReason(option.value) ?? (action.context ? "" : option.consequence ?? "");
    const off = disabled || Boolean(option.reason);
    return `<prism-choice-option value="${escapeHtml(option.value)}" data-focus-key="${escapeHtml(`${key}|${field.name}|${option.value}`)}"${off ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}${detail ? `<span slot="detail">${escapeHtml(detail)}</span>` : ""}</prism-choice-option>`;
  }).join("");
  const hint = `<p class="action-hint">${escapeHtml(field.hint ?? HOST_HINT)}</p>`;
  return `<div class="action-choice is-wide"><prism-choice class="action-host-choice" aria-label="${escapeHtml(field.label)}" value="${escapeHtml(picked ?? "")}" data-select data-field="${escapeHtml(field.name)}">${options}</prism-choice>${hint}</div>`;
}
function cardsHtml(action, field, input, { disabled, key, form }) {
  const picked = normalized(input[field.name]);
  const recommended = action.recommended?.value ?? null;
  const options = field.options.map((option) => {
    const tone = form.tone?.(option) ?? null;
    const detail = option.reason ?? option.consequence ?? null;
    return `<prism-choice-option value="${escapeHtml(option.value)}" data-focus-key="${escapeHtml(`${key}|${field.name}|${option.value}`)}"${tone ? ` tone="${escapeHtml(tone)}"` : ""}${disabled || option.reason ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}${option.value === recommended ? ` ${badge("Recommended", "accent")}` : ""}${detail ? `<span slot="detail">${escapeHtml(detail)}</span>` : ""}</prism-choice-option>`;
  }).join("");
  const clear = field.required ? "" : `<prism-button size="sm" variant="ghost" data-clear data-field="${escapeHtml(field.name)}" data-focus-key="${escapeHtml(`${key}|${field.name}|clear`)}" tip="Unchoose the option to answer in your own words"${picked === null || disabled ? " hidden" : ""}><prism-icon name="close" size="xs"></prism-icon>Clear choice</prism-button>`;
  const heading = form.heading ? `<p class="label-caps" aria-hidden="true">${escapeHtml(form.heading)}</p>` : "";
  return `<div class="action-cards"><div class="action-cards-head">${heading}${clear}</div><prism-choice aria-label="${escapeHtml(form.heading ?? field.label)}" data-select data-field="${escapeHtml(field.name)}"${field.required ? "" : " clearable"}${picked === null ? "" : ` value="${escapeHtml(picked)}"`}>${options}</prism-choice></div>`;
}
function fieldHtml(action, field, input, { disabled, key, layout, form }) {
  if (impliedOption(field) !== null) return "";
  if (layout.choice(field)) return hostChoiceHtml(action, field, input, { disabled, key, reportReason: layout.reportReason });
  if (layout.select(field)) return selectHtml(action, field, input, { disabled, key });
  if (layout.skip(field)) return "";
  if (field.kind === "text") {
    const required = isRequired(field, input);
    const words = form?.words?.field?.[field.name] ?? null;
    const text = words ? `label="${escapeHtml(words.label)}" placeholder="${escapeHtml(words.placeholder ?? "")}"` : `label="${escapeHtml(field.label)}" hint="${required ? "Required" : "Optional"}"`;
    return `<prism-field class="action-field" type="${field.multiline ? "textarea" : "text"}" ${text} value="${escapeHtml(input[field.name] ?? "")}" data-field="${escapeHtml(field.name)}" data-focus-key="${escapeHtml(`${key}|${field.name}`)}"${field.maxLength ? ` data-max-length="${field.maxLength}"` : ""}${required ? " required" : ""}${disabled ? " disabled" : ""}></prism-field>`;
  }
  if (!Array.isArray(field.options)) return "";
  if (form) return cardsHtml(action, field, input, { disabled, key, form });
  const picked = normalized(input[field.name]);
  const many = field.kind === "choices";
  const isPicked = (value) => many ? (picked ?? []).includes(value) : value === picked;
  const chosen = many ? null : field.options.find((option) => option.value === picked);
  const group = `<div class="action-options" role="group" aria-label="${escapeHtml(field.label)}">${field.options.map((option) => `<prism-button size="sm" pressed="${isPicked(option.value)}" data-option${many ? " data-many" : ""} data-field="${escapeHtml(field.name)}" data-value="${escapeHtml(option.value)}" data-focus-key="${escapeHtml(`${key}|${field.name}|${option.value}`)}"${option.consequence ? ` tip="${escapeHtml(option.consequence)}"` : ""}${disabled ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}</prism-button>`).join("")}</div>`;
  const consequence = !action.context && chosen?.consequence ? `<p class="gate-consequence action-consequence">${escapeHtml(chosen.consequence)}</p>` : "";
  return `<div class="action-choice">${group}${consequence}</div>`;
}
function formWords(form, action, state) {
  const words = form.wording?.(action, state) ?? {};
  return { field: words.field ?? {}, submit: { label: words.submit?.label ?? action.label, variant: words.submit?.variant ?? "primary" }, hint: words.hint ?? state.hint, ready: Boolean(words.ready) && state.ready };
}
function formHintHtml(id, words) {
  return `<p class="action-hint is-form${words.ready ? " is-ready" : ""}" id="${id}-hint" aria-live="polite"><prism-icon name="check-circle" size="sm"${words.ready ? "" : " hidden"}></prism-icon><span class="action-hint-text">${escapeHtml(words.hint)}</span></p>`;
}
function formHtml(action, entry, state, { disabled, layout, renderMarkdown, form, id }) {
  const { key } = entry;
  const words = formWords(form, action, state);
  const fields = shownFields(action, state.input).map((field) => fieldHtml(action, field, state.input, { disabled, key, layout, form: { ...form, words } })).join("");
  const guidance = form.guidance ? `${contextHtml(action, renderMarkdown)}${guidanceHtml(action, null)}` : "";
  const heading = !fields.includes("action-cards") && form.heading ? `<p class="label-caps">${escapeHtml(form.heading)}</p>` : "";
  const ready = !disabled && state.ready;
  return `${guidance}${heading}${fields ? `<div class="action-fields is-form">${fields}</div>` : ""}<div class="action-submit is-form">${formHintHtml(id, words)}${form.leading?.(action) ?? ""}<prism-button variant="${escapeHtml(words.submit.variant)}" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}"${ready ? "" : " disabled"}>${escapeHtml(words.submit.label)}</prism-button>${form.trailing?.(action) ?? ""}</div>`;
}
function actionHtml(action, entry, { writable, renderMarkdown, heading, submitLabel, batch, unavailableButtons, layoutOf, form = null, named = false }) {
  const { key, draft, error, sending } = entry;
  const layout = layoutOf(entry.target, action);
  const state = actionFormState(action, draft);
  const id = `action-${entry.id}`;
  const disabled = !writable || sending;
  const head = heading ? heading(action) : { label: escapeHtml(action.label), detail: "" };
  const label = named ? "" : `<span class="action-label" id="${id}-label">${head.label}</span>`;
  const choice = action.fields.find((field) => field.kind !== "text");
  let control;
  if (form) {
    control = action.available ? formHtml(action, entry, state, { disabled, layout, renderMarkdown, form, id }) : `<p class="action-reason">${escapeHtml(action.reason ?? "")}</p>${form.unavailable?.(action) ?? ""}`;
    return `<div class="action-row is-form" data-action-key="${escapeHtml(key)}" aria-busy="${Boolean(sending)}">
    <div class="action-control">${control}<p class="action-error" role="alert"${error ? "" : " hidden"}>${escapeHtml(error ?? "")}</p></div>
  </div>`;
  }
  if (!action.available) {
    const button = unavailableButtons && !action.fields.length ? `<div class="action-submit"><prism-button size="sm" disabled data-focus-key="${escapeHtml(`${key}|apply`)}">${escapeHtml(submitLabel?.(action) ?? action.label)}</prism-button></div>` : "";
    control = `${button}<p class="action-reason">${escapeHtml(action.reason ?? "")}</p>`;
  } else if (!action.fields.length) {
    control = `<div class="action-submit"><prism-button size="sm" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}"${disabled ? " disabled" : ""}>${escapeHtml(submitLabel?.(action) ?? action.label)}</prism-button></div>`;
  } else {
    const fields = shownFields(action, state.input).map((field) => fieldHtml(action, field, state.input, { disabled, key, layout, form: null })).join("");
    const run = isRunAction(action);
    const slot = run ? `<div data-run-slot="${escapeHtml(key)}"></div>` : "";
    const ready = !run && !disabled && state.ready;
    const reset = run ? `<prism-button size="sm" data-reset data-focus-key="${escapeHtml(`${key}|reset`)}" disabled>Reset</prism-button>` : draft ? `<prism-button size="sm" data-reset data-focus-key="${escapeHtml(`${key}|reset`)}"${sending ? " disabled" : ""}>Reset</prism-button>` : "";
    const submit = batch || appliesOnPick(action) ? "" : `<div class="action-submit"><prism-button size="sm" variant="primary" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}"${ready ? "" : " disabled"}>${escapeHtml(submitLabel?.(action) ?? "Apply")}</prism-button>${reset}<p class="action-hint" id="${id}-hint" aria-live="polite">${run ? "" : escapeHtml(state.hint)}</p></div>`;
    control = `${contextHtml(action, renderMarkdown)}${guidanceHtml(action, choice)}${fields ? `<div class="action-fields">${fields}</div>` : ""}${slot}${submit}`;
  }
  return `<div class="action-row${action.available ? "" : " is-unavailable"}" data-action-key="${escapeHtml(key)}" aria-busy="${Boolean(sending)}">
    <div class="action-meta">${label}${head.detail ? `<span class="action-detail">${head.detail}</span>` : ""}<p class="action-effect" id="${id}-effect">${escapeHtml(action.effect)}</p></div>
    <div class="action-control">${control}<p class="action-error" role="alert"${error ? "" : " hidden"}>${escapeHtml(error ?? "")}</p></div>
  </div>`;
}
const panels = /* @__PURE__ */ new Set();
const ENABLED = "prism-button:not([disabled]), prism-field:not([disabled]), prism-choice-option:not([disabled])";
const focusKeyOf = (element) => element?.closest?.("[data-focus-key]")?.dataset.focusKey ?? null;
const nativeOf = (element) => element?.control ?? (element?.localName === "prism-choice-option" ? element.querySelector("input.prism-choice-input") : null) ?? element;
const isEnabled = (element) => Boolean(element) && !element.hasAttribute("disabled");
function limitFields(root) {
  for (const field of root.querySelectorAll("prism-field[data-max-length]")) if (field.control) field.control.maxLength = Number(field.dataset.maxLength);
}
function shownActionEntries() {
  const entries = [];
  for (const panel of [...panels]) {
    if (!panel.root.isConnected) {
      panels.delete(panel);
      continue;
    }
    if (panel.palette) entries.push(...panel.entries());
  }
  return entries;
}
const lastListings = /* @__PURE__ */ new WeakMap();
function createActionList({ root, targets, api, drafts = {}, renderMarkdown = null, heading = null, submitLabel = null, emptyText = "Nothing can be changed here.", palette = false, compact = false, notice = true, onRender = null, keepStaleDrafts = false, groups = null, actions = null, batch = false, sections = null, unavailableButtons = false, form = null, onApplied = null, onRefused = null }) {
  if (!lastListings.has(api)) lastListings.set(api, /* @__PURE__ */ new Map());
  const known = lastListings.get(api);
  const listings = new Map(targets.filter((target) => known.has(target)).map((target) => [target, known.get(target)]));
  const entries = /* @__PURE__ */ new Map();
  let failure = null;
  let rendered = "";
  let waitingFocus = null;
  let wanted = [...targets];
  const runChoices = /* @__PURE__ */ new Map();
  const reader = typeof api.runOptions === "function" ? createRunOptionsReader((query) => api.runOptions(query), () => {
    if (root.isConnected) render();
  }) : null;
  const reportReason = (host) => reader?.reason(host) ?? null;
  function entryOf(target, action) {
    const key = keyOf(target, action);
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { key, id: ++sequence, target, error: null, sending: false });
    entry.draft = hostFieldOf(action) ? runDraftOf(target, action) : drafts[key] ?? null;
    return entry;
  }
  const actionsOf = () => wanted.flatMap((target) => (listings.get(target)?.actions ?? []).filter((action) => (!groups || groups.includes(action.group)) && (!actions || actions.includes(action.id))).map((action) => ({ target, action })));
  const writable = () => wanted.length > 0 && wanted.every((target) => listings.get(target)?.writable === true);
  const itemOf = (target, action, items = actionsOf()) => items.find((item) => item.target === target && item.action.id === action.id) ?? { target, action };
  function layoutOf(target, action) {
    const items = actionsOf();
    const self = itemOf(target, action, items);
    const leads = items.some((other) => isRunAction(other.action) && hostLeader(other, items) === self);
    const host = hostFieldOf(action);
    const led = Boolean(host && hostLeader(self, items));
    return {
      choice: (field) => leads && field === action.fields[0],
      select: (field) => field === host && !led,
      reportReason,
      skip: (field) => isRunField(field) || field === host && led
    };
  }
  function shownHost(target, action) {
    const items = actionsOf();
    const leader = hostLeader(itemOf(target, action, items), items);
    if (leader) {
      const field = leader.action.fields[0];
      return normalized(actionFormState(leader.action, drafts[keyOf(leader.target, leader.action)] ?? null).input[field.name]);
    }
    const host = hostFieldOf(action);
    const chosen = drafts[keyOf(target, action)]?.host;
    if (chosen) return chosen;
    return normalized(currentInput(action)[host.name]) ?? host.options.find((option) => !option.reason)?.value ?? host.options[0]?.value ?? null;
  }
  function runDraftOf(target, action) {
    const kept = drafts[keyOf(target, action)];
    const host = shownHost(target, action);
    const own = kept?.hosts?.[host] ?? null;
    const noHost = !keyField(action) && normalized(currentInput(action)[hostFieldOf(action).name]) === null;
    if (!own && kept?.host === void 0 && !noHost) return null;
    return { values: { [hostFieldOf(action).name]: host, ...own ?? {} } };
  }
  function runInput(target, action) {
    const host = shownHost(target, action);
    return { host, input: actionFormState(action, { values: { [hostFieldOf(action).name]: host, ...drafts[keyOf(target, action)]?.hosts?.[host] ?? {} } }).input };
  }
  function setRunValue(key, name, value) {
    const item = actionsOf().find((candidate) => keyOf(candidate.target, candidate.action) === key);
    if (!item) return;
    const { target, action } = item;
    const hostName = hostFieldOf(action).name;
    const host = shownHost(target, action);
    const kept = drafts[key] ??= {};
    const hosts = kept.hosts ??= {};
    const values = { ...hosts[host] ?? {}, [name]: value };
    const current = actionFormState(action, { values: { [hostName]: host } }).input;
    for (const [field, chosen] of Object.entries(values)) if (same(normalized(chosen), normalized(current[field]))) delete values[field];
    if (Object.keys(values).length) hosts[host] = values;
    else delete hosts[host];
    if (!Object.keys(hosts).length && kept.host === void 0) delete drafts[key];
    const entry = entryOf(target, action);
    entry.error = null;
    const error = root.querySelector(`[data-action-key="${CSS.escape(key)}"] .action-error`);
    if (error) error.hidden = true;
    syncRunChoices();
    onRender?.();
  }
  function syncRunChoices() {
    for (const { target, action } of actionsOf()) {
      if (!hostFieldOf(action)) continue;
      const key = keyOf(target, action);
      const slot = root.querySelector(`[data-run-slot="${CSS.escape(key)}"]`);
      let controller = runChoices.get(key);
      if (!slot && !controller?.section.isConnected) continue;
      if (!controller) {
        controller = createRunChoices({
          read: (query) => reader ? reader.read(query) : Promise.resolve({ status: 0, json: { message: "This page cannot read the host's run options." } }),
          choose: (name, value) => setRunValue(key, name, value),
          // A report that arrives changes what holds the choices, which the list's owner reads on each render.
          changed: () => onRender?.()
        });
        runChoices.set(key, controller);
      }
      if (slot) slot.replaceWith(controller.section);
      const entry = entryOf(target, action);
      const { host, input } = runInput(target, action);
      const hostField = hostFieldOf(action);
      const hostLabel = hostField.options.find((option) => option.value === host)?.label ?? host ?? "";
      const fixed = runFieldsFixed(action, input);
      const items = actionsOf();
      const leader = hostLeader(itemOf(target, action, items), items);
      const shownReason = leader && host ? leader.action.fields[0].options?.find((option) => option.value === host)?.reason ?? reportReason(host) : null;
      controller.update({ fields: action.fields, input, host: fixed ? null : host, hostLabel, writable: writable() && Boolean(reader), disabled: entry.sending || !action.available || fixed, shownReason });
      const row = controller.section.closest("[data-action-key]");
      if (!row) continue;
      const state = actionFormState(action, entry.draft);
      row.querySelector("[data-apply]")?.toggleAttribute("disabled", !writable() || entry.sending || !state.ready);
      row.querySelector("[data-reset]")?.toggleAttribute("disabled", entry.sending || !entry.draft);
    }
  }
  function html() {
    if (failure && !listings.size) return `<p class="action-error" role="alert">${escapeHtml(failure)}</p>`;
    if (!wanted.every((target) => listings.has(target))) return '<p class="muted action-loading">Loading\u2026</p>';
    const items = actionsOf();
    if (!items.length) return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
    const options = { writable: writable(), renderMarkdown, heading, submitLabel, batch, unavailableButtons, layoutOf, form };
    const readOnly = writable() || !notice ? "" : readOnlyNotice();
    let section = null;
    const rows = items.map(({ target, action }) => {
      const own = sections?.find((candidate) => candidate.actions.includes(action.id)) ?? null;
      const head = own && own !== section ? `<h3 class="action-section">${escapeHtml(own.heading)}</h3>` : "";
      section = own;
      const named = Boolean(own) && own.actions.length === 1 && own.heading === action.label;
      return `${head}${actionHtml(action, entryOf(target, action), { ...options, named })}`;
    });
    return `${readOnly}<div class="action-list${compact ? " is-compact" : ""}${form ? " is-form" : ""}">${rows.join("")}</div>`;
  }
  function render() {
    const next = html();
    if (next === rendered && root.childElementCount) {
      syncRunChoices();
      return;
    }
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const inRun = focused && [...runChoices.values()].some((controller) => controller.section.contains(focused)) ? focused : null;
    const idle = !document.activeElement || document.activeElement === document.body;
    const focusKey = focusKeyOf(focused) ?? (idle ? waitingFocus : null);
    waitingFocus = null;
    const selection = focused && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null;
    rendered = next;
    root.innerHTML = next;
    limitFields(root);
    syncRunChoices();
    if (inRun?.isConnected) inRun.focus({ preventScroll: true });
    else if (focusKey) {
      const target = [...root.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey);
      const fallback = isEnabled(target) ? target : root.querySelector(`[data-action-key="${CSS.escape(focusKey.split("|").slice(0, 2).join("|"))}"] :is(${ENABLED})`);
      if (!isEnabled(target) && target) waitingFocus = focusKey;
      if (isEnabled(fallback)) {
        const control = nativeOf(fallback);
        control.focus({ preventScroll: true });
        if (selection && fallback === target && "setSelectionRange" in control) try {
          control.setSelectionRange(...selection);
        } catch {
        }
      }
    }
    onRender?.();
  }
  const refresh = coalesce(async () => {
    const results = await Promise.all(wanted.map((target) => Promise.resolve(api.list(target)).then((listing) => ({ target, listing }), (error) => ({ target, error }))));
    failure = null;
    for (const { target, listing, error } of results) {
      if (error) failure = error.message;
      else {
        listings.set(target, listing);
        known.set(target, listing);
      }
    }
    if (root.isConnected) render();
  });
  function locate(element) {
    const row = element.closest("[data-action-key]");
    if (!row || !root.contains(row)) return null;
    const item = actionsOf().find(({ target, action }) => keyOf(target, action) === row.dataset.actionKey);
    return item ? { ...item, row, entry: entryOf(item.target, item.action) } : null;
  }
  function setDraft(entry, values) {
    if (values === null) delete drafts[entry.key];
    else drafts[entry.key] = { values };
    entry.draft = drafts[entry.key] ?? null;
  }
  function replaceAction(target, current) {
    const listing = listings.get(target);
    if (!listing || !current) return;
    listings.set(target, { ...listing, actions: listing.actions.map((action) => action.id === current.id ? current : action) });
  }
  async function confirmed_(title, message, entry) {
    const focusKey = focusKeyOf(document.activeElement);
    const accepted = await api.confirm({ title, message });
    if (!root.contains(document.activeElement)) {
      const back = [...root.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey && isEnabled(element)) ?? root.querySelector(`[data-action-key="${CSS.escape(entry.key)}"] :is(${ENABLED})`);
      nativeOf(back)?.focus();
    }
    return accepted;
  }
  async function send(item, values, confirmed = false, retried = false) {
    const { target, action, entry } = item;
    const state = actionFormState(action, { values });
    const title = `Change ${action.label} to ${valueText(action, state.input) || "the new value"}?`;
    if (!confirmed && state.confirm) {
      const accepted = await confirmed_(title, state.confirm, entry);
      if (!accepted) return false;
      confirmed = true;
    }
    entry.sending = true;
    entry.error = null;
    render();
    let answer;
    try {
      answer = await api.apply({ action: action.id, target: action.target ?? target, input: requestInput(action, state.input), revision: action.revision, ...confirmed ? { confirmed: true } : {} });
    } catch (error) {
      answer = { status: 0, json: { message: error.message } };
    }
    entry.sending = false;
    const result = answer.json ?? {};
    if (answer.status === 200) {
      setDraft(entry, null);
      listings.set(target, { ...listings.get(target), actions: result.actions ?? listings.get(target).actions });
      if (onApplied) onApplied(action, requestInput(action, state.input), result);
      else if (result.applied) api.toast(`${action.label}: ${valueText(action, state.input) || "done"}. ${action.effect}`);
      render();
      return true;
    }
    if (result.code === "confirmation_required" && !confirmed) {
      render();
      if (await confirmed_(title, result.message, entry)) return send(locate(root.querySelector(`[data-action-key="${CSS.escape(entry.key)}"]`)) ?? item, values, true);
      return false;
    }
    if (form && !retried && result.code === "stale_revision" && result.current?.available) {
      replaceAction(target, result.current);
      return send({ ...item, action: result.current }, values, confirmed, true);
    }
    if (result.code === "stale_revision" || result.code === "action_unavailable") {
      if (!keepStaleDrafts && !form) setDraft(entry, null);
      const own = onRefused?.(action, result) ?? null;
      if (own) entry.error = own;
      replaceAction(target, result.current);
      if (!own) api.toast(STALE_MESSAGE);
      render();
      void refresh();
      return false;
    }
    if (result.code === "write_forbidden") {
      for (const name of wanted) if (listings.has(name)) listings.set(name, { ...listings.get(name), writable: false });
    } else {
      entry.error = onRefused?.(action, result) ?? result.message ?? "The change was not applied.";
    }
    render();
    return false;
  }
  function updateForm(item, state) {
    const words = formWords(form, item.action, state);
    const apply = item.row.querySelector("[data-apply]");
    if (apply) {
      if (apply.textContent !== words.submit.label) apply.textContent = words.submit.label;
      apply.setAttribute("variant", words.submit.variant);
    }
    const hint = item.row.querySelector(".action-hint");
    if (hint) {
      const text = hint.querySelector(".action-hint-text");
      if (text.textContent !== words.hint) text.textContent = words.hint;
      hint.classList.toggle("is-ready", words.ready && !item.entry.sending);
      hint.querySelector("prism-icon").hidden = !(words.ready && !item.entry.sending);
    }
    for (const field of item.row.querySelectorAll("prism-field[data-field]:not([data-select])")) {
      const own = words.field[field.dataset.field];
      const required = isRequired(item.action.fields.find((candidate) => candidate.name === field.dataset.field), state.input);
      field.toggleAttribute("required", required);
      if (own) {
        if (field.getAttribute("label") !== own.label) field.setAttribute("label", own.label);
        if (field.getAttribute("placeholder") !== (own.placeholder ?? "")) field.setAttribute("placeholder", own.placeholder ?? "");
      }
    }
    item.row.querySelector(".action-error").hidden = true;
  }
  root.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-run-choices]")) return;
    const button = event.target.closest("prism-button");
    if (!button || button.disabled || !root.contains(button)) return;
    const item = locate(button);
    if (!item) return;
    const values = { ...item.entry.draft?.values ?? {} };
    if (button.hasAttribute("data-option")) {
      if (button.hasAttribute("data-many")) {
        const field = item.action.fields.find((candidate) => candidate.name === button.dataset.field);
        const current = new Set(normalized(values[button.dataset.field] ?? currentInput(item.action)[button.dataset.field]) ?? []);
        if (current.has(button.dataset.value)) current.delete(button.dataset.value);
        else current.add(button.dataset.value);
        values[button.dataset.field] = field.options.map((option) => option.value).filter((value) => current.has(value));
      } else {
        values[button.dataset.field] = button.dataset.value;
      }
      item.entry.error = null;
      if (!batch && appliesOnPick(item.action)) {
        if (actionFormState(item.action, { values }).ready) void send(item, values);
        return;
      }
      setDraft(item.entry, values);
      render();
    } else if (button.hasAttribute("data-clear")) {
      item.entry.error = null;
      setDraft(item.entry, { ...values, [button.dataset.field]: null });
      render();
      nativeOf(root.querySelector(`[data-action-key="${CSS.escape(item.entry.key)}"] prism-field:not([disabled])`))?.focus();
    } else if (button.hasAttribute("data-reset")) {
      item.entry.error = null;
      setDraft(item.entry, null);
      render();
      nativeOf(root.querySelector(`[data-action-key="${CSS.escape(item.entry.key)}"] :is(${ENABLED})`))?.focus();
    } else if (button.hasAttribute("data-apply")) {
      if (actionFormState(item.action, item.entry.draft ?? { values }).ready) void send(item, values);
    }
  });
  root.addEventListener("input", (event) => {
    const field = event.target.closest("prism-field[data-field]:not([data-select])");
    const item = field && locate(field);
    if (!item) return;
    setDraft(item.entry, { ...item.entry.draft?.values ?? {}, [field.dataset.field]: field.value });
    item.entry.error = null;
    const state = actionFormState(item.action, item.entry.draft);
    const apply = item.row.querySelector("[data-apply]");
    if (apply) apply.toggleAttribute("disabled", !state.ready || item.entry.sending);
    if (form) {
      updateForm(item, state);
      return;
    }
    const hint = item.row.querySelector(".action-hint");
    if (hint && hint.textContent !== state.hint) hint.textContent = state.hint;
    item.row.querySelector(".action-error").hidden = true;
    for (const other of item.row.querySelectorAll("prism-field[data-field]")) {
      const required = isRequired(item.action.fields.find((candidate) => candidate.name === other.dataset.field), state.input);
      other.toggleAttribute("required", required);
      other.setAttribute("hint", required ? "Required" : "Optional");
    }
    if (!item.row.querySelector("[data-reset]")) {
      rendered = "";
      render();
    }
  });
  root.addEventListener("change", (event) => {
    const field = event.target.closest?.(":is(prism-field, prism-choice)[data-select]");
    const item = field && root.contains(field) ? locate(field) : null;
    if (!item) return;
    item.entry.error = null;
    if (isRunAction(item.action)) {
      (drafts[item.entry.key] ??= {}).host = field.value;
      render();
      return;
    }
    const values = { ...item.entry.draft?.values ?? {}, [field.dataset.field]: field.value };
    if (!batch && appliesOnPick(item.action)) {
      if (actionFormState(item.action, { values }).ready) void send(item, values);
      else render();
      return;
    }
    setDraft(item.entry, values);
    render();
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.tagName !== "INPUT" || !event.target.closest("prism-field") || event.target.closest("[data-run-choices]") || event.isComposing) return;
    const item = locate(event.target);
    if (!item?.entry.draft) return;
    event.preventDefault();
    if (actionFormState(item.action, item.entry.draft).ready) void send(item, item.entry.draft.values);
  });
  const pending = () => actionsOf().map(({ target, action }) => ({ target, action, entry: entryOf(target, action) })).filter(({ action, entry }) => action.available && entry.draft && actionFormState(action, entry.draft).ready);
  const listedAction = (id) => {
    for (const target of wanted) {
      const action = (listings.get(target)?.actions ?? []).find((candidate) => candidate.id === id);
      if (action) return { target, action };
    }
    return null;
  };
  const panel = {
    root,
    palette,
    /** The number of changes a batch list holds. */
    changes: () => pending().length,
    /** Whether this tab may apply the list's actions. */
    writable: () => writable(),
    /** An action of the listing by its id, drawn or not, or null while the listing is not read. */
    action: (id) => listedAction(id)?.action ?? null,
    /** The input an action of the list shows, with the person's unsent changes, or null. */
    input(id) {
      const item = listedAction(id);
      return item ? actionFormState(item.action, drafts[keyOf(item.target, item.action)] ?? null).input : null;
    },
    /** Why a host's latest report says it cannot run, such as a sign-in it needs, as the choice of host shows it under that host, or null. */
    reportReason: (host) => reportReason(host),
    /** What holds the list's run choices: reading while a shown choice waits for its host, and each choice not offered as { label, reason }. */
    held() {
      const held = { reading: false, reasons: [] };
      for (const controller of runChoices.values()) {
        if (!controller.section.isConnected || !root.contains(controller.section)) continue;
        const own = controller.held();
        held.reading ||= own.reading;
        held.reasons.push(...own.reasons);
      }
      return held;
    },
    /**
     * Applies an action of the listing that takes no input, such as the launch that follows a batch list's changes: { ok, message },
     * with the refusal's message when it did not apply. Its result's listing replaces the list's.
     */
    async follow(id) {
      const item = listedAction(id);
      if (!item) return { ok: false, message: "This action is not listed here." };
      const { target, action } = item;
      if (!action.available) return { ok: false, message: action.reason ?? "" };
      let answer;
      try {
        answer = await api.apply({ action: action.id, target: action.target ?? target, input: requestInput(action, currentInput(action)), revision: action.revision });
      } catch (error) {
        answer = { status: 0, json: { message: error.message } };
      }
      const result = answer.json ?? {};
      if (answer.status === 200) {
        if (result.actions) listings.set(target, { ...listings.get(target), actions: result.actions });
        if (result.applied) api.toast(`${action.label}: done. ${action.effect}`);
        render();
        return { ok: true, message: null };
      }
      if (result.code === "write_forbidden") {
        for (const name of wanted) if (listings.has(name)) listings.set(name, { ...listings.get(name), writable: false });
      }
      void refresh();
      return { ok: false, message: result.message ?? `${action.label} did not apply.` };
    },
    /**
     * Applies a batch list's changes one by one in the list's order, and stops at the first one that is refused or not confirmed; true when all applied.
     * Each change is read from the listing that the change before it returned, since settings that share a record share its revision.
     */
    async applyAll() {
      for (let item = pending()[0]; item; item = pending()[0]) {
        if (!await send(item, item.entry.draft.values)) return false;
      }
      return true;
    },
    /** Forgets every unsent change of the list, and closes its pickers, which read the hosts again when they show next. */
    discard() {
      reader?.forget();
      for (const controller of runChoices.values()) controller.reset();
      for (const { target, action } of actionsOf()) {
        const entry = entryOf(target, action);
        entry.error = null;
        setDraft(entry, null);
      }
      rendered = "";
      render();
    },
    entries: () => actionsOf().filter(({ action }) => action.available).map(({ target, action }) => ({
      ref: `action:${keyOf(target, action)}`,
      kind: "action",
      label: valueText(action) ? `${action.label}: ${valueText(action)}` : action.label,
      detail: action.group,
      run: () => panel.focusAction(action.id, target)
    })),
    // Moves focus to an action's control: its picked option, or its first enabled control.
    focusAction(id, target = wanted[0]) {
      const row = root.querySelector(`[data-action-key="${CSS.escape(`${target}|${id}`)}"]`);
      if (!row) return false;
      row.scrollIntoView({ block: "nearest" });
      const control = row.querySelector('prism-button[data-option][pressed="true"]:not([disabled])') ?? row.querySelector(ENABLED) ?? row;
      if (control === row) row.tabIndex = -1;
      nativeOf(control).focus();
      return true;
    },
    setTargets(next) {
      wanted = [...next];
      return refresh();
    },
    // Moves the list from one target to another that names the same record, as a file that moved to another scope, keeping each action's unsent input,
    // its drawn controls, and the focused control with its cursor in place while the new target's listing loads.
    retarget(from, to) {
      if (from === to || !wanted.includes(from)) return refresh();
      const prefix = `${from}|`;
      const moved = (key) => key?.startsWith(prefix) ? `${to}|${key.slice(prefix.length)}` : key;
      for (const key of Object.keys(drafts)) if (key.startsWith(prefix)) {
        drafts[moved(key)] = drafts[key];
        delete drafts[key];
      }
      for (const [key, entry] of [...entries]) if (key.startsWith(prefix)) {
        entries.delete(key);
        entries.set(moved(key), Object.assign(entry, { key: moved(key), target: to }));
      }
      const listing = listings.get(from);
      listings.delete(from);
      if (listing) listings.set(to, { ...listing, actions: (listing.actions ?? []).map((action) => action.target === from ? { ...action, target: to } : action) });
      wanted = wanted.map((target) => target === from ? to : target);
      for (const element of root.querySelectorAll("[data-action-key], [data-focus-key]")) {
        if (element.dataset.actionKey) element.dataset.actionKey = moved(element.dataset.actionKey);
        if (element.dataset.focusKey) element.dataset.focusKey = moved(element.dataset.focusKey);
      }
      waitingFocus = moved(waitingFocus);
      rendered = html();
      return refresh();
    },
    refresh,
    render
  };
  panels.add(panel);
  let checking = null;
  const onChange = (event) => {
    if (!root.isConnected) {
      document.removeEventListener("prism:action", onChange);
      document.removeEventListener("prism:poll", onChange);
      panels.delete(panel);
      return;
    }
    if (event?.type !== "prism:poll") {
      void refresh();
      return;
    }
    if (checking) return;
    checking = refresh().catch(() => {
    }).finally(() => {
      checking = null;
    });
  };
  document.addEventListener("prism:action", onChange);
  document.addEventListener("prism:poll", onChange);
  const drawn = wanted.every((target) => listings.has(target));
  render();
  const first = refresh().catch(() => {
  });
  panel.loaded = drawn ? Promise.resolve() : first;
  return panel;
}
function mountInitiativeSettings(slot, { target, eyebrow, ctx }) {
  if (!slot || !ctx.actionApi) return null;
  slot.innerHTML = `<prism-panel class="view-section settings-panel" heading="Initiative settings" eyebrow="${escapeHtml(eyebrow)}"><div data-action-list></div></prism-panel>`;
  return createActionList({ root: slot.querySelector("[data-action-list]"), targets: [target], api: ctx.actionApi, drafts: ctx.state.actionDrafts ??= {}, renderMarkdown: ctx.renderMarkdown ?? null, palette: true, emptyText: "This initiative has no settings to change." });
}
export {
  READ_ONLY_NOTICE,
  STALE_MESSAGE,
  actionFormState,
  createActionList,
  currentInput,
  mountInitiativeSettings,
  readOnlyNotice,
  requestInput,
  shownActionEntries,
  valueText
};
