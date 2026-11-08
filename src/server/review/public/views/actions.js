import { escapeHtml } from "./util.js";

// The page draws every action from its listing: the registry names the fields, and this view only places the existing controls.
export const READ_ONLY_NOTICE = "This tab can only read. To make changes, run prism review in this project, or ask the agent to present the review.";
export const STALE_MESSAGE = "Someone changed this since you opened it; it now shows the current value.";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// Text counts as a value only when it holds more than whitespace, as the server reads it.
const normalized = (value) => typeof value === "string" ? (value.trim() ? value.trim() : null) : value ?? null;
const filled = (value) => normalized(value) !== null;

/** Each field's current value: a one-field action holds its value, and an object value fills the fields it names. */
export function currentInput(action) {
  const fields = action.fields ?? [];
  const input = Object.fromEntries(fields.map((field) => [field.name, null]));
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
    const dependent = fields.find((other) => other.requiredWhen?.field === field.name && Object.hasOwn(value, other.name));
    const implied = dependent?.requiredWhen.values.find((item) => item !== null);
    if (implied !== undefined) input[field.name] = implied;
  }
  return input;
}

function isRequired(field, input) {
  if (field.required) return true;
  const when = field.requiredWhen;
  return Boolean(when) && when.values.includes(normalized(input[when.field]));
}

/** The state of one action's control from the person's draft: { input, ready, confirm, hint }. */
export function actionFormState(action, draft = {}) {
  const values = draft?.values ?? {};
  const fields = action.fields ?? [];
  const current = currentInput(action);
  const input = Object.fromEntries(fields.map((field) => [field.name, Object.hasOwn(values, field.name) ? values[field.name] : current[field.name]]));
  const missing = fields.find((field) => isRequired(field, input) && !filled(input[field.name]));
  // An action without a value, such as an answer or a rebuild, is never unchanged; a setting is unchanged while every field holds its current value.
  const unchanged = action.value !== null && action.value !== undefined && fields.every((field) => normalized(input[field.name]) === normalized(current[field.name]));
  const confirm = action.confirm && action.confirm.values.includes(normalized(input[action.confirm.field])) ? action.confirm.message : null;
  const hint = !action.available ? action.reason ?? "" : missing ? `Fill in ${missing.label}.` : "";
  return { input, ready: Boolean(action.available) && !unchanged && !missing, confirm, hint };
}

/** The request input of a form state: every field, with text trimmed and empty values as null. */
export function requestInput(action, input) {
  return Object.fromEntries((action.fields ?? []).map((field) => [field.name, normalized(input[field.name])]));
}

function optionLabel(field, value) {
  return field?.options?.find((option) => option.value === value)?.label ?? value;
}

/** A short reading of a value for a label, such as "On" or "Custom". */
export function valueText(action, input = currentInput(action)) {
  const fields = action.fields ?? [];
  if (action.value === null || action.value === undefined) return "";
  const choice = fields.find((field) => field.kind !== "text");
  if (choice && input[choice.name] !== null) return String(optionLabel(choice, input[choice.name]));
  return isRecord(action.value) ? Object.values(action.value).filter((item) => item !== null).join(", ") : String(action.value);
}

const keyOf = (target, action) => `${target}|${action.id}`;
let sequence = 0;

// One action's fields, or its reason in place of them when it is unavailable.
// Each option's consequence shows as its tooltip and, for the picked option, under the group; an action with context lists them all with the recommendation.
function guidanceHtml(action, choice) {
  const recommended = action.recommended;
  const options = choice?.options ?? [];
  const consequences = action.context ? options.filter((option) => option.consequence) : [];
  const list = consequences.length
    ? `<ul class="gate-consequences">${consequences.map((option) => `<li><span class="gate-option-label">${escapeHtml(option.label)}</span><span class="gate-consequence">${escapeHtml(option.consequence)}</span></li>`).join("")}</ul>`
    : "";
  const pick = recommended?.value !== null && recommended?.value !== undefined ? options.find((option) => option.value === recommended.value) : null;
  const reason = recommended?.reason ? `<p class="gate-recommendation"><span class="gate-tag">Recommended</span> ${pick ? `<span class="gate-option-label">${escapeHtml(pick.label)}</span>: ` : ""}${escapeHtml(recommended.reason)}</p>` : "";
  return list || reason ? `<div class="gate-guidance">${list}${reason}</div>` : "";
}

function contextHtml(action, renderMarkdown) {
  if (!action.context) return "";
  return `<div class="gate-context">${renderMarkdown ? renderMarkdown(action.context) : `<p class="gate-context-plain">${escapeHtml(action.context)}</p>`}</div>`;
}

