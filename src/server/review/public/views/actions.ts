import { badge, escapeHtml } from "./util.js";
import { coalesce } from "./poller.js";
import { createRunChoices, createRunOptionsReader, HOST_HINT, hostFieldOf, hostLeader, isRunAction, isRunField, runFieldsFixed } from "./run-choices.js";

// The page draws every action from its listing: the registry names the fields, and this view places them as kit controls:
// a prism-field per text field, a group of pressed prism-buttons per choice, a prism-choice per choice of host that leads run choices
// and a select prism-field per run action's own choice of host, a prism-picker
// per run choice, such as a model and its effort, and prism-buttons to apply and reset.
export const READ_ONLY_NOTICE = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";
export const STALE_MESSAGE = "Someone changed this since you opened it; it now shows the current value.";

const isRecord = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
// Text counts as a value only when it holds more than whitespace, as the server reads it.
const normalized = (value: any) => typeof value === "string" ? (value.trim() ? value.trim() : null) : value ?? null;
const filled = (value: any) => normalized(value) !== null;
// Two values are the same when they read alike, so a run choice chosen back to what is stored is no change.
const same = (left: any, right: any) => isRecord(left) || isRecord(right) ? JSON.stringify(left ?? null) === JSON.stringify(right ?? null) : left === right;

/** Each field's current value: a one-field action holds its value, and an object value fills the fields it names. */
export function currentInput(action: any) {
  const fields = action.fields ?? [];
  const input = Object.fromEntries(fields.map((field: any) => [field.name, null]));
  const value = action.value;
  if (value === null || value === undefined) return input;
  if (!isRecord(value)) {
    if (fields[0]) input[fields[0].name] = value;
    return input;
  }
  for (const field of fields) if (Object.hasOwn(value, field.name)) input[field.name] = value[field.name] ?? null;
  // The choice an object value stands for is the one under which the fields it holds become required.
  for (const field of fields) {
    if (field.kind === "text" || input[field.name] !== null) continue;
    const dependent = fields.find((other: any) => other.requiredWhen?.field === field.name && Object.hasOwn(value, other.name));
    const implied = dependent?.requiredWhen.values.find((item: any) => item !== null);
    if (implied !== undefined) input[field.name] = implied;
  }
  return input;
}

// A required choice of one option, such as an assistance question's Done, offers nothing to pick, so it holds that option and draws no control.
const impliedOption = (field: any) => field.kind !== "text" && field.required && Array.isArray(field.options) && field.options.length === 1 ? field.options[0].value : null;

function isRequired(field: any, input: any) {
  if (field.required) return true;
  const when = field.requiredWhen;
  return Boolean(when) && when.values.includes(normalized(input[when.field]));
}

// A value kept per option of a choice, such as the models kept per host, is keyed by that choice's option values.
function keyField(action: any) {
  const value = action.value;
  if (!isRecord(value)) return null;
  return (action.fields ?? []).find((field: any) => Array.isArray(field.options) && field.options.length > 0 && field.options.every((option: any) => Object.hasOwn(value, option.value))) ?? null;
}

// The picked option's entry fills the other fields, so a field this view does not draw sends what is stored, and a pick alone is no change.
// A run action whose value holds the choices of one host, such as Prism's own runs, holds them for that host only, so another host's
// choices start from its defaults, and choosing that host is itself the change.
function keyedInput(action: any, current: any, values: any) {
  const key = keyField(action);
  const host = key ? null : hostFieldOf(action);
  if (host && Object.hasOwn(values, host.name) && normalized(values[host.name]) !== current[host.name]) {
    return Object.fromEntries((action.fields ?? []).map((field: any) => [field.name, isRunField(field) ? null : current[field.name]]));
  }
  const picked = key ? normalized(Object.hasOwn(values, key.name) ? values[key.name] : current[key.name]) : null;
  const entry = picked === null ? null : action.value[picked];
  if (!isRecord(entry)) return current;
  return Object.fromEntries((action.fields ?? []).map((field: any) => [field.name, field === key ? picked : entry[field.name] ?? null]));
}

/** The state of one action's control from the person's draft: { input, ready, confirm, hint }. */
export function actionFormState(action: any, draft: any = {}) {
  const values = draft?.values ?? {};
  const fields = action.fields ?? [];
  const current = keyedInput(action, currentInput(action), values);
  const input = Object.fromEntries(fields.map((field: any) => [field.name, Object.hasOwn(values, field.name) ? values[field.name] : current[field.name] ?? impliedOption(field)]));
  const missing = fields.find((field: any) => isRequired(field, input) && !filled(input[field.name]));
  // An action without a value, such as an answer or a rebuild, is never unchanged; a setting is unchanged while every field holds its current value.
  const unchanged = action.value !== null && action.value !== undefined && fields.every((field: any) => same(normalized(input[field.name]), normalized(current[field.name])));
  const confirm = action.confirm && action.confirm.values.includes(normalized(input[action.confirm.field])) ? action.confirm.message : null;
  const hint = !action.available ? action.reason ?? "" : missing ? `Fill in ${missing.label}.` : "";
  return { input, ready: Boolean(action.available) && !unchanged && !missing, confirm, hint };
}

/** The request input of a form state: every field, with text trimmed and empty values as null. */
export function requestInput(action: any, input: any) {
  return Object.fromEntries((action.fields ?? []).map((field: any) => [field.name, normalized(input[field.name])]));
}

function optionLabel(field: any, value: any) {
  return field?.options?.find((option: any) => option.value === value)?.label ?? value;
}

// Whether a kept entry holds a choice of the person's: any part that is not null, false, or an object of such parts.
const holdsChoice = (value: any): boolean => (isRecord(value) ? Object.values(value).some(holdsChoice) : value !== null && value !== undefined && value !== false);

