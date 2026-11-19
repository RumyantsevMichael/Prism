import { escapeHtml } from "./util.js";

// The run choices of an action, such as an initiative's models: one kit prism-picker per run-option or run-choice field, fed by
// api/run-options for the shown host. A run-choice picker lists the host's models between Host default and Other model…, and
// below them the effort levels of the chosen model; a run-option picker, such as the provider, shows only while the host reports it.
// The section and its pickers stay the same elements while the action list redraws, so an open popover stays open.

export const HOST_HINT = "The hosts Prism supports, as found on this computer. Each host reports its own models, providers and effort levels.";

// No model, provider, or effort name holds "…", so these values never collide with a reported one.
const OTHER = "…other";
const EARLIER = "…earlier";
const RUN_FIELDS = new Set(["run-option", "run-choice"]);
const HOST_DEFAULT = Object.freeze({ value: null, name: "Host default", description: "" });

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const isRunField = (field) => RUN_FIELDS.has(field?.kind);
export const isRunAction = (action) => (action?.fields ?? []).some(isRunField);

/** A run action's choice of host: a choice field named host. */
export const hostFieldOf = (action) => (isRunAction(action) ? (action.fields ?? []).find((field) => field.name === "host" && field.kind === "choice" && Array.isArray(field.options)) ?? null : null);

const optionValues = (field) => field.options.map((option) => option.value).join("\n");
const oneChoice = (action) => action?.fields?.length === 1 && action.fields[0].kind === "choice" && Array.isArray(action.fields[0].options) ? action.fields[0] : null;

/** The item of the same target whose one choice offers exactly the hosts of a run action's host field; the run action follows it. */
export function hostLeader(item, items) {
  const host = hostFieldOf(item.action);
  if (!host) return null;
  return items.find((other) => other !== item && other.target === item.target && !isRunAction(other.action) && oneChoice(other.action) && optionValues(oneChoice(other.action)) === optionValues(host)) ?? null;
}

/**
 * Whether the run fields of an action are fixed to the host defaults for the input's host, as a field's fixedWhen names, such as
 * Any available host, which offers no choice of its own: its pickers show the host defaults, read no host, and take no choice.
 */
export function runFieldsFixed(action, input) {
  return (action?.fields ?? []).some((field) => isRunField(field) && field.fixedWhen && field.fixedWhen.values.includes(input?.[field.fixedWhen.field] ?? null));
}

/** A run choice as the page holds it: { model, effort, typed }, and earlier for an earlier name that Prism kept. */
export function choiceOf(value) {
  if (!isRecord(value)) return { model: null, effort: null, typed: false };
  if (typeof value.earlier === "string") return { model: null, effort: null, typed: false, earlier: value.earlier };
  return { model: value.model ?? null, effort: value.effort ?? null, typed: value.typed === true };
}