// A group of several conditional text fields, such as custom model names, shows only while its condition holds or one of them holds a value.
function shownFields(action, input) {
  const fields = action.fields ?? [];
  const texts = fields.filter((field) => field.kind === "text");
  if (texts.length < 2) return fields;
  const active = texts.some((field) => isRequired(field, input) || filled(input[field.name]));
  return active ? fields : fields.filter((field) => field.kind !== "text");
}

// A one-choice setting applies when an option is picked; an action with text or several fields applies with its own button.
const appliesOnPick = (action) => !action.context && action.fields.length === 1 && action.fields[0].kind !== "text";

function fieldHtml(action, field, input, { id, disabled, key }) {
  if (field.kind === "text") {
    const required = isRequired(field, input);
    const value = escapeHtml(input[field.name] ?? "");
    const attributes = `id="${id}-${escapeHtml(field.name)}" data-field="${escapeHtml(field.name)}" data-focus-key="${escapeHtml(`${key}|${field.name}`)}"${field.maxLength ? ` maxlength="${field.maxLength}"` : ""} aria-required="${required}"${disabled ? " disabled" : ""}`;
    return `<label class="gate-note action-field"><span class="gate-note-label">${escapeHtml(field.label)} <span class="gate-note-need${required ? " is-required" : ""}">${required ? "required" : "optional"}</span></span>${field.multiline
      ? `<textarea ${attributes} rows="2">${value}</textarea>`
      : `<input type="text" ${attributes} value="${value}"${value ? ` title="${value}"` : ""} autocomplete="off" spellcheck="false">`}</label>`;
  }
  const picked = normalized(input[field.name]);
  const chosen = field.options.find((option) => option.value === picked);
  const group = `<div class="segmented action-options" role="group" aria-label="${escapeHtml(field.label)}">${field.options.map((option) =>
    `<button type="button" data-option data-field="${escapeHtml(field.name)}" data-value="${escapeHtml(option.value)}" data-focus-key="${escapeHtml(`${key}|${field.name}|${option.value}`)}" aria-pressed="${option.value === picked}"${option.consequence ? ` title="${escapeHtml(option.consequence)}"` : ""}${disabled ? " disabled" : ""}>${escapeHtml(option.label ?? option.value)}</button>`).join("")}</div>`;
  const consequence = !action.context && chosen?.consequence ? `<p class="gate-consequence action-consequence">${escapeHtml(chosen.consequence)}</p>` : "";
  return `<div class="action-choice">${group}${consequence}</div>`;
}

function actionHtml(action, entry, { writable, renderMarkdown, heading, submitLabel }) {
  const { key, draft, error, sending } = entry;
  const state = actionFormState(action, draft);
  const id = `action-${entry.id}`;
  const disabled = !writable || sending;
  const head = heading ? heading(action) : { label: escapeHtml(action.label), detail: "" };
  const choice = action.fields.find((field) => field.kind !== "text");
  let control;
  if (!action.available) {
    control = `<p class="action-reason">${escapeHtml(action.reason ?? "")}</p>`;
  } else if (!action.fields.length) {
    control = `<div class="gate-actions"><button type="button" class="tool-button" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}" aria-describedby="${id}-label ${id}-effect"${disabled ? " disabled" : ""}>${escapeHtml(submitLabel?.(action) ?? action.label)}</button></div>`;
  } else {
    const fields = shownFields(action, state.input).map((field) => fieldHtml(action, field, state.input, { id, disabled, key })).join("");
    const submit = appliesOnPick(action) ? "" : `<div class="gate-actions"><button type="button" class="tool-button primary" data-apply data-focus-key="${escapeHtml(`${key}|apply`)}" aria-describedby="${id}-hint"${disabled || !state.ready ? " disabled" : ""}>${escapeHtml(submitLabel?.(action) ?? "Apply")}</button>${draft ? `<button type="button" class="tool-button" data-reset data-focus-key="${escapeHtml(`${key}|reset`)}"${sending ? " disabled" : ""}>Reset</button>` : ""}<p class="gate-hint" id="${id}-hint" aria-live="polite">${escapeHtml(state.hint)}</p></div>`;
    control = `${contextHtml(action, renderMarkdown)}${guidanceHtml(action, choice)}<div class="action-fields">${fields}</div>${submit}`;
  }
  return `<div class="action-row${action.available ? "" : " is-unavailable"}" data-action-key="${escapeHtml(key)}" aria-busy="${Boolean(sending)}">
    <div class="action-meta"><span class="action-label" id="${id}-label">${head.label}</span>${head.detail ? `<span class="action-detail">${head.detail}</span>` : ""}<p class="action-effect" id="${id}-effect">${escapeHtml(action.effect)}</p></div>
    <div class="action-control">${control}<p class="gate-error" role="alert"${error ? "" : " hidden"}>${escapeHtml(error ?? "")}</p></div>
  </div>`;
}