const wordList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// A value kept per option reads as the picked option with whether its fields hold choices, or else the options that hold choices.
function keyedText(action: any, key: any, input: any) {
  const picked = normalized(input[key.name]);
  if (picked !== null) {
    const rest = (action.fields ?? []).filter((field: any) => field !== key).map((field: any) => input[field.name]);
    return `${optionLabel(key, picked)}, ${rest.some(holdsChoice) ? "its own choices" : "host defaults"}`;
  }
  const chosen = key.options.filter((option: any) => holdsChoice(action.value[option.value])).map((option: any) => option.label ?? option.value);
  return chosen.length ? `Chosen for ${wordList(chosen)}` : "Host defaults";
}

/** A short reading of a value for a label, such as "On", "Custom", or "Chosen for Codex". */
export function valueText(action: any, input = currentInput(action)) {
  const fields = action.fields ?? [];
  if (action.value === null || action.value === undefined) return "";
  const key = keyField(action);
  if (key) return keyedText(action, key, input);
  const choice = fields.find((field: any) => field.kind !== "text");
  if (choice && input[choice.name] !== null) return String(optionLabel(choice, input[choice.name]));
  return isRecord(action.value) ? Object.values<any>(action.value).filter((item) => item !== null).join(", ") : String(action.value);
}

/** The note that a tab without a write session can only read, as the kit's notice. */
export function readOnlyNotice() {
  return `<p class="notice action-notice" role="note">${escapeHtml(READ_ONLY_NOTICE).replace("prism review", "<code>prism review</code>")}</p>`;
}

const keyOf = (target: any, action: any) => `${target}|${action.id}`;
let sequence = 0;

// One action's fields, or its reason in place of them when it is unavailable.
// Each option's consequence shows as its tooltip and, for the picked option, under the group; an action with context lists them all with the recommendation.
function guidanceHtml(action: any, choice: any) {
  const recommended = action.recommended;
  const options = choice?.options ?? [];
  const consequences = action.context ? options.filter((option: any) => option.consequence) : [];
  const list = consequences.length
    ? `<ul class="gate-consequences">${consequences.map((option: any) => `<li><span class="gate-option-label">${escapeHtml(option.label)}</span><span class="gate-consequence">${escapeHtml(option.consequence)}</span></li>`).join("")}</ul>`
    : "";
  const pick = recommended?.value !== null && recommended?.value !== undefined ? options.find((option: any) => option.value === recommended.value) : null;
  const reason = recommended?.reason ? `<p class="gate-recommendation">${badge("Recommended", "accent")} ${pick ? `<span class="gate-option-label">${escapeHtml(pick.label)}</span>: ` : ""}${escapeHtml(recommended.reason)}</p>` : "";
  return list || reason ? `<div class="gate-guidance">${list}${reason}</div>` : "";
}

function contextHtml(action: any, renderMarkdown: any) {
  if (!action.context) return "";
  return `<div class="gate-context">${renderMarkdown ? renderMarkdown(action.context) : `<p class="gate-context-plain">${escapeHtml(action.context)}</p>`}</div>`;
}

// A group of several conditional text fields, such as custom model names, shows only while its condition holds or one of them holds a value.
function shownFields(action: any, input: any) {
  const fields = action.fields ?? [];
  const texts = fields.filter((field: any) => field.kind === "text");
  if (texts.length < 2) return fields;
  const active = texts.some((field: any) => isRequired(field, input) || filled(input[field.name]));
  return active ? fields : fields.filter((field: any) => field.kind !== "text");
}

// A one-choice setting applies when an option is picked; an action with text or several fields applies with its own button.
const appliesOnPick = (action: any) => !action.context && action.fields.length === 1 && action.fields[0].kind !== "text";

// A run action's own choice of host is one select: a host this computer lacks shows as unavailable and cannot be chosen, with its reason
// below, and the field's own hint, such as why a stored choice cannot be read, takes the place of the hosts' hint.
function selectHtml(action: any, field: any, input: any, { disabled, key }: { disabled: any; key: any }) {
  const picked = normalized(input[field.name]);
  const chosen = field.options.find((option: any) => option.value === picked);
  const options = field.options.map((option: any) => `<prism-option value="${escapeHtml(option.value)}"${option.value === picked ? " selected" : ""}${option.reason ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}${option.reason ? ": unavailable" : ""}</prism-option>`).join("");
  const reasons = field.options.filter((option: any) => option.reason).map((option: any) => `<p class="action-reason">${escapeHtml(option.reason)}</p>`).join("");
  const consequence = !action.context && chosen?.consequence && !chosen.reason ? `<p class="gate-consequence action-consequence">${escapeHtml(chosen.consequence)}</p>` : "";
  return `<div class="action-choice is-wide"><prism-field class="action-field" type="select" label="${escapeHtml(field.label)}" hint="${escapeHtml(field.hint ?? HOST_HINT)}" value="${escapeHtml(picked ?? "")}" data-select data-field="${escapeHtml(field.name)}" data-focus-key="${escapeHtml(`${key}|${field.name}`)}"${disabled ? " disabled" : ""}>${options}</prism-field>${consequence}${reasons}</div>`;
}

// The choice of host that leads a list's run choices, as in the Launch and Settings dialogs, is a prism-choice of every host the
// listing names, in its order: each option shows under its label why it cannot run, from the listing or from the host's own report
// once read, such as a sign-in it needs, and otherwise what choosing it does; a host this computer lacks cannot be chosen. The row's
// own label names the choice, so the group carries the name only for assistive technology.
function hostChoiceHtml(action: any, field: any, input: any, { disabled, key, reportReason }: { disabled: any; key: any; reportReason: (host: string) => string | null }) {
  const picked = normalized(input[field.name]);
  const options = field.options.map((option: any) => {
    const detail = option.reason ?? reportReason(option.value) ?? (action.context ? "" : option.consequence ?? "");
    const off = disabled || Boolean(option.reason);
    return `<prism-choice-option value="${escapeHtml(option.value)}" data-focus-key="${escapeHtml(`${key}|${field.name}|${option.value}`)}"${off ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}${detail ? `<span slot="detail">${escapeHtml(detail)}</span>` : ""}</prism-choice-option>`;
  }).join("");
  const hint = `<p class="action-hint">${escapeHtml(field.hint ?? HOST_HINT)}</p>`;
  return `<div class="action-choice is-wide"><prism-choice class="action-host-choice" aria-label="${escapeHtml(field.label)}" value="${escapeHtml(picked ?? "")}" data-select data-field="${escapeHtml(field.name)}">${options}</prism-choice>${hint}</div>`;
}

