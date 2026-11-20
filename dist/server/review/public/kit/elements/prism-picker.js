// Generated from src/server/review/public/kit/elements/prism-picker.ts by scripts/native-build/compile.mjs.
import { Base, distribute, emit, make, setAttribute, toggleAttribute, uniqueId } from "./base.js";
const NOTHING = "Nothing matches.";
class PrismPicker extends Base {
  static tag = "prism-picker";
  static observedAttributes = ["label", "value", "display", "detail", "hint", "heading", "filter-label", "invalid", "error", "busy", "disabled"];
  static catalog = {
    purpose: "A field-like value control: one button shows the chosen value and a detail, and opens a popover with a filter, a list of options, and extra controls such as an effort.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The visible label above the button, which names it." },
      { name: "value", values: ["text"], default: "", description: "The chosen option's value; choosing an option sets it and selects only that option." },
      { name: "display", values: ["text"], default: "", description: "What the button shows for the chosen value, such as the model's name." },
      { name: "detail", values: ["text"], default: "", description: "Quieter text after the display in the button, such as the effort." },
      { name: "hint", values: ["text"], default: "", description: "Help text below the button." },
      { name: "heading", values: ["text"], default: "", description: "The popover's heading, which names it and its list." },
      { name: "filter-label", values: ["text"], default: "Filter", description: "The name and placeholder of the popover's filter field." },
      { name: "invalid", values: ["boolean"], default: "false", description: "Marks the value as wrong, exposed as aria-invalid on the button." },
      { name: "error", values: ["text"], default: "", description: "The message an invalid picker shows below the button in place of its hint." },
      { name: "busy", values: ["boolean"], default: "false", description: "The picker reads its options: the button shows a spinner and its display, is exposed as aria-busy, and opens nothing." },
      { name: "disabled", values: ["boolean"], default: "false", description: "The button takes no input and opens nothing." },
      { name: "prism-list-item", values: ["children"], default: "", description: "The options; a disabled one shows but cannot be chosen." },
      { name: 'slot="extra"', values: ["children"], default: "", description: "Controls below the options, such as an effort; with them the popover stays open after a choice." },
      { name: 'slot="empty"', values: ["children"], default: "", description: "What the popover shows when no option is listed or none matches the filter; without it the popover says Nothing matches." }
    ],
    states: ["default", "open", "filtered", "empty", "busy", "invalid", "disabled"],
    keyboard: [
      "A click, Enter, Space, or ArrowDown on the button opens the popover, and focus moves to its filter.",
      "Typing filters the options by their text; ArrowDown and ArrowUp move the active option, and Enter or a click chooses it and sends change with detail.value.",
      "Without extra controls a choice closes the popover and returns focus to the button; Escape or a click outside closes it."
    ]
  };
  constructor() {
    super();
    this.onTriggerKey = (event) => {
      if (event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      this.open();
    };
  }
  connectedCallback() {
    if (!this.button) this.build();
    this.sync();
    this.syncSelection();
  }
  attributeChangedCallback(name) {
    if (!this.button) return;
    if (name === "value") this.syncSelection();
    else this.sync();
  }
  build() {
    const id = uniqueId("prism-picker");
    this.labelElement = make(this, "span", "prism-picker-label", { id: `${id}-label` });
    this.button = make(this, "button", "prism-field-control prism-picker-button", { id: `${id}-button`, type: "button" });
    this.textElement = make(this, "span", "prism-picker-text", { id: `${id}-text` });
    this.displayElement = make(this, "span", "prism-picker-display");
    this.separator = make(this, "span", "prism-picker-separator", { "aria-hidden": "true" });
    this.separator.textContent = " \xB7 ";
    this.detailElement = make(this, "span", "prism-picker-detail");
    this.textElement.append(this.displayElement, this.separator, this.detailElement);
    setAttribute(this.button, "aria-labelledby", `${this.labelElement.id} ${this.textElement.id}`);
    this.chevron = make(this, "prism-icon", "prism-picker-chevron", { name: "chevron-down", size: "xs", "aria-hidden": "true" });
    this.button.append(this.textElement, this.chevron);
    this.hintElement = make(this, "p", "prism-picker-hint", { id: `${id}-hint` });
    this.errorElement = make(this, "p", "prism-picker-error", { id: `${id}-error` });
    this.panel = make(this, "prism-popover", "prism-picker-popover", { for: this.button.id });
    this.field = make(this, "prism-field", "prism-picker-filter", { id: `${id}-filter`, type: "search", variant: "filter" });
    this.field.append(make(this, "prism-icon", null, { slot: "start", name: "search", size: "sm" }));
    this.listbox = make(this, "prism-listbox", "prism-picker-options", { for: this.field.id });
    this.emptyElement = make(this, "div", "prism-picker-empty");
    this.nothing = make(this, "p", "prism-picker-nothing");
    this.nothing.textContent = NOTHING;
    this.emptyElement.append(this.nothing);
    this.extraElement = make(this, "div", "prism-picker-extra");
    this.panel.append(this.field, this.listbox, this.emptyElement, this.extraElement);
    this.holder = make(this, "div", "prism-picker-holder");
    this.regions = { default: this.holder, extra: this.extraElement, empty: this.emptyElement };
    const own = [this.labelElement, this.button, this.hintElement, this.errorElement, this.panel];
    this.append(...own);
    this.children$ = distribute(this, this.regions, own);
    this.button.addEventListener("keydown", this.onTriggerKey);
    this.button.addEventListener("click", () => this.render(), { capture: true });
    this.panel.addEventListener("prism-open", () => {
      this.field.value = "";
      this.filter();
    });
    this.field.addEventListener("input", (event) => {
      event.stopPropagation();
      this.filter();
    });
    this.field.addEventListener("change", (event) => event.stopPropagation());
    this.listbox.addEventListener("prism-select", (event) => {
      event.stopPropagation();
      this.choose(event.detail?.value ?? "");
    });
    this.watch = new MutationObserver(() => {
      this.syncSelection();
      this.filter();
    });
    this.watch.observe(this.holder, { childList: true });
    this.watch.observe(this.listbox, { childList: true });
    this.watch.observe(this.extraElement, { childList: true });
    this.watch.observe(this.emptyElement, { childList: true });
  }
  /** The option elements, in order, whether or not the filter shows them. */
  get items() {
    return [...(this.regions.default ?? this.listbox).querySelectorAll("prism-list-item")];
  }
  // Moves the waiting options into the list, once; options added later go straight to it.
  render() {
    if (this.regions.default === this.listbox) return;
    this.listbox.append(...this.holder.childNodes);
    this.regions.default = this.listbox;
    this.holder = null;
  }
  get value() {
    return this.getAttribute("value") ?? "";
  }
  set value(value) {
    setAttribute(this, "value", value ?? "");
  }
  get isOpen() {
    return Boolean(this.panel?.isOpen);
  }
  get blocked() {
    return this.hasAttribute("busy") || this.hasAttribute("disabled");
  }
  /** Opens the popover unless the picker is busy or disabled. */
  open() {
    if (this.blocked || !this.panel) return;
    this.render();
    this.panel.show();
  }
  /** Closes the popover, returning focus to the button when `focus` is set. */
  close({ focus = false } = {}) {
    this.panel?.close({ focus });
  }
  choose(value) {
    const option = this.items.find((item) => item.value === value);
    if (!option || option.hasAttribute("disabled")) return;
    this.value = value;
    this.syncSelection();
    emit(this, "change", { value });
    if (!this.hasExtra) this.close({ focus: true });
  }
  get hasExtra() {
    return [...this.extraElement.childNodes].some((node) => node.nodeType === 1 || node.textContent.trim());
  }
  // Keeps only the options whose text holds the filter's text, in any letter case, and shows the empty content when none is left.
  filter() {
    if (!this.field) return;
    const query = (this.field.value ?? "").trim().toLocaleLowerCase();
    let shown = 0;
    for (const item of this.items) {
      const text = (item.querySelector(".prism-list-label")?.textContent ?? item.textContent).replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const match = !query || text.includes(query);
      if (item.hidden === match) item.hidden = !match;
      if (match) shown += 1;
    }
    const authored = [...this.emptyElement.children].some((node) => node !== this.nothing);
    this.nothing.hidden = authored;
    this.emptyElement.hidden = shown > 0;
    this.extraElement.hidden = !this.hasExtra;
  }
  // Selects only the option whose value is the picker's value, and marks it with a check at its end.
  syncSelection() {
    if (!this.listbox) return;
    const items = this.items;
    if (this.hasAttribute("value")) {
      const value = this.value;
      for (const item of items) toggleAttribute(item, "selected", item.value === value);
    }
    for (const item of items) {
      const check = item.querySelector(":scope .prism-picker-check");
      if (item.hasAttribute("selected") && !check) item.append(make(this, "prism-icon", "prism-picker-check", { slot: "meta", name: "check", size: "xs", "aria-hidden": "true" }));
      else if (!item.hasAttribute("selected") && check) check.remove();
    }
  }
  sync() {
    const label = this.getAttribute("label") ?? "";
    const display = this.getAttribute("display") ?? "";
    const detail = this.getAttribute("detail") ?? "";
    const hint = this.getAttribute("hint") ?? "";
    const error = this.getAttribute("error") ?? "";
    const invalid = this.hasAttribute("invalid");
    const busy = this.hasAttribute("busy");
    this.labelElement.textContent = label;
    this.labelElement.hidden = !label;
    this.displayElement.textContent = display;
    this.detailElement.textContent = detail;
    this.detailElement.hidden = !detail;
    this.separator.hidden = !(display && detail);
    this.button.disabled = busy || this.hasAttribute("disabled");
    setAttribute(this.button, "aria-busy", busy ? "true" : null);
    setAttribute(this.button, "aria-invalid", invalid ? "true" : null);
    if (busy && !this.spinner) {
      this.spinner = make(this, "prism-spinner", "prism-picker-spinner", { "aria-hidden": "true" });
      this.button.prepend(this.spinner);
    } else if (!busy && this.spinner) {
      this.spinner.remove();
      this.spinner = null;
    }
    const showError = invalid && Boolean(error);
    this.errorElement.textContent = error;
    this.errorElement.hidden = !showError;
    this.hintElement.textContent = hint;
    this.hintElement.hidden = !hint || showError;
    const heading = this.getAttribute("heading") ?? "";
    setAttribute(this.panel, "heading", heading);
    setAttribute(this.listbox, "label", heading || label || null);
    const filterLabel = this.getAttribute("filter-label") || "Filter";
    setAttribute(this.field, "label", filterLabel);
    setAttribute(this.field, "placeholder", filterLabel);
    if (this.blocked && this.isOpen) this.close();
  }
}
export {
  PrismPicker
};