const panels = new Set();

/** The available actions of every action list shown in the open view, as jump palette entries labeled "<label>: <value>". */
export function shownActionEntries() {
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

/**
 * Draws the actions of one or more targets into root, keeps them current, and applies them.
 * api is { list(target), apply(request), confirm({ title, message }), toast(message) }: list resolves to a listing, apply to { status, json },
 * and confirm to true only after the person confirms. drafts keeps unsent input per action across re-renders.
 */
export function createActionList({ root, targets, api, drafts = {}, renderMarkdown = null, heading = null, submitLabel = null, emptyText = "Nothing can be changed here.", palette = false, compact = false, onRender = null }) {
  const listings = new Map();
  const entries = new Map();
  let failure = null;
  let rendered = "";
  let wanted = [...targets];

  function entryOf(target, action) {
    const key = keyOf(target, action);
    let entry = entries.get(key);
    if (!entry) entries.set(key, entry = { key, id: ++sequence, target, error: null, sending: false });
    entry.draft = drafts[key] ?? null;
    return entry;
  }

  const actionsOf = () => wanted.flatMap((target) => (listings.get(target)?.actions ?? []).map((action) => ({ target, action })));
  const writable = () => wanted.length > 0 && wanted.every((target) => listings.get(target)?.writable === true);

  function html() {
    if (failure && !listings.size) return `<p class="gate-error" role="alert">${escapeHtml(failure)}</p>`;
    if (!wanted.every((target) => listings.has(target))) return '<p class="muted action-loading">Loading…</p>';
    const items = actionsOf();
    if (!items.length) return `<p class="empty-note">${escapeHtml(emptyText)}</p>`;
    const options = { writable: writable(), renderMarkdown, heading, submitLabel };
    const notice = writable() ? "" : `<p class="notice action-notice" role="note">${escapeHtml(READ_ONLY_NOTICE).replace("prism review", "<code>prism review</code>")}</p>`;
    return `${notice}<div class="action-list${compact ? " is-compact" : ""}">${items.map(({ target, action }) => actionHtml(action, entryOf(target, action), options)).join("")}</div>`;
  }

  // A re-render keeps the focused control and the cursor in a text field, so a refresh never takes the person's place.
  function render() {
    const next = html();
    if (next === rendered && root.childElementCount) return;
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset?.focusKey ?? null;
    const selection = focused && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null;
    rendered = next;
    root.innerHTML = next;
    if (focusKey) {
      const target = [...root.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey);
      const fallback = target ?? root.querySelector(`[data-action-key="${CSS.escape(focusKey.split("|").slice(0, 2).join("|"))}"] button:not(:disabled), [data-action-key="${CSS.escape(focusKey.split("|").slice(0, 2).join("|"))}"] input:not(:disabled)`);
      if (fallback && !fallback.disabled) {
        fallback.focus({ preventScroll: true });
        if (selection && target && "setSelectionRange" in target) try { target.setSelectionRange(...selection); } catch {}
      }
    }
    onRender?.();
  }

  async function refresh() {
    const results = await Promise.all(wanted.map((target) => Promise.resolve(api.list(target)).then((listing) => ({ target, listing }), (error) => ({ target, error }))));
    failure = null;
    for (const { target, listing, error } of results) {
      if (error) failure = error.message;
      else listings.set(target, listing);
    }
    if (root.isConnected) render();
  }

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

  // Replaces one action of a listing with the view the server sent, as after a stale read.
  function replaceAction(target, current) {
    const listing = listings.get(target);
    if (!listing || !current) return;
    listings.set(target, { ...listing, actions: listing.actions.map((action) => action.id === current.id ? current : action) });
  }

  // The modal dialog asks first; focus comes back to the control that asked, even when a refresh redrew it meanwhile.
  async function confirmed_(title, message, entry) {
    const focusKey = document.activeElement?.dataset?.focusKey ?? null;
    const accepted = await api.confirm({ title, message });
    if (!root.contains(document.activeElement)) {
      const back = [...root.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey)
        ?? root.querySelector(`[data-action-key="${CSS.escape(entry.key)}"] button:not(:disabled)`);
      back?.focus();
    }
    return accepted;
  }

  async function send(item, values, confirmed = false) {
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
      listings.set(target, { ...listings.get(target), actions: result.actions ?? listings.get(target).actions });
      if (result.applied) api.toast(`${action.label}: ${valueText(action, state.input) || "done"}. ${action.effect}`);
      render();
      return true;
    }
    if (result.code === "confirmation_required" && !confirmed) {
      render();
      if (await confirmed_(title, result.message, entry)) return send(locate(root.querySelector(`[data-action-key="${CSS.escape(entry.key)}"]`)) ?? item, values, true);
      return false;
    }
    if (result.code === "stale_revision" || result.code === "action_unavailable") {
      // The page shows the action as it is now and drops the draft made against the old value.
      setDraft(entry, null);
      replaceAction(target, result.current);
      api.toast(STALE_MESSAGE);
      render();
      void refresh();
      return false;
    }
    if (result.code === "write_forbidden") {
      for (const name of wanted) if (listings.has(name)) listings.set(name, { ...listings.get(name), writable: false });
    } else {
      entry.error = result.message ?? "The change was not applied.";
    }
    render();
    return false;
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !root.contains(button)) return;
    const item = locate(button);
    if (!item) return;
    const values = { ...(item.entry.draft?.values ?? {}) };
    if (button.hasAttribute("data-option")) {
      values[button.dataset.field] = button.dataset.value;
      item.entry.error = null;
      if (appliesOnPick(item.action)) {
        if (actionFormState(item.action, { values }).ready) void send(item, values);
        return;
      }
      setDraft(item.entry, values);
      render();
    } else if (button.hasAttribute("data-reset")) {
      item.entry.error = null;
      setDraft(item.entry, null);
      render();
      root.querySelector(`[data-action-key="${CSS.escape(item.entry.key)}"] button:not(:disabled)`)?.focus();
    } else if (button.hasAttribute("data-apply")) {
      if (actionFormState(item.action, item.entry.draft ?? { values }).ready) void send(item, values);
    }
  });

  // Typing updates the draft and the controls it decides in place, so the field keeps its focus and an input method keeps its composition.
  root.addEventListener("input", (event) => {
    const field = event.target.closest("[data-field]");
    const item = field && locate(field);
    if (!item || field.tagName === "BUTTON") return;
    setDraft(item.entry, { ...(item.entry.draft?.values ?? {}), [field.dataset.field]: field.value });
    item.entry.error = null;
    const state = actionFormState(item.action, item.entry.draft);
    const apply = item.row.querySelector("[data-apply]");
    if (apply) apply.disabled = !state.ready || item.entry.sending;
    const hint = item.row.querySelector(".gate-hint");
    if (hint && hint.textContent !== state.hint) hint.textContent = state.hint;
    item.row.querySelector(".gate-error").hidden = true;
    for (const other of item.row.querySelectorAll("[data-field]:not(button)")) {
      const required = isRequired(item.action.fields.find((candidate) => candidate.name === other.dataset.field), state.input);
      other.setAttribute("aria-required", String(required));
      const need = other.closest("label")?.querySelector(".gate-note-need");
      if (need) {
        need.textContent = required ? "required" : "optional";
        need.classList.toggle("is-required", required);
      }
    }
    if (!item.row.querySelector("[data-reset]")) {
      rendered = "";
      render();
    }
  });

  // Enter in a one-line field applies a ready change, as a form would.
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.tagName !== "INPUT" || event.isComposing) return;
    const item = locate(event.target);
    if (!item?.entry.draft) return;
    event.preventDefault();
    if (actionFormState(item.action, item.entry.draft).ready) void send(item, item.entry.draft.values);
  });

  const panel = {
    root,
    palette,
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
      const control = row.querySelector('[aria-pressed="true"]:not(:disabled)') ?? row.querySelector("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)") ?? row;
      if (control === row) row.tabIndex = -1;
      control.focus();
      return true;
    },
    setTargets(next) {
      wanted = [...next];
      return refresh();
    },
    refresh,
    render
  };
  panels.add(panel);
  // Another tab's change, or the page's periodic check, refreshes the listing; a list whose element left the page stops listening.
  const onChange = () => {
    if (!root.isConnected) {
      document.removeEventListener("prism:action", onChange);
      document.removeEventListener("prism:poll", onChange);
      panels.delete(panel);
      return;
    }
    void refresh();
  };
  document.addEventListener("prism:action", onChange);
  document.addEventListener("prism:poll", onChange);
  render();
  void refresh();
  return panel;
}

/** The Initiative settings card of an initiative or slice page, drawn into slot from the target's listing. */
export function mountInitiativeSettings(slot, { target, eyebrow, ctx }) {
  if (!slot || !ctx.actionApi) return null;
  slot.innerHTML = `<section class="view-card action-card"><header class="view-card-header"><p class="eyebrow">${escapeHtml(eyebrow)}</p><div class="view-card-title"><h2>Initiative settings</h2></div></header><div class="view-card-body" data-action-list></div></section>`;
  return createActionList({ root: slot.querySelector("[data-action-list]"), targets: [target], api: ctx.actionApi, drafts: (ctx.state.actionDrafts ??= {}), renderMarkdown: ctx.renderMarkdown ?? null, palette: true, emptyText: "This initiative has no settings to change." });
}