// A form draws a choice as kit choice cards: each option with its consequence under its label, or, for an option that does not apply, disabled with
// its reason there, the recommended one with its badge, and a tone the form gives it, such as Request changes in danger. A choice that is not required can be unpicked with Clear choice, leaving the answer to the text fields.
function cardsHtml(action: any, field: any, input: any, { disabled, key, form }: { disabled: any; key: any; form: any }) {
  const picked = normalized(input[field.name]);
  const recommended = action.recommended?.value ?? null;
  const options = field.options.map((option: any) => {
    const tone = form.tone?.(option) ?? null;
    const detail = option.reason ?? option.consequence ?? null;
    return `<prism-choice-option value="${escapeHtml(option.value)}" data-focus-key="${escapeHtml(`${key}|${field.name}|${option.value}`)}"${tone ? ` tone="${escapeHtml(tone)}"` : ""}${disabled || option.reason ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}${option.value === recommended ? ` ${badge("Recommended", "accent")}` : ""}${detail ? `<span slot="detail">${escapeHtml(detail)}</span>` : ""}</prism-choice-option>`;
  }).join("");
  const clear = field.required ? "" : `<prism-button size="sm" variant="ghost" data-clear data-field="${escapeHtml(field.name)}" data-focus-key="${escapeHtml(`${key}|${field.name}|clear`)}" tip="Unchoose the option to answer in your own words"${picked === null || disabled ? " hidden" : ""}><prism-icon name="close" size="xs"></prism-icon>Clear choice</prism-button>`;
  const heading = form.heading ? `<p class="label-caps" aria-hidden="true">${escapeHtml(form.heading)}</p>` : "";
  return `<div class="action-cards"><div class="action-cards-head">${heading}${clear}</div><prism-choice aria-label="${escapeHtml(form.heading ?? field.label)}" data-select data-field="${escapeHtml(field.name)}"${field.required ? "" : " clearable"}${picked === null ? "" : ` value="${escapeHtml(picked)}"`}>${options}</prism-choice></div>`;
}

function fieldHtml(action: any, field: any, input: any, { disabled, key, layout, form }: { disabled: any; key: any; layout: any; form: any }) {
  if (impliedOption(field) !== null) return "";
  if (layout.choice(field)) return hostChoiceHtml(action, field, input, { disabled, key, reportReason: layout.reportReason });
  if (layout.select(field)) return selectHtml(action, field, input, { disabled, key });
  if (layout.skip(field)) return "";
  if (field.kind === "text") {
    const required = isRequired(field, input);
    // The field's hint says whether it is required, or a form's own words for the field do; maxlength reaches the native control after the field is drawn.
    const words = form?.words?.field?.[field.name] ?? null;
    const text = words ? `label="${escapeHtml(words.label)}" placeholder="${escapeHtml(words.placeholder ?? "")}"` : `label="${escapeHtml(field.label)}" hint="${required ? "Required" : "Optional"}"`;
    return `<prism-field class="action-field" type="${field.multiline ? "textarea" : "text"}" ${text} value="${escapeHtml(input[field.name] ?? "")}" data-field="${escapeHtml(field.name)}" data-focus-key="${escapeHtml(`${key}|${field.name}`)}"${field.maxLength ? ` data-max-length="${field.maxLength}"` : ""}${required ? " required" : ""}${disabled ? " disabled" : ""}></prism-field>`;
  }
  // A field without options, such as a run choice, has a control of its own that this generic view does not draw.
  if (!Array.isArray(field.options)) return "";
  if (form) return cardsHtml(action, field, input, { disabled, key, form });
  const picked = normalized(input[field.name]);
  const chosen = field.options.find((option: any) => option.value === picked);
  const group = `<div class="action-options" role="group" aria-label="${escapeHtml(field.label)}">${field.options.map((option: any) =>
    `<prism-button size="sm" pressed="${option.value === picked}" data-option data-field="${escapeHtml(field.name)}" data-value="${escapeHtml(option.value)}" data-focus-key="${escapeHtml(`${key}|${field.name}|${option.value}`)}"${option.consequence ? ` tip="${escapeHtml(option.consequence)}"` : ""}${disabled ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}</prism-button>`).join("")}</div>`;
  const consequence = !action.context && chosen?.consequence ? `<p class="gate-consequence action-consequence">${escapeHtml(chosen.consequence)}</p>` : "";
  return `<div class="action-choice">${group}${consequence}</div>`;
}

// A form's own words for its state: each text field's label and placeholder, the submit button's label and variant, and the line beside it,
// which reads as ready once the action can be sent.
function formWords(form: any, action: any, state: any) {
  const words = form.wording?.(action, state) ?? {};
  return { field: words.field ?? {}, submit: { label: words.submit?.label ?? action.label, variant: words.submit?.variant ?? "primary" }, hint: words.hint ?? state.hint, ready: Boolean(words.ready) && state.ready };
}

function formHintHtml(id: string, words: any) {
  return `<p class="action-hint is-form${words.ready ? " is-ready" : ""}" id="${id}-hint" aria-live="polite"><prism-icon name="check-circle" size="sm"${words.ready ? "" : " hidden"}></prism-icon><span class="action-hint-text">${escapeHtml(words.hint)}</span></p>`;
}

