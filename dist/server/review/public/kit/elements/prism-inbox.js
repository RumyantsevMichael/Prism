// prism-inbox: a list of prism-inbox-item rows to pick one from, whose picked item a page shows beside the list, as a mail inbox does.
// The list takes one Tab stop and the selection follows the arrow keys, so the detail beside it changes as the person moves through the list.
import { Base, emit, setAttribute } from "./base.js";

export class PrismInbox extends Base {
  static tag = "prism-inbox";
  static observedAttributes = ["label"];
  static catalog = {
    purpose: "A list of items to pick one from, such as the questions that wait on a person, whose picked item the page shows beside the list; the arrow keys move the pick.",
    options: [
      { name: "label", values: ["text"], default: "", description: "The list's accessible name." }
    ],
    states: ["default", "selected", "unread"],
    keyboard: [
      "The list takes one Tab stop; ArrowDown, ArrowUp, Home, and End move the selection and send prism-select with detail.value.",
      "Enter, Space, or a click selects the item and sends prism-select."
    ]
  };

  constructor() {
    super();
    this.addEventListener("keydown", (event) => this.onKey(event));
    this.addEventListener("click", (event) => {
      const item = event.composedPath().find((node) => node.tagName === "PRISM-INBOX-ITEM");
      if (item && this.items.includes(item)) this.choose(item);
    });
  }

  connectedCallback() {
    setAttribute(this, "role", "listbox");
    setAttribute(this, "tabindex", "0");
    this.attributeChangedCallback();
    this.sync();
  }

  attributeChangedCallback() {
    setAttribute(this, "aria-label", this.getAttribute("label") || null);
  }

  /** The visible items in order. */
  get items() {
    return [...this.querySelectorAll("prism-inbox-item")].filter((item) => item.closest("prism-inbox") === this && !item.closest("[hidden]"));
  }

  /** The selected item, or null. */
  get selected() {
    return this.items.find((item) => item.selected) ?? null;
  }

  /** The selected item's value, or an empty string; setting it selects the item with that value without sending prism-select. */
  get value() {
    return this.selected?.value ?? "";
  }

  set value(value) {
    for (const item of this.querySelectorAll("prism-inbox-item")) item.selected = item.value === String(value);
    this.sync();
  }

  sync() {
    setAttribute(this, "aria-activedescendant", this.selected?.id ?? null);
  }

  /** Selects an item, shows it, and sends prism-select with its value. */
  choose(item) {
    for (const other of this.querySelectorAll("prism-inbox-item")) other.selected = other === item;
    this.sync();
    item.scrollIntoView?.({ block: "nearest" });
    emit(this, "prism-select", { value: item.value });
  }

  onKey(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.target !== this) return;
    const items = this.items;
    if (!items.length) return;
    const index = items.indexOf(this.selected);
    let next = null;
    switch (event.key) {
      case "ArrowDown":
        next = items[index < 0 ? 0 : Math.min(index + 1, items.length - 1)];
        break;
      case "ArrowUp":
        next = items[index < 0 ? items.length - 1 : Math.max(index - 1, 0)];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items.at(-1);
        break;
      case "Enter":
      case " ":
        next = items[Math.max(index, 0)];
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next) this.choose(next);
  }
}