// The model rule of the run choices, which the review server applies to every choice again; the page checks a typed name with it
// as the person presses Enter, so a name the rule refuses is never sent.
const MODEL_RULE = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]+-]{0,199}$/;
const MODEL_RULE_MESSAGE = "A model name has 1 to 200 letters, digits, and . _ - : / @ [ ] +, and starts with a letter or digit.";
const typedNote = (hostLabel) => `Prism cannot check a model you typed; ${hostLabel} receives it as written.`;
const earlierReason = (hostLabel, earlier) => `Prism kept the earlier model name ${earlier}, which ${hostLabel} cannot take as a model.`;
const capitalized = (level) => `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

/**
 * Reads api/run-options through fetchOptions(query), which resolves to { status, json }: one read per distinct query, kept until
 * forget(), and at most two at once, since a browser opens only a few connections to the review app. A read that never answered is read again.
 */
export function createRunOptionsReader(fetchOptions) {
  const kept = new Map();
  const queue = [];
  let running = 0;
  const next = () => {
    while (running < 2 && queue.length) {
      const job = queue.shift();
      running += 1;
      void job().finally(() => {
        running -= 1;
        next();
      });
    }
  };
  return {
    read(query) {
      const key = JSON.stringify(query);
      if (!kept.has(key)) {
        const answer = new Promise((resolve) => {
          queue.push(() => Promise.resolve().then(() => fetchOptions(query)).then(resolve, (error) => resolve({ status: 0, json: { message: error?.message ?? "" } })));
          next();
        });
        kept.set(key, answer);
        void answer.then((result) => { if (result.status === 0 && kept.get(key) === answer) kept.delete(key); });
      }
      return kept.get(key);
    },
    forget() {
      kept.clear();
    }
  };
}

// A report from an answer: the server's report, or a failed one with the refusal's message.
function reportOf(answer, hostLabel) {
  if (answer.status === 200 && isRecord(answer.json) && Array.isArray(answer.json.options)) return answer.json;
  const message = answer.json?.message || `${hostLabel} did not report its run options.`;
  return { state: "failed", reason: message, options: [] };
}

const optionIn = (report, id) => report?.options?.find((option) => option.id === id) ?? null;

function make(tag, className, attributes = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function setAttr(element, name, value) {
  if (value === null || value === undefined || value === false) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== String(value === true ? "" : value)) element.setAttribute(name, value === true ? "" : value);
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/**
 * The run choices of one action: section is the element to place, and update({ fields, input, host, hostLabel, writable, disabled })
 * draws the pickers for the shown host's input. choose(name, value) is called with a field's new value, a provider string or null, or a run choice.
 * read(query) resolves to { status, json } of api/run-options.
 */
export function createRunChoices({ read, choose }) {
  const section = make("div", "prism-run-choices", { "data-run-choices": "" });
  const note = make("p", "prism-run-choices-note", { role: "status" });
  note.hidden = true;
  section.append(note);
  const pickers = new Map();
  const effortNames = new Map();
  let view = null;

  const effortName = (level) => effortNames.get(level) ?? capitalized(level);

  function create(field) {
    const element = make("prism-picker", "prism-run-choice", {
      label: field.label,
      heading: field.heading ?? (field.kind === "run-choice" ? `${field.label} model` : field.label),
      "filter-label": field.kind === "run-choice" ? "Filter models" : `Filter ${field.label.toLowerCase()}s`,
      "data-run-field": field.name
    });
    const state = { field, element, key: null, ticket: 0, report: null, reportKey: null, reportHost: null, items: [], itemsKey: null, choice: null };
    if (field.kind === "run-choice") {
      const extra = make("div", "prism-run-choice-extra", { slot: "extra" });
      state.none = make("p", "prism-run-choice-none");
      state.name = make("prism-field", "prism-run-choice-name", { type: "text", label: "Model name", hint: "Press Enter to use this name as written." });
      state.effortHead = make("p", "prism-run-choice-effort-head");
      state.efforts = make("div", "prism-run-choice-efforts", { role: "group", "aria-label": "Effort" });
      const levels = make("p", "prism-run-choice-levels");
      levels.textContent = "Levels come from the chosen model and change with it.";
      state.none.hidden = true;
      state.name.hidden = true;
      extra.append(state.none, state.name, state.effortHead, state.efforts, levels);
      element.append(extra);
      state.efforts.addEventListener("click", (event) => {
        const button = event.target.closest?.("prism-button[data-effort]");
        if (!button || button.hasAttribute("disabled") || !state.choice) return;
        const { model, typed } = state.choice.earlier === undefined ? state.choice : { model: null, typed: false };
        choose(field.name, { model, effort: button.dataset.effort || null, typed });
      });
      state.name.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        takeTyped(state);
      });
      state.name.addEventListener("input", () => setAttr(state.name, "invalid", false));
    }
    element.addEventListener("change", (event) => {
      if (event.target !== element) return;
      event.stopPropagation();
      const value = event.detail?.value ?? "";
      if (field.kind === "run-option") {
        choose(field.name, value || null);
        return;
      }
      if (value === OTHER) {
        element.value = pickerValue(state.choice);
        state.name.hidden = false;
        state.name.control?.focus();
        return;
      }
      const { effort } = state.choice?.earlier === undefined ? state.choice ?? {} : {};
      choose(field.name, { model: value || null, effort: effort ?? null, typed: false });
    });
    pickers.set(field.name, state);
    return state;
  }

  // A typed name is taken only when it keeps the model rule; otherwise the field names the rule.
  function takeTyped(state) {
    const name = (state.name.value ?? "").trim();
    if (!view?.host) return;
    if (!MODEL_RULE.test(name)) {
      state.name.setAttribute("error", MODEL_RULE_MESSAGE);
      setAttr(state.name, "invalid", true);
      return;
    }
    setAttr(state.name, "invalid", false);
    state.name.value = "";
    // The field leaves the popover, so focus moves to its filter first and Escape still closes only the popover.
    if (state.name.contains(document.activeElement)) focusFilter(state);
    state.name.hidden = true;
    const effort = state.choice?.earlier === undefined ? state.choice?.effort ?? null : null;
    choose(state.field.name, { model: name, effort, typed: true });
  }

  // The picker's own filter field, which stays in its popover while the popover is open.
  const focusFilter = (state) => state.element.field?.control?.focus({ preventScroll: true });

  const pickerValue = (choice) => (choice?.earlier !== undefined ? EARLIER : choice?.model ?? "");

  // What a field asks of api/run-options; an earlier name is never sent, so the kind is read as the host default.
  function queryOf(field, input, host) {
    const provider = typeof input.provider === "string" ? input.provider : null;
    const query = { host, for: field.for };
    if (provider !== null) query.provider = provider;
    if (field.kind === "run-choice") {
      const choice = choiceOf(input[field.name]);
      if (choice.earlier === undefined) {
        if (choice.model !== null) query.model = choice.model;
        if (choice.effort !== null) query.effort = choice.effort;
        if (choice.typed && choice.model !== null) query.typed = "1";
      }
    }
    return query;
  }

  // A field is drawn across the width unless another run-choice field chooses for the same purpose, as the agents do.
  const wide = (field, fields) => field.kind === "run-option" || fields.filter((other) => other.kind === "run-choice" && other.for === field.for).length < 2;

  function drawOptions(state, html) {
    if (state.itemsKey === html) return;
    state.itemsKey = html;
    for (const item of state.items) item.remove();
    const template = document.createElement("template");
    template.innerHTML = html;
    state.items = [...template.content.children];
    state.element.append(...state.items);
  }

  function drawEfforts(state, values, chosen) {
    const html = values.map((entry) => `<prism-button size="sm" pressed="false" data-effort="${escapeHtml(entry.value ?? "")}"${entry.description ? ` tip="${escapeHtml(entry.description)}"` : ""}>${escapeHtml(entry.name)}</prism-button>`).join("");
    if (state.effortsKey !== html) {
      const focused = state.efforts.contains(document.activeElement) ? document.activeElement.dataset?.effort : undefined;
      state.effortsKey = html;
      state.efforts.innerHTML = html;
      // A level that the new model still takes keeps focus, and otherwise focus stays in the popover on its first level.
      if (focused !== undefined) (state.efforts.querySelector(`prism-button[data-effort="${CSS.escape(focused)}"]`) ?? state.efforts.querySelector("prism-button[data-effort]"))?.focus();
    }
    for (const button of state.efforts.querySelectorAll("prism-button[data-effort]")) setAttr(button, "pressed", String((button.dataset.effort || null) === chosen));
  }

  function draw(state, { input, host, hostLabel, writable, disabled }) {
    const { field, element } = state;
    const report = state.reportHost === host ? state.report : null;
    const fresh = Boolean(report) && state.reportKey === state.key;
    const busy = writable && Boolean(host) && !report;
    const unavailable = report?.state === "unavailable";
    setAttr(element, "busy", busy);
    setAttr(element, "disabled", !busy && (disabled || !writable || !host || unavailable));
    if (field.kind === "run-option") {
      const option = optionIn(report, field.option);
      const value = typeof input[field.name] === "string" ? input[field.name] : null;
      const values = option?.values ?? [HOST_DEFAULT];
      drawOptions(state, values.map((entry) => `<prism-list-item value="${escapeHtml(entry.value ?? "")}">${escapeHtml(entry.name)}</prism-list-item>`).join(""));
      setAttr(element, "value", value ?? "");
      const listed = values.find((entry) => entry.value === value);
      setAttr(element, "display", value === null ? "Host default" : listed?.name ?? value);
      setAttr(element, "detail", value === null ? values[0]?.description || null : null);
      setAttr(element, "hint", field.hint ?? null);
      if (fresh) {
        const reason = option?.chosen?.state === "not-offered" ? option.chosen.reason : null;
        setAttr(element, "invalid", Boolean(reason));
        setAttr(element, "error", reason ? `Not offered: ${reason}` : null);
      }
      return;
    }
    const choice = choiceOf(input[field.name]);
    state.choice = choice;
    const models = optionIn(report, "model");
    const efforts = optionIn(report, "effort");
    for (const entry of efforts?.values ?? []) if (entry.value !== null) effortNames.set(entry.value, entry.name);
    const values = models?.values?.length ? models.values : [HOST_DEFAULT];
    drawOptions(state, [...values.map((entry) => `<prism-list-item value="${escapeHtml(entry.value ?? "")}">${escapeHtml(entry.name)}${entry.description ? `<span slot="detail">${escapeHtml(entry.description)}</span>` : ""}</prism-list-item>`),
      `<prism-list-item value="${OTHER}">Other model…<span slot="detail">A name this host takes, sent as written.</span></prism-list-item>`].join(""));
    setAttr(element, "value", pickerValue(choice));
    const listed = choice.model === null ? null : values.find((entry) => entry.value === choice.model);
    const modelName = choice.earlier ?? (choice.model === null ? "Host default" : listed?.name ?? choice.model);
    setAttr(element, "display", busy ? `Reading ${hostLabel}’s models…` : modelName);
    setAttr(element, "detail", busy || choice.earlier !== undefined ? null : choice.effort === null ? "Host default effort" : `${effortName(choice.effort)} effort`);
    setAttr(state.none, "hidden", !(models?.reportedNone));
    setText(state.none, `${hostLabel} reported no models.`);
    setText(state.effortHead, `Effort for ${choice.earlier === undefined ? modelName : "Host default"}`);
    drawEfforts(state, efforts?.values?.length ? efforts.values : [HOST_DEFAULT], choice.earlier === undefined ? choice.effort : null);
    if (!writable) setAttr(element, "hint", field.hint ?? null);
    if (choice.earlier !== undefined) {
      setAttr(element, "invalid", true);
      setAttr(element, "error", `Not offered: ${earlierReason(hostLabel, choice.earlier)}`);
      setAttr(element, "hint", field.hint ?? null);
    } else if (fresh || !writable) {
      const reason = [models, efforts].map((option) => option?.chosen).find((chosen) => chosen?.state === "not-offered")?.reason ?? null;
      setAttr(element, "invalid", Boolean(reason));
      setAttr(element, "error", reason ? `Not offered: ${reason}` : null);
      setAttr(element, "hint", models?.chosen?.state === "typed" ? models.chosen.reason : field.hint ?? null);
    } else if (choice.typed && !listed) setAttr(element, "hint", typedNote(hostLabel));
    else if (!element.hasAttribute("hint")) setAttr(element, "hint", field.hint ?? null);
  }

  function placed(fields, shown) {
    const wanted = fields.filter((field) => shown(pickers.get(field.name))).map((field) => pickers.get(field.name).element);
    for (const state of pickers.values()) if (!wanted.includes(state.element) && state.element.parentNode === section) state.element.remove();
    for (const [index, element] of wanted.entries()) {
      if (element.parentNode === section) continue;
      const after = wanted.slice(index + 1).find((other) => other.parentNode === section) ?? null;
      section.insertBefore(element, after);
    }
  }

  function update(next) {
    view = next;
    const { fields, input, host, writable } = next;
    const runFields = fields.filter(isRunField);
    for (const field of runFields) {
      const state = pickers.get(field.name) ?? create(field);
      state.field = field;
      setAttr(state.element, "data-wide", wide(field, runFields));
      const query = writable && host ? queryOf(field, input, host) : null;
      const key = query ? JSON.stringify(query) : null;
      if (key !== state.key) {
        state.key = key;
        const ticket = ++state.ticket;
        if (query) {
          void read(query).then((answer) => {
            if (ticket !== state.ticket) return;
            state.report = reportOf(answer, next.hostLabel);
            state.reportKey = key;
            state.reportHost = query.host;
            if (view) {
              draw(state, view);
              finish();
            }
          });
        }
      }
      draw(state, next);
    }
    finish();
  }

  // The pickers a host reports, and the reasons of the shown host's reports in the section's note.
  function finish() {
    if (!view) return;
    const runFields = view.fields.filter(isRunField);
    placed(runFields, (state) => state.field.kind === "run-choice" || Boolean(optionIn(state.reportHost === view.host ? state.report : null, state.field.option)));
    const reasons = [...new Set([...pickers.values()].filter((state) => state.reportHost === view.host && state.reportKey === state.key).map((state) => state.report?.reason).filter(Boolean))];
    setText(note, reasons.join(" "));
    note.hidden = !reasons.length;
  }

  return {
    section,
    update,
    /** Closes every open popover, and makes the next update read the host again while the pickers keep showing what they read. */
    reset() {
      for (const state of pickers.values()) {
        state.element.close?.();
        state.key = null;
        state.ticket += 1;
        if (state.name) {
          state.name.hidden = true;
          setAttr(state.name, "invalid", false);
        }
      }
    }
  };
}