// One action drawn as a form, such as a question's answer: its fields, then the line that says what is missing or that it is ready, its submit button, and what the form adds after it.
// The page around the form shows the action's context and recommendation unless the form asks for them.
function formHtml(action: any, entry: any, state: any, { disabled, layout, renderMarkdown, form, id }: any) {
  const { key } = entry;
  const words = formWords(form, action, state);
  const fields = shownFields(action, state.input).map((field: any) => fieldHtml(action, field, state.input, { disabled, key, layout, form: { ...form, words } })).join("");
  const guidance = form.guidance ? `${contextHtml(action, renderMarkdown)}${guidanceHtml(action, null)}` : "";
  const heading = !fields.includes("action-cards") && form.heading ? `<p class="label-caps">${escapeHtml(form.heading)}</p>` : "";
  const ready = !disabled && state.ready;
  return `${guidance}${heading}${fields ? `<div class="action-fields is-form">${fields}</div>` : ""}<div class="action-submit is-form">${formHintHtml(id, words)}<prism-button variant="${escapeHtml(words.submit.variant)}" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}"${ready ? "" : " disabled"}>${escapeHtml(words.submit.label)}</prism-button>${form.trailing?.(action) ?? ""}</div>`;
}

function actionHtml(action: any, entry: any, { writable, renderMarkdown, heading, submitLabel, batch, unavailableButtons, layoutOf, form = null, named = false }: { writable: any; renderMarkdown: any; heading: any; submitLabel: any; batch: any; unavailableButtons: any; layoutOf: any; form?: any; named?: boolean }) {
  const { key, draft, error, sending } = entry;
  const layout = layoutOf(entry.target, action);
  const state = actionFormState(action, draft);
  const id = `action-${entry.id}`;
  const disabled = !writable || sending;
  const head = heading ? heading(action) : { label: escapeHtml(action.label), detail: "" };
  // A row that its section's heading already names, as Models under Models, shows only its effect.
  const label = named ? "" : `<span class="action-label" id="${id}-label">${head.label}</span>`;
  const choice = action.fields.find((field: any) => field.kind !== "text");
  let control;
  // A form that can no longer be sent, such as a question someone already answered, shows only why, and what the form adds to that.
  if (form) {
    control = action.available ? formHtml(action, entry, state, { disabled, layout, renderMarkdown, form, id }) : `<p class="action-reason">${escapeHtml(action.reason ?? "")}</p>${form.unavailable?.(action) ?? ""}`;
    return `<div class="action-row is-form" data-action-key="${escapeHtml(key)}" aria-busy="${Boolean(sending)}">
    <div class="action-control">${control}<p class="action-error" role="alert"${error ? "" : " hidden"}>${escapeHtml(error ?? "")}</p></div>
  </div>`;
  }
  if (!action.available) {
    // A list of a few actions without fields, such as a launched session's, keeps each one's button, unavailable, beside its reason.
    const button = unavailableButtons && !action.fields.length ? `<div class="action-submit"><prism-button size="sm" disabled data-focus-key="${escapeHtml(`${key}|apply`)}">${escapeHtml(submitLabel?.(action) ?? action.label)}</prism-button></div>` : "";
    control = `${button}<p class="action-reason">${escapeHtml(action.reason ?? "")}</p>`;
  } else if (!action.fields.length) {
    control = `<div class="action-submit"><prism-button size="sm" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}"${disabled ? " disabled" : ""}>${escapeHtml(submitLabel?.(action) ?? action.label)}</prism-button></div>`;
  } else {
    const fields = shownFields(action, state.input).map((field: any) => fieldHtml(action, field, state.input, { disabled, key, layout, form: null })).join("");
    // The run choices are kit pickers that stay in place while the list redraws, so their row draws only where they go,
    // and its buttons are drawn alike with or without a change, which the pickers enable in place.
    const run = isRunAction(action);
    const slot = run ? `<div data-run-slot="${escapeHtml(key)}"></div>` : "";
    const ready = !run && !disabled && state.ready;
    const reset = run ? `<prism-button size="sm" data-reset data-focus-key="${escapeHtml(`${key}|reset`)}" disabled>Reset</prism-button>` : draft ? `<prism-button size="sm" data-reset data-focus-key="${escapeHtml(`${key}|reset`)}"${sending ? " disabled" : ""}>Reset</prism-button>` : "";
    // A batch list applies its changes together from its own button, so its rows draw no button of their own.
    const submit = batch || appliesOnPick(action) ? "" : `<div class="action-submit"><prism-button size="sm" variant="primary" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}"${ready ? "" : " disabled"}>${escapeHtml(submitLabel?.(action) ?? "Apply")}</prism-button>${reset}<p class="action-hint" id="${id}-hint" aria-live="polite">${run ? "" : escapeHtml(state.hint)}</p></div>`;
    control = `${contextHtml(action, renderMarkdown)}${guidanceHtml(action, choice)}${fields ? `<div class="action-fields">${fields}</div>` : ""}${slot}${submit}`;
  }
  return `<div class="action-row${action.available ? "" : " is-unavailable"}" data-action-key="${escapeHtml(key)}" aria-busy="${Boolean(sending)}">
    <div class="action-meta">${label}${head.detail ? `<span class="action-detail">${head.detail}</span>` : ""}<p class="action-effect" id="${id}-effect">${escapeHtml(action.effect)}</p></div>
    <div class="action-control">${control}<p class="action-error" role="alert"${error ? "" : " hidden"}>${escapeHtml(error ?? "")}</p></div>
  </div>`;
}

const panels = new Set();

// A kit control takes focus on its native control: the button inside a prism-button, the input of a prism-field, or the radio of a prism-choice-option.
const ENABLED = "prism-button:not([disabled]), prism-field:not([disabled]), prism-choice-option:not([disabled])";
const focusKeyOf = (element: any) => element?.closest?.("[data-focus-key]")?.dataset.focusKey ?? null;
const nativeOf = (element: any) => element?.control ?? (element?.localName === "prism-choice-option" ? element.querySelector("input.prism-choice-input") : null) ?? element;
const isEnabled = (element: any) => Boolean(element) && !element.hasAttribute("disabled");

