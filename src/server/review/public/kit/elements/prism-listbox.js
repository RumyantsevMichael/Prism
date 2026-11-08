// prism-listbox: a list of prism-list-item options to choose one from. With `for` naming a kit field, focus stays in the field and the arrow keys move
// the active option through aria-activedescendant, as a command palette does; without it the listbox takes focus itself and the same keys apply.
import { Base, emit, setAttribute, toggleAttribute, uniqueId } from "./base.js";

export class PrismListbox extends Base {
  static tag = "prism-listbox";
  static observedAttributes = ["label", "for"];
  static catalog = {
    purpose: "A list of options to choose one from, driven by its own focus or by a kit field, such as the command palette's results.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The listbox's accessible name." },
      { name: "for", values: ["id"], default: "", description: "The id of a kit field whose control keeps focus and drives the active option; without it the listbox takes focus." }
    ],
    states: ["default", "active", "selected", "with-field"],
    keyboard: [
      "ArrowDown and ArrowUp move the active option, from the field named by for or from the focused listbox; Home and End move to the first and last option in a focused listbox.",
      "Enter, or a click, chooses the active option and sends prism-select with detail.value."
    ]
  };

  constructor() {
    super();
    this.onFieldKey = (event) => {
      if (event.target === this.control) this.onKey(event);
    };
    this.addEventListener("keydown", (event) => {
      if (!this.field) this.onKey(event);
    });
    this.addEventListener("click", (event) => {
      const option = event.composedPath().find((node) => node.tagName === "PRISM-LIST-ITEM");
      if (option && this.options.includes(option)) {
        this.activate(option);
        this.choose(option);
      }
    });
    // An active option that leaves the list, as results change, is no longer active.
    this.watch = new MutationObserver(() => {
      if (this.active && !this.options.includes(this.active)) this.activate(null);
    });
  }

  connectedCallback() {
    setAttribute(this, "role", "listbox");
    this.watch.observe(this, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    this.attributeChangedCallback();
    if (!this.field && this.hasAttribute("for")) requestAnimationFrame(() => this.bind());
  }

  disconnectedCallback() {
    this.watch.disconnect();
    this.unbind();
  }

  attributeChangedCallback() {
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
    if (this.isConnected) this.bind();
  }

  /** The visible options in order. */
  get options() {
    return [...this.querySelectorAll("prism-list-item")].filter((option) => option.closest("prism-listbox") === this && !option.closest("[hidden]"));
  }

  /** The native control of the field named by `for`, or null. */
  get control() {
    return this.field?.control ?? this.field?.querySelector("input, textarea") ?? null;
  }

  bind() {
    const id = this.getAttribute("for");
    const field = id ? this.getRootNode().getElementById?.(id) ?? this.ownerDocument.getElementById(id) : null;
    if (field !== this.field) {
      this.unbind();
      this.field = field;
      field?.addEventListener("keydown", this.onFieldKey);
    }
    setAttribute(this, "tabindex", this.field ? null : "0");
    if (this.field && !this.id) this.id = uniqueId("prism-listbox");
    if (this.control) {
      this.control.setAttribute("aria-controls", this.id);
      this.control.setAttribute("aria-autocomplete", "list");
    }
  }

  unbind() {
    this.field?.removeEventListener("keydown", this.onFieldKey);
    this.field = null;
  }

  /** Makes an option, or the option with that value, the active one, or clears the active option for null. */
  activate(target) {
    const option = typeof target === "string" ? this.options.find((item) => item.value === target) : target;
    this.active = option ?? null;
    for (const item of this.querySelectorAll("prism-list-item")) toggleAttribute(item, "active", item === this.active);
    const owner = this.field ? this.control : this;
    setAttribute(owner, "aria-activedescendant", this.active?.id ?? null);
    this.active?.scrollIntoView?.({ block: "nearest" });
  }

  /** Marks an option selected and sends prism-select with its value. */
  choose(option) {
    for (const item of this.querySelectorAll("prism-list-item")) item.selected = item === option;
    emit(this, "prism-select", { value: option.value });
  }

  onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const options = this.options;
    if (!options.length) return;
    const index = options.indexOf(this.active);
    let next = null;
    switch (event.key) {
      case "ArrowDown":
        next = options[index < 0 ? 0 : Math.min(index + 1, options.length - 1)];
        break;
      case "ArrowUp":
        next = options[index < 0 ? options.length - 1 : Math.max(index - 1, 0)];
        break;
      case "Home":
      case "End":
        // In a field, Home and End move the caret.
        if (this.field) return;
        next = event.key === "Home" ? options[0] : options.at(-1);
        break;
      case "Enter":
        if (!this.active) return;
        event.preventDefault();
        this.choose(this.active);
        return;
      default:
        return;
    }
    event.preventDefault();
    this.activate(next);
  }
}