// prism-field names no length limit, so each drawn text field passes its limit to its native control.
function limitFields(root: any) {
  for (const field of root.querySelectorAll("prism-field[data-max-length]")) if (field.control) field.control.maxLength = Number(field.dataset.maxLength);
}

/** The available actions of every action list shown in the open view, as jump palette entries labeled "<label>: <value>". */
export function shownActionEntries() {
  const entries = [];
  for (const panel of [...panels]) {
    if (!(panel as any).root.isConnected) {
      panels.delete(panel);
      continue;
    }
    if ((panel as any).palette) entries.push(...(panel as any).entries());
  }
  return entries;
}

// The last listing of each target, per API, so a list drawn again when its page refreshes starts from what it showed rather than from Loading, and the page does not jump while the listing is read again.
const lastListings = new WeakMap();

/**
 * Draws the actions of one or more targets into root, keeps them current, and applies them.
 * api is { list(target), apply(request), confirm({ title, message }), toast(message) }: list resolves to a listing, apply to { status, json },
 * and confirm to true only after the person confirms. drafts keeps unsent input per action across re-renders.
 * keepStaleDrafts keeps the person's input when the record changed under it, for input such as a comment that stays meaningful against the current record.
 * notice false leaves out the read-only notice, for a page that shows many lists and says it once for all of them.
 * sections, [{ heading, actions }], heads the rows of the action ids each lists with its heading, in the list's order.
 * unavailableButtons keeps the button of an unavailable action without fields, disabled, beside the reason it is unavailable.
 * actions, when given, keeps only the listed actions of those ids, such as one question's answer apart from its other actions.
 * form draws each action as a form, such as a question's answer: { heading, tone(option), wording(action, state), trailing(action), unavailable(action), guidance }, where wording gives
 * { field: { <name>: { label, placeholder } }, submit: { label, variant }, hint, ready } for the form's state. A form keeps the person's input when the record changed
 * under it, and sends once more against the current revision when the action is still available, since its input does not depend on the record's other values.
 * onApplied(action, input, result) replaces the toast of an applied change, and onRefused(action, result) may return the words to show for a refusal.
 * The list's loaded promise settles once its first listing is drawn, so a page built out of sight can wait for it before it shows.
 */
export function createActionList({ root, targets, api, drafts = {}, renderMarkdown = null, heading = null, submitLabel = null, emptyText = "Nothing can be changed here.", palette = false, compact = false, notice = true, onRender = null, keepStaleDrafts = false, groups = null, actions = null, batch = false, sections = null, unavailableButtons = false, form = null, onApplied = null, onRefused = null }: any) {
  if (!lastListings.has(api)) lastListings.set(api, new Map());
  const known = lastListings.get(api);
  const listings = new Map(targets.filter((target: any) => known.has(target)).map((target: any) => [target, known.get(target)]));
  const entries = new Map();
  let failure: any = null;
  let rendered = "";
  let waitingFocus: any = null;
  let wanted = [...targets];
  // The run choices of each run action, kept across redraws, and one reader of the hosts' run options for the whole list.
  const runChoices = new Map();
  // A report that arrives may name why its host cannot run, which the choice of host shows under that host, so the list draws again.
  const reader = typeof api.runOptions === "function" ? createRunOptionsReader((query: any) => api.runOptions(query), () => { if (root.isConnected) render(); }) : null;
  const reportReason = (host: string) => reader?.reason(host) ?? null;

  function entryOf(target: any, action: any) {
    const key = keyOf(target, action);
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { key, id: ++sequence, target, error: null, sending: false });
    entry.draft = hostFieldOf(action) ? runDraftOf(target, action) : drafts[key] ?? null;
    return entry;
  }

  const actionsOf = () => wanted.flatMap((target) => ((listings.get(target) as any)?.actions ?? []).filter((action: any) => (!groups || groups.includes(action.group)) && (!actions || actions.includes(action.id))).map((action: any) => ({ target, action })));
  const writable = () => wanted.length > 0 && wanted.every((target) => (listings.get(target) as any)?.writable === true);
  const itemOf = (target: any, action: any, items: any[] = actionsOf()) => items.find((item: any) => item.target === target && item.action.id === action.id) ?? { target, action };

  // A run action follows the choice of host that another action of its list offers, such as the initiative's Host, and otherwise draws its own.
  function layoutOf(target: any, action: any) {
    const items = actionsOf();
    const self = itemOf(target, action, items);
    const leads = items.some((other: any) => isRunAction(other.action) && hostLeader(other, items) === self);
    const host = hostFieldOf(action);
    const led = Boolean(host && hostLeader(self, items));
    return {
      choice: (field: any) => leads && field === action.fields[0],
      select: (field: any) => field === host && !led,
      reportReason,
      skip: (field: any) => isRunField(field) || (field === host && led)
    };
  }

  // The host a run action shows: the one its leader shows, the one the person chose in its own select, or its stored or first found host.
  function shownHost(target: any, action: any) {
    const items = actionsOf();
    const leader = hostLeader(itemOf(target, action, items), items);
    if (leader) {
      const field = leader.action.fields[0];
      return normalized(actionFormState(leader.action, drafts[keyOf(leader.target, leader.action)] ?? null).input[field.name]);
    }
    const host = hostFieldOf(action);
    const chosen = drafts[keyOf(target, action)]?.host;
    if (chosen) return chosen;
    return normalized(currentInput(action)[host.name]) ?? host.options.find((option: any) => !option.reason)?.value ?? host.options[0]?.value ?? null;
  }

  // A run action keeps the person's unsent choices per host, { hosts: { <host>: values }, host }, so switching hosts and back keeps them;
  // its draft is the shown host's choices, or none while that host has none and the host itself is unchanged.
  // A value that names no host, as a stored choice that cannot be read, is replaced by the shown host, so that host can be applied.
  function runDraftOf(target: any, action: any) {
    const kept = drafts[keyOf(target, action)];
    const host = shownHost(target, action);
    const own = kept?.hosts?.[host] ?? null;
    const noHost = !keyField(action) && normalized(currentInput(action)[hostFieldOf(action).name]) === null;
    if (!own && kept?.host === undefined && !noHost) return null;
    return { values: { [hostFieldOf(action).name]: host, ...(own ?? {}) } };
  }

  function runInput(target: any, action: any) {
    const host = shownHost(target, action);
    return { host, input: actionFormState(action, { values: { [hostFieldOf(action).name]: host, ...(drafts[keyOf(target, action)]?.hosts?.[host] ?? {}) } }).input };
  }

  // A run choice waits in the shown host's draft; a field chosen back to its current value is no change.
  function setRunValue(key: any, name: any, value: any) {
    const item = actionsOf().find((candidate: any) => keyOf(candidate.target, candidate.action) === key);
    if (!item) return;
    const { target, action } = item;
    const hostName = hostFieldOf(action).name;
    const host = shownHost(target, action);
    const kept = (drafts[key] ??= {});
    const hosts = (kept.hosts ??= {});
    const values: any = { ...(hosts[host] ?? {}), [name]: value };
    const current = actionFormState(action, { values: { [hostName]: host } }).input;
    for (const [field, chosen] of Object.entries(values)) if (same(normalized(chosen), normalized(current[field]))) delete values[field];
    if (Object.keys(values).length) hosts[host] = values;
    else delete hosts[host];
    if (!Object.keys(hosts).length && kept.host === undefined) delete drafts[key];
    const entry = entryOf(target, action);
    entry.error = null;
    const error = root.querySelector(`[data-action-key="${CSS.escape(key)}"] .action-error`);
    if (error) (error as any).hidden = true;
    syncRunChoices();
    onRender?.();
  }

  // Places each run action's pickers where its row draws them and brings them up to date; a row drawn without buttons of its own state
  // has them enabled here, so a choice never redraws the row and an open picker stays open.
  function syncRunChoices() {
    for (const { target, action } of actionsOf()) {
      if (!hostFieldOf(action)) continue;
      const key = keyOf(target, action);
      const slot = root.querySelector(`[data-run-slot="${CSS.escape(key)}"]`);
      let controller = runChoices.get(key);
      if (!slot && !controller?.section.isConnected) continue;
      if (!controller) {
        controller = createRunChoices({
          read: (query: any) => (reader ? reader.read(query) : Promise.resolve({ status: 0, json: { message: "This page cannot read the host's run options." } })),
          choose: (name: any, value: any) => setRunValue(key, name, value),
          // A report that arrives changes what holds the choices, which the list's owner reads on each render.
          changed: () => onRender?.()
        });
        runChoices.set(key, controller);
      }
      if (slot) slot.replaceWith(controller.section);
      const entry = entryOf(target, action);
      const { host, input } = runInput(target, action);
      const hostField = hostFieldOf(action);
      const hostLabel = hostField.options.find((option: any) => option.value === host)?.label ?? host ?? "";
      // A host value that fixes the run fields to the host defaults reads no host and offers no choice.
      const fixed = runFieldsFixed(action, input);
      // A choice of host that leads the run action shows under the shown host why it cannot run, so the pickers' note leaves that reason out.
      const items = actionsOf();
      const leader = hostLeader(itemOf(target, action, items), items);
      const shownReason = leader && host ? leader.action.fields[0].options?.find((option: any) => option.value === host)?.reason ?? reportReason(host) : null;
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
    if (!wanted.every((target) => listings.has(target))) return '<p class="muted action-loading">Loading…</p>';
    const items = actionsOf();
    if (!items.length) return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
    const options = { writable: writable(), renderMarkdown, heading, submitLabel, batch, unavailableButtons, layoutOf, form };
    const readOnly = writable() || !notice ? "" : readOnlyNotice();
    let section: any = null;
    const rows = items.map(({ target, action }) => {
      const own = sections?.find((candidate: any) => candidate.actions.includes(action.id)) ?? null;
      const head = own && own !== section ? `<h3 class="action-section">${escapeHtml(own.heading)}</h3>` : "";
      section = own;
      const named = Boolean(own) && own.actions.length === 1 && own.heading === action.label;
      return `${head}${actionHtml(action, entryOf(target, action), { ...options, named })}`;
    });
    return `${readOnly}<div class="action-list${compact ? " is-compact" : ""}${form ? " is-form" : ""}">${rows.join("")}</div>`;
  }

  // A re-render keeps the focused control and the cursor in a text field, so a refresh never takes the person's place.
  function render() {
    const next = html();
    if (next === rendered && root.childElementCount) {
      syncRunChoices();
      return;
    }
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const inRun = focused && [...runChoices.values()].some((controller) => controller.section.contains(focused)) ? focused : null;
    // A control that was disabled while its change was sent keeps its claim on focus until it is enabled again, unless focus moved elsewhere.
    const idle = !document.activeElement || document.activeElement === document.body;
    const focusKey = focusKeyOf(focused) ?? (idle ? waitingFocus : null);
    waitingFocus = null;
    const selection = focused && "selectionStart" in focused ? [focused.selectionStart, (focused as any).selectionEnd] : null;
    rendered = next;
    root.innerHTML = next;
    limitFields(root);
    syncRunChoices();
    if (inRun?.isConnected) (inRun as any).focus({ preventScroll: true });
    else if (focusKey) {
      const target = [...root.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey);
      const fallback = isEnabled(target) ? target : root.querySelector(`[data-action-key="${CSS.escape(focusKey.split("|").slice(0, 2).join("|"))}"] :is(${ENABLED})`);
      if (!isEnabled(target) && target) waitingFocus = focusKey;
      if (isEnabled(fallback)) {
        const control = nativeOf(fallback);
        control.focus({ preventScroll: true });
        if (selection && fallback === target && "setSelectionRange" in control) try { control.setSelectionRange(...selection); } catch {}
      }
    }
    onRender?.();
  }

  // A listing asked for again while one is on its way is read once more after it, never twice at once.
  const refresh = coalesce(async () => {
    const results = await Promise.all(wanted.map((target) => Promise.resolve(api.list(target)).then((listing) => ({ target, listing }), (error) => ({ target, error }))));
    failure = null;
    for (const { target, listing, error } of results as any[]) {
      if (error) failure = error.message;
      else {
        listings.set(target, listing);
        known.set(target, listing);
      }
    }
    if (root.isConnected) render();
  });

  function locate(element: any) {
    const row = element.closest("[data-action-key]");
    if (!row || !root.contains(row)) return null;
    const item = actionsOf().find(({ target, action }) => keyOf(target, action) === row.dataset.actionKey);
    return item ? { ...item, row, entry: entryOf(item.target, item.action) } : null;
  }

  function setDraft(entry: any, values: any) {
    if (values === null) delete drafts[entry.key];
    else drafts[entry.key] = { values };
    entry.draft = drafts[entry.key] ?? null;
  }

  // Replaces one action of a listing with the view the server sent, as after a stale read.
  function replaceAction(target: any, current: any) {
    const listing: any = listings.get(target);
    if (!listing || !current) return;
    listings.set(target, { ...listing, actions: listing.actions.map((action: any) => action.id === current.id ? current : action) });
  }

  // The modal dialog asks first; focus comes back to the control that asked, even when a refresh redrew it meanwhile.
  async function confirmed_(title: string, message: any, entry: any) {
    const focusKey = focusKeyOf(document.activeElement);
    const accepted = await api.confirm({ title, message });
    if (!root.contains(document.activeElement)) {
      const back = [...root.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey && isEnabled(element))
        ?? root.querySelector(`[data-action-key="${CSS.escape(entry.key)}"] :is(${ENABLED})`);
      nativeOf(back)?.focus();
    }
    return accepted;
  }

  async function send(item: any, values: any, confirmed = false, retried = false) {
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
      answer = await api.apply({ action: action.id, target: action.target ?? target, input: requestInput(action, state.input), revision: action.revision, ...(confirmed ? { confirmed: true } : {}) });
    } catch (error) {
      answer = { status: 0, json: { message: error.message } };
    }
    entry.sending = false;
    const result = answer.json ?? {};
    if (answer.status === 200) {
      setDraft(entry, null);
      listings.set(target, { ...(listings.get(target) as any), actions: result.actions ?? (listings.get(target) as any).actions });
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
    // A form's input stays the same answer against the record as it is now, so it goes once more against the current revision.
    if (form && !retried && result.code === "stale_revision" && result.current?.available) {
      replaceAction(target, result.current);
      return send({ ...item, action: result.current }, values, confirmed, true);
    }
    if (result.code === "stale_revision" || result.code === "action_unavailable") {
      // The page shows the action as it is now and drops the draft made against the old value, unless the draft stays meaningful against the new one.
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
      for (const name of wanted) if (listings.has(name)) listings.set(name, { ...(listings.get(name) as any), writable: false });
    } else {
      entry.error = onRefused?.(action, result) ?? result.message ?? "The change was not applied.";
    }
    render();
    return false;
  }

  // Typing in a form updates its words in place: the fields' labels, the submit button, and the line beside it, so the field keeps its focus.
  function updateForm(item: any, state: any) {
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
      const required = isRequired(item.action.fields.find((candidate: any) => candidate.name === field.dataset.field), state.input);
      field.toggleAttribute("required", required);
      if (own) {
        if (field.getAttribute("label") !== own.label) field.setAttribute("label", own.label);
        if (field.getAttribute("placeholder") !== (own.placeholder ?? "")) field.setAttribute("placeholder", own.placeholder ?? "");
      }
    }
    item.row.querySelector(".action-error").hidden = true;
  }

  root.addEventListener("click", (event: any) => {
    if (event.target.closest?.("[data-run-choices]")) return;
    const button = event.target.closest("prism-button");
    if (!button || button.disabled || !root.contains(button)) return;
    const item = locate(button);
    if (!item) return;
    const values = { ...(item.entry.draft?.values ?? {}) };
    if (button.hasAttribute("data-option")) {
      values[button.dataset.field] = button.dataset.value;
      item.entry.error = null;
      if (!batch && appliesOnPick(item.action)) {
        if (actionFormState(item.action, { values }).ready) void send(item, values);
        return;
      }
      setDraft(item.entry, values);
      render();
    } else if (button.hasAttribute("data-clear")) {
      // Clear choice unpicks a form's option, leaving the answer to its text fields.
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

  // Typing updates the draft and the controls it decides in place, so the field keeps its focus and an input method keeps its composition.
  root.addEventListener("input", (event: any) => {
    const field = event.target.closest("prism-field[data-field]:not([data-select])");
    const item = field && locate(field);
    if (!item) return;
    setDraft(item.entry, { ...(item.entry.draft?.values ?? {}), [field.dataset.field]: field.value });
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
      const required = isRequired(item.action.fields.find((candidate: any) => candidate.name === other.dataset.field), state.input);
      other.toggleAttribute("required", required);
      other.setAttribute("hint", required ? "Required" : "Optional");
    }
    if (!item.row.querySelector("[data-reset]")) {
      rendered = "";
      render();
    }
  });

  // A choice of host waits in the draft like a pick, and a run action's own choice of host shows that host's choices.
  root.addEventListener("change", (event: any) => {
    const field = event.target.closest?.(":is(prism-field, prism-choice)[data-select]");
    const item = field && root.contains(field) ? locate(field) : null;
    if (!item) return;
    item.entry.error = null;
    if (isRunAction(item.action)) {
      (drafts[item.entry.key] ??= {}).host = field.value;
      render();
      return;
    }
    const values = { ...(item.entry.draft?.values ?? {}), [field.dataset.field]: field.value };
    if (!batch && appliesOnPick(item.action)) {
      if (actionFormState(item.action, { values }).ready) void send(item, values);
      else render();
      return;
    }
    setDraft(item.entry, values);
    render();
  });

  // Enter in a one-line field applies a ready change, as a form would; the run choices' own fields take their own Enter.
  root.addEventListener("keydown", (event: any) => {
    if (event.key !== "Enter" || event.target.tagName !== "INPUT" || !event.target.closest("prism-field") || event.target.closest("[data-run-choices]") || event.isComposing) return;
    const item = locate(event.target);
    if (!item?.entry.draft) return;
    event.preventDefault();
    if (actionFormState(item.action, item.entry.draft).ready) void send(item, item.entry.draft.values);
  });

  // A batch list's changes: each available action whose unsent input differs from its value and is complete.
  const pending = () => actionsOf().map(({ target, action }) => ({ target, action, entry: entryOf(target, action) }))
    .filter(({ action, entry }) => action.available && entry.draft && actionFormState(action, entry.draft).ready);

  // An action of the shown targets by its id, also one of a group the list does not draw, such as a launch after the settings.
  const listedAction = (id: any) => {
    for (const target of wanted) {
      const action = ((listings.get(target) as any)?.actions ?? []).find((candidate: any) => candidate.id === id);
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
    action: (id: any) => listedAction(id)?.action ?? null,
    /** The input an action of the list shows, with the person's unsent changes, or null. */
    input(id: any) {
      const item = listedAction(id);
      return item ? actionFormState(item.action, drafts[keyOf(item.target, item.action)] ?? null).input : null;
    },
    /** Why a host's latest report says it cannot run, such as a sign-in it needs, as the choice of host shows it under that host, or null. */
    reportReason: (host: string) => reportReason(host),
    /** What holds the list's run choices: reading while a shown choice waits for its host, and each choice not offered as { label, reason }. */
    held() {
      const held: { reading: boolean; reasons: any[] } = { reading: false, reasons: [] };
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
    async follow(id: any) {
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
        if (result.actions) listings.set(target, { ...(listings.get(target) as any), actions: result.actions });
        if (result.applied) api.toast(`${action.label}: done. ${action.effect}`);
        render();
        return { ok: true, message: null };
      }
      if (result.code === "write_forbidden") for (const name of wanted) if (listings.has(name)) listings.set(name, { ...(listings.get(name) as any), writable: false });
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
    focusAction(id: string, target = wanted[0]) {
      const row = root.querySelector(`[data-action-key="${CSS.escape(`${target}|${id}`)}"]`);
      if (!row) return false;
      row.scrollIntoView({ block: "nearest" });
      const control = row.querySelector('prism-button[data-option][pressed="true"]:not([disabled])') ?? row.querySelector(ENABLED) ?? row;
      if (control === row) row.tabIndex = -1;
      nativeOf(control).focus();
      return true;
    },
    setTargets(next: any) {
      wanted = [...next];
      return refresh();
    },
    // Moves the list from one target to another that names the same record, as a file that moved to another scope, keeping each action's unsent input,
    // its drawn controls, and the focused control with its cursor in place while the new target's listing loads.
    retarget(from: any, to: any) {
      if (from === to || !wanted.includes(from)) return refresh();
      const prefix = `${from}|`;
      const moved = (key: any) => key?.startsWith(prefix) ? `${to}|${key.slice(prefix.length)}` : key;
      for (const key of Object.keys(drafts)) if (key.startsWith(prefix)) { drafts[moved(key)] = drafts[key]; delete drafts[key]; }
      for (const [key, entry] of [...entries]) if (key.startsWith(prefix)) { entries.delete(key); entries.set(moved(key), Object.assign(entry, { key: moved(key), target: to })); }
      const listing: any = listings.get(from);
      listings.delete(from);
      if (listing) listings.set(to, { ...listing, actions: (listing.actions ?? []).map((action: any) => action.target === from ? { ...action, target: to } : action) });
      wanted = wanted.map((target) => target === from ? to : target);
      for (const element of root.querySelectorAll("[data-action-key], [data-focus-key]")) {
        if (element.dataset.actionKey) element.dataset.actionKey = moved(element.dataset.actionKey);
        if (element.dataset.focusKey) element.dataset.focusKey = moved(element.dataset.focusKey);
      }
      waitingFocus = moved(waitingFocus);
      // The drawn controls now carry the new keys, so the next render replaces them only when the new listing differs.
      rendered = html();
      return refresh();
    },
    refresh,
    render
  };
  panels.add(panel);
  // Another tab's change, or the page's periodic check, refreshes the listing; a list whose element left the page stops listening.
  // A periodic check that comes while the last one still reads is skipped, so slow listings never pile up requests.
  let checking: any = null;
  const onChange = (event: any) => {
    if (!root.isConnected) {
      document.removeEventListener("prism:action", onChange);
      document.removeEventListener("prism:poll", onChange);
      panels.delete(panel);
      return;
    }
    if (event?.type !== "prism:poll") { void refresh(); return; }
    if (checking) return;
    checking = refresh().catch(() => {}).finally(() => { checking = null; });
  };
  document.addEventListener("prism:action", onChange);
  document.addEventListener("prism:poll", onChange);
  render();
  (panel as any).loaded = refresh().catch(() => {});
  return panel;
}

/** The Initiative settings card of an initiative or slice page, drawn into slot from the target's listing. */
export function mountInitiativeSettings(slot: any, { target, eyebrow, ctx }: { target: any; eyebrow: any; ctx: any }) {
  if (!slot || !ctx.actionApi) return null;
  slot.innerHTML = `<prism-panel class="view-section settings-panel" heading="Initiative settings" eyebrow="${escapeHtml(eyebrow)}"><div data-action-list></div></prism-panel>`;
  return createActionList({ root: slot.querySelector("[data-action-list]"), targets: [target], api: ctx.actionApi, drafts: (ctx.state.actionDrafts ??= {}), renderMarkdown: ctx.renderMarkdown ?? null, palette: true, emptyText: "This initiative has no settings to change." });
}
